import { describe, expect, it, vi } from 'vitest'
import type { GroupChat, GroupRole, OpenTeamStore, OrchestrationFlow } from '../group/types'

type RuntimeMessage = { type: string; [key: string]: unknown }
type MessageSender = chrome.runtime.MessageSender

async function setupBackground(initialStore: OpenTeamStore) {
  vi.resetModules()
  const { STORE_KEY, loadStore } = await import('../group/store')
  const stored: Record<string, unknown> = { [STORE_KEY]: structuredClone(initialStore) }
  const listeners: Array<(message: RuntimeMessage, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean> = []
  const tabsSendMessage = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('chrome', {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn(listener => listeners.push(listener)) },
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
    },
    storage: {
      local: {
        get: vi.fn(async (key?: string | string[] | null) => {
          if (key === null || typeof key === 'undefined') return structuredClone(stored)
          if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, structuredClone(stored[item])]))
          return { [key]: structuredClone(stored[key]) }
        }),
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(stored, structuredClone(items))),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]
        }),
      },
    },
    tabs: { sendMessage: tabsSendMessage, create: vi.fn().mockResolvedValue({}), onRemoved: { addListener: vi.fn() } },
    action: { onClicked: { addListener: vi.fn() } },
  })
  await import('./index')
  expect(listeners).toHaveLength(1)
  return {
    tabsSendMessage,
    getStore: loadStore,
    invoke: (message: RuntimeMessage, sender = { tab: { id: 900 } as chrome.tabs.Tab, frameId: 0, url: 'https://gemini.google.com/app/test' }) => new Promise(resolve => listeners[0](message, sender, resolve)),
  }
}

