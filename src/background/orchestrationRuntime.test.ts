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

function promptCalls(mock: ReturnType<typeof vi.fn>): Array<[number, { type?: string; messageId: string }, { frameId: number }]> {
  return mock.mock.calls.filter(call => call[1]?.type === 'TEAM_SEND_PROMPT') as Array<[number, { type?: string; messageId: string }, { frameId: number }]>
}

function firstPromptMessageId(mock: ReturnType<typeof vi.fn>): string {
  return promptCalls(mock)[0][1].messageId
}

function lastPromptMessageId(mock: ReturnType<typeof vi.fn>): string {
  const calls = promptCalls(mock)
  return calls[calls.length - 1][1].messageId
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