describe('orchestration runtime', () => {
  it('runs role stages in order and completes when all parallel roles reply', async () => {
    const store = makeStore(['role-1', 'role-2'])
    store.orchestrationFlowsById['flow-1'] = makeFlow('chat-1', [
      { id: 'stage-1', kind: 'roles', name: 'Build', roleIds: ['role-1', 'role-2'] },
      { id: 'stage-2', kind: 'roles', name: 'Polish', roleIds: ['role-1'] },
    ])
    const harness = await setupBackground(store)
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-1' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 1, url: 'https://gemini.google.com/app/one' })
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-2' }, { tab: { id: 102 } as chrome.tabs.Tab, frameId: 2, url: 'https://gemini.google.com/app/two' })

    const started = await harness.invoke({ type: 'GROUP_ORCHESTRATION_RUN', chatId: 'chat-1', flowId: 'flow-1', task: 'Ship the plan' }) as { ok: boolean; run: { id: string } }

    expect(started.ok).toBe(true)
    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(2)
    const initialStore = await harness.getStore()
    const rolePromptMessage = latestUserMessage(initialStore, 'chat-1')
    expect(rolePromptMessage.content).toBe('Ship the plan')
    expect(rolePromptMessage.content).not.toContain('Round')
    expect(rolePromptMessage.content).not.toContain('Orchestration step')
    expect(rolePromptMessage.mentionedRoleIds).toEqual(['role-1', 'role-2'])
    expect(promptCalls(harness.tabsSendMessage)[0][1].content).not.toContain('Current round:')
    const firstPrompt = firstPromptMessageId(harness.tabsSendMessage)
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-1', messageId: firstPrompt, content: 'role one done' })
    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(2)
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-2', messageId: firstPrompt, content: 'role two done' })
    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(3)
    const secondPrompt = lastPromptMessageId(harness.tabsSendMessage)
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-1', messageId: secondPrompt, content: 'polished' })

    const finalStore = await harness.getStore()
    const run = finalStore.orchestrationRunsById[started.run.id]
    expect(run.status).toBe('completed')
    expect(finalStore.activeOrchestrationRunIdByChatId['chat-1']).toBeUndefined()
    expect(run.stageRuns.map(stageRun => stageRun.status)).toEqual(['completed', 'completed'])
  })

  it('starts fan-out stages in parallel after their shared source completes', async () => {
    const store = makeStore(['role-a', 'role-b', 'role-c'])
    store.orchestrationFlowsById['flow-1'] = {
      ...makeFlow('chat-1', [
        { id: 'stage-a', kind: 'roles', name: 'A', roleIds: ['role-a'] },
        { id: 'stage-b', kind: 'roles', name: 'B', roleIds: ['role-b'] },
        { id: 'stage-c', kind: 'roles', name: 'C', roleIds: ['role-c'] },
      ]),
      graph: {
        stageNodes: [
          { id: 'stage-a', kind: 'roles', name: 'A', roleIds: ['role-a'] },
          { id: 'stage-b', kind: 'roles', name: 'B', roleIds: ['role-b'] },
          { id: 'stage-c', kind: 'roles', name: 'C', roleIds: ['role-c'] },
        ],
        edges: [
          { sourceStageId: 'stage-a', targetStageId: 'stage-b' },
          { sourceStageId: 'stage-a', targetStageId: 'stage-c' },
        ],
      },
    }
    const harness = await setupBackground(store)
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-a' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 1, url: 'https://gemini.google.com/app/a' })
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-b' }, { tab: { id: 102 } as chrome.tabs.Tab, frameId: 2, url: 'https://gemini.google.com/app/b' })
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-c' }, { tab: { id: 103 } as chrome.tabs.Tab, frameId: 3, url: 'https://gemini.google.com/app/c' })

    const started = await harness.invoke({ type: 'GROUP_ORCHESTRATION_RUN', chatId: 'chat-1', flowId: 'flow-1', task: 'Ship the plan' }) as { ok: boolean; run: { id: string } }

    expect(started.ok).toBe(true)
    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(1)
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-a', messageId: firstPromptMessageId(harness.tabsSendMessage), content: 'a done' })
    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(3)

    const branchPrompts = promptCalls(harness.tabsSendMessage).slice(1)
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-b', messageId: branchPrompts[0][1].messageId, content: 'b done' })
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-c', messageId: branchPrompts[1][1].messageId, content: 'c done' })

    const finalStore = await harness.getStore()
    const run = finalStore.orchestrationRunsById[started.run.id]
    expect(run.status).toBe('completed')
    expect(run.stageRuns.map(stageRun => stageRun.stageId)).toEqual(['stage-a', 'stage-b', 'stage-c'])
  })

  it('runs role-only flows for every configured round', async () => {
    const store = makeStore(['role-1'])
    store.orchestrationFlowsById['flow-1'] = makeFlow('chat-1', [
      { id: 'stage-1', kind: 'roles', name: 'Build', roleIds: ['role-1'] },
    ], 2)
    const harness = await setupBackground(store)
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-1' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 1, url: 'https://gemini.google.com/app/one' })

    const started = await harness.invoke({ type: 'GROUP_ORCHESTRATION_RUN', chatId: 'chat-1', flowId: 'flow-1', task: 'Ship the plan' }) as { run: { id: string } }
    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(1)
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-1', messageId: firstPromptMessageId(harness.tabsSendMessage), content: 'round one' })

    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(2)
    const midStore = await harness.getStore()
    expect(midStore.orchestrationRunsById[started.run.id]).toMatchObject({ status: 'running', currentRound: 2, maxRounds: 2 })

    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-1', messageId: lastPromptMessageId(harness.tabsSendMessage), content: 'round two' })
    const finalStore = await harness.getStore()
    const run = finalStore.orchestrationRunsById[started.run.id]
    expect(run.status).toBe('completed')
    expect(run.stageRuns.map(stageRun => stageRun.round)).toEqual([1, 2])
  })

  it('stops after a review pass even when more rounds are allowed', async () => {
    const store = makeStore(['worker', 'reviewer'])
    store.orchestrationFlowsById['flow-1'] = makeFlow('chat-1', [
      { id: 'stage-1', kind: 'roles', name: 'Build', roleIds: ['worker'] },
      { id: 'review-1', kind: 'review', name: 'Review', roleIds: [], review: { reviewerRoleIds: ['reviewer'], instructions: 'Check output' } },
    ], 2)
    const harness = await setupBackground(store)
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'worker' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 1, url: 'https://gemini.google.com/app/one' })
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'reviewer' }, { tab: { id: 102 } as chrome.tabs.Tab, frameId: 2, url: 'https://gemini.google.com/app/two' })

    const started = await harness.invoke({ type: 'GROUP_ORCHESTRATION_RUN', chatId: 'chat-1', flowId: 'flow-1', task: 'Ship the plan' }) as { run: { id: string } }
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'worker', messageId: firstPromptMessageId(harness.tabsSendMessage), content: 'draft' })
    await harness.invoke({
      type: 'TEAM_ROLE_REPLY',
      chatId: 'chat-1',
      roleId: 'reviewer',
      messageId: lastPromptMessageId(harness.tabsSendMessage),
      content: '{"decision":"pass","reason":"Meets the acceptance criteria.","failedCriteria":[],"nextRoundInstruction":""}',
    })

    const finalStore = await harness.getStore()
    const run = finalStore.orchestrationRunsById[started.run.id]
    expect(run.status).toBe('completed')
    expect(run.currentRound).toBe(1)
    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(2)
  })

  it('continues from a review back edge instead of restarting at the root node', async () => {
    const store = makeStore(['role-a', 'role-b', 'reviewer'])
    const stages: OrchestrationFlow['stages'] = [
      { id: 'stage-a', kind: 'roles', name: 'A', roleIds: ['role-a'] },
      { id: 'stage-b', kind: 'roles', name: 'B', roleIds: ['role-b'] },
      { id: 'review-1', kind: 'review', name: 'Review', roleIds: ['reviewer'], review: { reviewerRoleIds: ['reviewer'], instructions: 'Check output' } },
    ]
    store.orchestrationFlowsById['flow-1'] = {
      ...makeFlow('chat-1', stages, 2),
      graph: {
        stageNodes: stages,
        edges: [
          { sourceStageId: 'stage-a', targetStageId: 'stage-b' },
          { sourceStageId: 'stage-b', targetStageId: 'review-1' },
          { sourceStageId: 'review-1', targetStageId: 'stage-b', sourcePort: 'continue' },
        ],
      },
    }
    const harness = await setupBackground(store)
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-a' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 1, url: 'https://gemini.google.com/app/a' })
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-b' }, { tab: { id: 102 } as chrome.tabs.Tab, frameId: 2, url: 'https://gemini.google.com/app/b' })
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'reviewer' }, { tab: { id: 103 } as chrome.tabs.Tab, frameId: 3, url: 'https://gemini.google.com/app/review' })

    const started = await harness.invoke({ type: 'GROUP_ORCHESTRATION_RUN', chatId: 'chat-1', flowId: 'flow-1', task: 'Ship the plan' }) as { run: { id: string } }
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-a', messageId: lastPromptMessageId(harness.tabsSendMessage), content: 'a done' })
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-b', messageId: lastPromptMessageId(harness.tabsSendMessage), content: 'b draft' })
    await harness.invoke({
      type: 'TEAM_ROLE_REPLY',
      chatId: 'chat-1',
      roleId: 'reviewer',
      messageId: lastPromptMessageId(harness.tabsSendMessage),
      content: '{"decision":"continue","reason":"B needs revision.","failedCriteria":["detail"],"nextRoundInstruction":"Revise B only."}',
    })

    const calls = promptCalls(harness.tabsSendMessage)
    expect(calls).toHaveLength(4)
    expect(calls[3][0]).toBe(102)
    const midStore = await harness.getStore()
    const run = midStore.orchestrationRunsById[started.run.id]
    expect(run.currentRound).toBe(2)
    expect(run.stageRuns.map(stageRun => `${stageRun.round}:${stageRun.stageId}`)).toEqual(['1:stage-a', '1:stage-b', '1:review-1', '2:stage-b'])
  })

  it('does not start a review pass target before the review decision even when legacy review edges have no source port', async () => {
    const store = makeStore(['role-a', 'role-b', 'reviewer', 'role-final'])
    const stages: OrchestrationFlow['stages'] = [
      { id: 'stage-a', kind: 'roles', name: 'A', roleIds: ['role-a'] },
      { id: 'stage-b', kind: 'roles', name: 'B', roleIds: ['role-b'] },
      { id: 'stage-final', kind: 'roles', name: 'Final', roleIds: ['role-final'] },
      { id: 'review-1', kind: 'review', name: 'Review', roleIds: ['reviewer'], review: { reviewerRoleIds: ['reviewer'], instructions: 'Check output' } },
    ]
    store.orchestrationFlowsById['flow-1'] = {
      ...makeFlow('chat-1', stages, 2),
      graph: {
        stageNodes: stages,
        edges: [
          { sourceStageId: 'stage-a', targetStageId: 'stage-b' },
          { sourceStageId: 'stage-b', targetStageId: 'review-1' },
          { sourceStageId: 'review-1', targetStageId: 'stage-final' },
          { sourceStageId: 'review-1', targetStageId: 'stage-a', sourcePort: 'continue' },
        ],
      },
    }
    const harness = await setupBackground(store)
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-a' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 1, url: 'https://gemini.google.com/app/a' })
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-b' }, { tab: { id: 102 } as chrome.tabs.Tab, frameId: 2, url: 'https://gemini.google.com/app/b' })
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'reviewer' }, { tab: { id: 103 } as chrome.tabs.Tab, frameId: 3, url: 'https://gemini.google.com/app/review' })
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-final' }, { tab: { id: 104 } as chrome.tabs.Tab, frameId: 4, url: 'https://gemini.google.com/app/final' })

    const started = await harness.invoke({ type: 'GROUP_ORCHESTRATION_RUN', chatId: 'chat-1', flowId: 'flow-1', task: 'Ship the plan' }) as { run: { id: string } }

    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(1)
    expect(promptCalls(harness.tabsSendMessage)[0][0]).toBe(101)
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-a', messageId: lastPromptMessageId(harness.tabsSendMessage), content: 'a done' })
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-b', messageId: lastPromptMessageId(harness.tabsSendMessage), content: 'b done' })
    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(3)
    expect(promptCalls(harness.tabsSendMessage)[2][0]).toBe(103)
    expect(promptCalls(harness.tabsSendMessage)[2][1].content).not.toContain('a done')
    expect(promptCalls(harness.tabsSendMessage)[2][1].content).not.toContain('b done')

    await harness.invoke({
      type: 'TEAM_ROLE_REPLY',
      chatId: 'chat-1',
      roleId: 'reviewer',
      messageId: lastPromptMessageId(harness.tabsSendMessage),
      content: '{"decision":"pass","reason":"Good.","failedCriteria":[],"nextRoundInstruction":""}',
    })

    const calls = promptCalls(harness.tabsSendMessage)
    expect(calls).toHaveLength(4)
    expect(calls[3][0]).toBe(104)
    const finalStore = await harness.getStore()
    const run = finalStore.orchestrationRunsById[started.run.id]
    expect(run.stageRuns.map(stageRun => stageRun.stageId)).toEqual(['stage-a', 'stage-b', 'review-1', 'stage-final'])
  })

  it('retries a failed middle node without rerunning completed previous nodes', async () => {
    const store = makeStore(['role-a', 'role-b', 'role-c'])
    store.orchestrationFlowsById['flow-1'] = makeFlow('chat-1', [
      { id: 'stage-a', kind: 'roles', name: 'A', roleIds: ['role-a'] },
      { id: 'stage-b', kind: 'roles', name: 'B', roleIds: ['role-b'] },
      { id: 'stage-c', kind: 'roles', name: 'C', roleIds: ['role-c'] },
    ])
    const harness = await setupBackground(store)
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-a' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 1, url: 'https://gemini.google.com/app/a' })
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-b' }, { tab: { id: 102 } as chrome.tabs.Tab, frameId: 2, url: 'https://gemini.google.com/app/b' })
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-c' }, { tab: { id: 103 } as chrome.tabs.Tab, frameId: 3, url: 'https://gemini.google.com/app/c' })

    const started = await harness.invoke({ type: 'GROUP_ORCHESTRATION_RUN', chatId: 'chat-1', flowId: 'flow-1', task: 'Ship the plan' }) as { run: { id: string } }
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-a', messageId: lastPromptMessageId(harness.tabsSendMessage), content: 'a done' })
    await harness.invoke({ type: 'TEAM_ROLE_ERROR', chatId: 'chat-1', roleId: 'role-b', messageId: lastPromptMessageId(harness.tabsSendMessage), reason: 'send failed' })

    const erroredStore = await harness.getStore()
    expect(erroredStore.orchestrationRunsById[started.run.id].stageRuns.map(stageRun => `${stageRun.status}:${stageRun.stageId}`)).toEqual(['completed:stage-a', 'error:stage-b'])

    await harness.invoke({ type: 'GROUP_ORCHESTRATION_RETRY_STAGE', chatId: 'chat-1', stageId: 'stage-b' })

    const calls = promptCalls(harness.tabsSendMessage)
    expect(calls).toHaveLength(3)
    expect(calls[0][0]).toBe(101)
    expect(calls[1][0]).toBe(102)
    expect(calls[2][0]).toBe(102)
    const retriedStore = await harness.getStore()
    expect(retriedStore.orchestrationRunsById[started.run.id].stageRuns.map(stageRun => `${stageRun.status}:${stageRun.stageId}`)).toEqual(['completed:stage-a', 'running:stage-b'])
  })

  it('keeps invalid review JSON in error until retry or stop', async () => {
    const store = makeStore(['worker', 'reviewer'])
    store.orchestrationFlowsById['flow-1'] = makeFlow('chat-1', [
      { id: 'stage-1', kind: 'roles', name: 'Build', roleIds: ['worker'] },
      { id: 'review-1', kind: 'review', name: 'Review', roleIds: [], review: { reviewerRoleIds: ['reviewer'], instructions: 'Check output' } },
    ], 2)
    const harness = await setupBackground(store)
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'worker' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 1, url: 'https://gemini.google.com/app/one' })
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'reviewer' }, { tab: { id: 102 } as chrome.tabs.Tab, frameId: 2, url: 'https://gemini.google.com/app/two' })
    const started = await harness.invoke({ type: 'GROUP_ORCHESTRATION_RUN', chatId: 'chat-1', flowId: 'flow-1', task: 'Ship the plan' }) as { run: { id: string } }
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'worker', messageId: firstPromptMessageId(harness.tabsSendMessage), content: 'draft' })
    const reviewPrompt = lastPromptMessageId(harness.tabsSendMessage)

    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'reviewer', messageId: reviewPrompt, content: 'not json' })

    const erroredStore = await harness.getStore()
    expect(erroredStore.orchestrationRunsById[started.run.id].status).toBe('error')
    expect(erroredStore.activeOrchestrationRunIdByChatId['chat-1']).toBe(started.run.id)
    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(2)
  })

  it('allows starting a new run after the previous active run errored', async () => {
    const store = makeStore(['role-1'])
    store.orchestrationFlowsById['flow-1'] = makeFlow('chat-1', [{ id: 'stage-1', kind: 'roles', name: 'Build', roleIds: ['role-1'] }])
    store.orchestrationRunsById['run-old'] = {
      id: 'run-old',
      chatId: 'chat-1',
      flowId: 'flow-1',
      status: 'error',
      currentRound: 1,
      maxRounds: 1,
      stageRuns: [],
      error: '人员 iframe 尚未就绪',
      createdAt: 1,
      updatedAt: 2,
    }
    store.activeOrchestrationRunIdByChatId['chat-1'] = 'run-old'
    const harness = await setupBackground(store)
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-1' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 1, url: 'https://gemini.google.com/app/one' })

    const started = await harness.invoke({ type: 'GROUP_ORCHESTRATION_RUN', chatId: 'chat-1', flowId: 'flow-1', task: 'Ship the plan again' }) as { ok: boolean; run: { id: string } }

    expect(started.ok).toBe(true)
    const finalStore = await harness.getStore()
    expect(finalStore.orchestrationRunsById['run-old'].status).toBe('error')
    expect(finalStore.activeOrchestrationRunIdByChatId['chat-1']).toBe(started.run.id)
    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(1)
  })

  it('clears a stale running run with no live role prompt before starting a new run', async () => {
    const store = makeStore(['role-1'])
    store.rolesById['role-1'].status = 'ready'
    store.orchestrationFlowsById['flow-1'] = makeFlow('chat-1', [{ id: 'stage-1', kind: 'roles', name: 'Build', roleIds: ['role-1'] }])
    store.orchestrationRunsById['run-stale'] = {
      id: 'run-stale',
      chatId: 'chat-1',
      flowId: 'flow-1',
      status: 'running',
      currentRound: 1,
      maxRounds: 1,
      stageRuns: [{
        stageId: 'stage-old',
        stageIndex: 0,
        kind: 'roles',
        round: 1,
        status: 'running',
        roleRuns: { 'role-1': { roleId: 'role-1', status: 'running', messageId: 'msg-old', startedAt: 1 } },
        startedAt: 1,
      }],
      createdAt: 1,
      updatedAt: 2,
    }
    store.activeOrchestrationRunIdByChatId['chat-1'] = 'run-stale'
    const harness = await setupBackground(store)
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-1' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 1, url: 'https://gemini.google.com/app/one' })

    const started = await harness.invoke({ type: 'GROUP_ORCHESTRATION_RUN', chatId: 'chat-1', flowId: 'flow-1', task: 'Ship the plan again' }) as { ok: boolean; run: { id: string } }

    expect(started.ok).toBe(true)
    const finalStore = await harness.getStore()
    expect(finalStore.orchestrationRunsById['run-stale'].status).toBe('stopped')
    expect(finalStore.activeOrchestrationRunIdByChatId['chat-1']).toBe(started.run.id)
    expect(promptCalls(harness.tabsSendMessage)).toHaveLength(1)
  })

  it('stops active runs and ignores late replies', async () => {
    const store = makeStore(['role-1'])
    store.orchestrationFlowsById['flow-1'] = makeFlow('chat-1', [{ id: 'stage-1', kind: 'roles', name: 'Build', roleIds: ['role-1'] }])
    const harness = await setupBackground(store)
    await harness.invoke({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'chat-1', roleId: 'role-1' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 1, url: 'https://gemini.google.com/app/one' })
    const started = await harness.invoke({ type: 'GROUP_ORCHESTRATION_RUN', chatId: 'chat-1', flowId: 'flow-1', task: 'Ship the plan' }) as { run: { id: string } }
    const promptMessageId = firstPromptMessageId(harness.tabsSendMessage)

    await harness.invoke({ type: 'GROUP_ORCHESTRATION_STOP', chatId: 'chat-1' })
    await harness.invoke({ type: 'TEAM_ROLE_REPLY', chatId: 'chat-1', roleId: 'role-1', messageId: promptMessageId, content: 'late' })

    const finalStore = await harness.getStore()
    expect(finalStore.orchestrationRunsById[started.run.id].status).toBe('stopped')
    expect(finalStore.activeOrchestrationRunIdByChatId['chat-1']).toBeUndefined()
  })
})

type PromptCall = [number, { type?: string; messageId: string; content: string }, { frameId: number }]

function promptCalls(mock: ReturnType<typeof vi.fn>): PromptCall[] {
  return mock.mock.calls.filter(call => call[1]?.type === 'TEAM_SEND_PROMPT') as PromptCall[]
}

function firstPromptMessageId(mock: ReturnType<typeof vi.fn>): string {
  return promptCalls(mock)[0][1].messageId
}

function lastPromptMessageId(mock: ReturnType<typeof vi.fn>): string {
  const calls = promptCalls(mock)
  return calls[calls.length - 1][1].messageId
}

function latestUserMessage(store: OpenTeamStore, chatId: string) {
  const chat = store.chatsById[chatId]
  const messages = chat.messageIds.map(messageId => store.messagesById[messageId])
  const message = [...messages].reverse().find(item => item?.type === 'user')
  if (!message) throw new Error('Expected a user message')
  return message
}

function makeStore(roleIds: string[]): OpenTeamStore {
  return {
    version: 5,
    chatOrder: ['chat-1'],
    chatsById: { 'chat-1': makeChat('chat-1', roleIds) },
    rolesById: Object.fromEntries(roleIds.map(roleId => [roleId, makeRole('chat-1', roleId)])),
    messagesById: {},
    roleTemplateOrder: [],
    roleTemplatesById: {},
    orchestrationFlowsById: {},
    orchestrationFlowOrderByChatId: { 'chat-1': ['flow-1'] },
    orchestrationRunsById: {},
    activeOrchestrationRunIdByChatId: {},
    settings: { defaultMode: 'independent', maxContextChars: 6000, defaultChatSite: 'gemini', externalModelOrder: [], externalModelsById: {} },
  }
}

function makeChat(id: string, roleIds: string[]): GroupChat {
  return { id, name: id, mode: 'independent', roleIds, messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
}

function makeRole(chatId: string, id: string): GroupRole {
  return { id, chatId, name: id, status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
}

function makeFlow(chatId: string, stages: OrchestrationFlow['stages'], maxRounds = 1): OrchestrationFlow {
  return { id: 'flow-1', chatId, name: 'Flow', stages, maxRounds, createdAt: 1, updatedAt: 1 }
}
