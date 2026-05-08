// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupChat, GroupRole, OpenTeamStore, OrchestrationFlow } from '../group/types'
import { createOrchestrationModalView, orderStagesByGraph } from './orchestrationModalView'

class MockGraph {
  static instances: MockGraph[] = []
  nodes: Array<{ id?: string; data?: Record<string, unknown> }> = []
  handlers = new Map<string, Array<(args: { node?: { getData(): Record<string, unknown> } }) => void>>()

  static latest(): MockGraph {
    const graph = MockGraph.instances[MockGraph.instances.length - 1]
    if (!graph) throw new Error('MockGraph was not mounted')
    return graph
  }

  constructor(public options: Record<string, unknown>) {
    MockGraph.instances.push(this)
  }
  clearCells(): void { this.nodes = [] }
  addNode(node: unknown): unknown {
    this.nodes.push(node as { id?: string; data?: Record<string, unknown> })
    return node
  }
  addEdge(edge: unknown): unknown { return edge }
  on(eventName: string, handler: (args: { node?: { getData(): Record<string, unknown> } }) => void): void {
    this.handlers.set(eventName, [...this.handlers.get(eventName) ?? [], handler])
  }
  selectNode(stageId: string): void {
    for (const handler of this.handlers.get('node:click') ?? []) handler({ node: { getData: () => ({ stageId }) } })
  }
  dispose(): void {}
}

interface Harness {
  refs: {
    openOrchestrationEl: HTMLButtonElement
    orchestrationModalEl: HTMLElement
    closeOrchestrationEl: HTMLButtonElement
    orchestrationTaskEl: HTMLTextAreaElement
    orchestrationPeopleListEl: HTMLElement
    orchestrationCanvasEl: HTMLElement
    orchestrationHintEl: HTMLElement
    orchestrationStageSettingsEl: HTMLElement
    orchestrationReviewSettingsEl: HTMLElement
    orchestrationMaxRoundsEl: HTMLInputElement
    saveOrchestrationEl: HTMLButtonElement
    runOrchestrationEl: HTMLButtonElement
  }
  store: OpenTeamStore
  runCommand: Mock<[string, Record<string, unknown>?], Promise<void>>
  reconnectRolesForSend: Mock<[GroupChat, GroupRole[]], Promise<void>>
  errors: string[]
  successes: string[]
}

function createHarness(): Harness {
  document.body.innerHTML = `
    <button id="open-orchestration"></button>
    <div id="orchestration-modal" hidden>
      <button id="close-orchestration"></button>
      <textarea id="orchestration-task"></textarea>
      <div id="orchestration-people-list"></div>
      <div id="orchestration-stage-canvas"></div>
      <p id="orchestration-empty-hint"></p>
      <div class="orchestration-layout">
        <aside class="orchestration-settings">
          <div id="orchestration-stage-settings"></div>
          <div id="orchestration-review-settings"></div>
        </aside>
      </div>
      <input id="orchestration-max-rounds" />
      <button id="save-orchestration"></button>
      <button id="run-orchestration"></button>
    </div>
  `
  const store = createDefaultStore()
  const chat: GroupChat = { id: 'chat-1', name: '测试群聊', mode: 'collaborative', roleIds: ['role-1', 'role-2'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
  const roleOne: GroupRole = { id: 'role-1', chatId: 'chat-1', name: '产品', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
  const roleTwo: GroupRole = { id: 'role-2', chatId: 'chat-1', name: '评审', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
  store.currentChatId = chat.id
  store.chatOrder = [chat.id]
  store.chatsById[chat.id] = chat
  store.rolesById[roleOne.id] = roleOne
  store.rolesById[roleTwo.id] = roleTwo
  return {
    refs: {
      openOrchestrationEl: document.querySelector('#open-orchestration') as HTMLButtonElement,
      orchestrationModalEl: document.querySelector('#orchestration-modal') as HTMLElement,
      closeOrchestrationEl: document.querySelector('#close-orchestration') as HTMLButtonElement,
      orchestrationTaskEl: document.querySelector('#orchestration-task') as HTMLTextAreaElement,
      orchestrationPeopleListEl: document.querySelector('#orchestration-people-list') as HTMLElement,
      orchestrationCanvasEl: document.querySelector('#orchestration-stage-canvas') as HTMLElement,
      orchestrationHintEl: document.querySelector('#orchestration-empty-hint') as HTMLElement,
      orchestrationStageSettingsEl: document.querySelector('#orchestration-stage-settings') as HTMLElement,
      orchestrationReviewSettingsEl: document.querySelector('#orchestration-review-settings') as HTMLElement,
      orchestrationMaxRoundsEl: document.querySelector('#orchestration-max-rounds') as HTMLInputElement,
      saveOrchestrationEl: document.querySelector('#save-orchestration') as HTMLButtonElement,
      runOrchestrationEl: document.querySelector('#run-orchestration') as HTMLButtonElement,
    },
    store,
    runCommand: vi.fn<[string, Record<string, unknown>?], Promise<void>>(async () => undefined),
    reconnectRolesForSend: vi.fn<[GroupChat, GroupRole[]], Promise<void>>(async () => undefined),
    errors: [],
    successes: [],
  }
}

function createView(harness: Harness): ReturnType<typeof createOrchestrationModalView> {
  return createOrchestrationModalView({
    ...harness.refs,
    getStore: () => harness.store,
    getCurrentChat: () => harness.store.currentChatId ? harness.store.chatsById[harness.store.currentChatId] : undefined,
    getCurrentRoles: () => harness.store.currentChatId ? harness.store.chatsById[harness.store.currentChatId].roleIds.map(roleId => harness.store.rolesById[roleId]) : [],
    reconnectRolesForSend: harness.reconnectRolesForSend,
    runCommand: harness.runCommand,
    showError: message => harness.errors.push(message),
    showSuccess: message => harness.successes.push(message),
    loadX6: async () => ({ Graph: MockGraph }),
  })
}

describe('orchestration modal view', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    MockGraph.instances = []
  })

  it('opens with drag-only people cards and creates one single-role node per drop', async () => {
    const harness = createHarness()
    const view = createView(harness)
    view.registerOrchestrationEvents()

    harness.refs.openOrchestrationEl.click()

    expect(harness.refs.orchestrationModalEl.hidden).toBe(false)
    expect(harness.refs.orchestrationHintEl.hidden).toBe(false)
    expect(harness.refs.orchestrationMaxRoundsEl.value).toBe('1')
    expect(harness.refs.orchestrationPeopleListEl.textContent).not.toContain('新阶段')
    expect(harness.refs.orchestrationPeopleListEl.textContent).not.toContain('并行加入')
    expect(harness.refs.orchestrationPeopleListEl.textContent).not.toContain('设为审核')

    dropRole(harness, 'role-1')
    dropRole(harness, 'role-2')
    harness.refs.orchestrationTaskEl.value = '完成方案评审'
    harness.refs.runOrchestrationEl.click()
    await flushAsync()

    const runPayload = harness.runCommand.mock.calls.find(call => call[0] === 'GROUP_ORCHESTRATION_RUN')?.[1] as { flow?: OrchestrationFlow }
    expect(runPayload.flow?.stages.map(stage => stage.roleIds)).toEqual([['role-1'], ['role-2']])
    expect(runPayload.flow?.graph?.edges).toEqual([])
  })

  it('opens a blank draft by default when the chat has no saved orchestration flow', () => {
    const harness = createHarness()
    const view = createView(harness)
    view.registerOrchestrationEvents()

    harness.refs.openOrchestrationEl.click()

    expect(harness.refs.orchestrationHintEl.hidden).toBe(false)
    expect(harness.refs.orchestrationStageSettingsEl.textContent).toBe('')
    expect(harness.refs.orchestrationStageSettingsEl.closest<HTMLElement>('.orchestration-settings')?.hidden).toBe(true)
  })

  it('shows stage settings only after the user selects a canvas node', async () => {
    const harness = createHarness()
    const view = createView(harness)
    view.registerOrchestrationEvents()

    harness.refs.openOrchestrationEl.click()
    await flushAsync()
    dropRole(harness, 'role-1')

    expect(harness.refs.orchestrationStageSettingsEl.textContent).toBe('')
    expect(harness.refs.orchestrationStageSettingsEl.closest<HTMLElement>('.orchestration-settings')?.hidden).toBe(true)

    const stageId = MockGraph.latest().nodes[0].id
    expect(stageId).toBeTruthy()
    MockGraph.latest().selectNode(stageId as string)

    expect(harness.refs.orchestrationStageSettingsEl.textContent).toContain('阶段名称')
    expect(harness.refs.orchestrationStageSettingsEl.closest<HTMLElement>('.orchestration-settings')?.hidden).toBe(false)
  })

  it('restores a saved orchestration flow for the current chat after refresh', async () => {
    const harness = createHarness()
    const savedFlow: OrchestrationFlow = {
      id: 'flow-saved',
      chatId: 'chat-1',
      name: '已保存流程',
      description: '保存过的任务',
      stages: [
        { id: 'stage-saved-1', kind: 'roles', name: '旧阶段 1', roleIds: ['role-1'] },
        { id: 'stage-saved-2', kind: 'roles', name: '旧阶段 2', roleIds: ['role-2'] },
      ],
      graph: {
        stageNodes: [
          { id: 'stage-saved-1', kind: 'roles', name: '旧阶段 1', roleIds: ['role-1'] },
          { id: 'stage-saved-2', kind: 'roles', name: '旧阶段 2', roleIds: ['role-2'] },
        ],
        edges: [{ sourceStageId: 'stage-saved-1', targetStageId: 'stage-saved-2' }],
      },
      maxRounds: 3,
      createdAt: 1,
      updatedAt: 1,
    }
    harness.store.orchestrationFlowsById[savedFlow.id] = savedFlow
    harness.store.orchestrationFlowOrderByChatId['chat-1'] = [savedFlow.id]
    const view = createView(harness)
    view.registerOrchestrationEvents()

    harness.refs.openOrchestrationEl.click()
    await flushAsync()

    expect(harness.refs.orchestrationHintEl.hidden).toBe(true)
    expect(harness.refs.orchestrationStageSettingsEl.querySelector('input')).toBeNull()
    MockGraph.latest().selectNode('stage-saved-1')
    expect((harness.refs.orchestrationStageSettingsEl.querySelector('input') as HTMLInputElement).value).toBe('旧阶段 1')
    expect(harness.refs.orchestrationMaxRoundsEl.value).toBe('3')
    expect(harness.refs.orchestrationTaskEl.value).toBe('保存过的任务')
    harness.refs.orchestrationTaskEl.value = '继续执行'
    harness.refs.runOrchestrationEl.click()
    await flushAsync()

    const runPayload = harness.runCommand.mock.calls.find(call => call[0] === 'GROUP_ORCHESTRATION_RUN')?.[1] as { flow?: OrchestrationFlow }
    expect(runPayload.flow?.id).toBe('flow-saved')
    expect(runPayload.flow?.graph?.edges).toEqual([{ sourceStageId: 'stage-saved-1', targetStageId: 'stage-saved-2' }])
  })

  it('validates max rounds and saves a stage draft through GROUP_ORCHESTRATION_FLOW_SAVE', async () => {
    const harness = createHarness()
    const view = createView(harness)
    view.registerOrchestrationEvents()
    harness.refs.openOrchestrationEl.click()
    dropRole(harness, 'role-1')
    harness.refs.orchestrationTaskEl.value = '保存这次任务'
    harness.refs.orchestrationMaxRoundsEl.value = '51'

    harness.refs.saveOrchestrationEl.click()
    await Promise.resolve()

    expect(harness.errors).toContain('最大轮数需在 1-50 之间')
    harness.refs.orchestrationMaxRoundsEl.value = '2'
    harness.refs.saveOrchestrationEl.click()
    await Promise.resolve()

    expect(harness.runCommand).toHaveBeenCalledWith('GROUP_ORCHESTRATION_FLOW_SAVE', expect.objectContaining({ chatId: 'chat-1', flow: expect.objectContaining({ description: '保存这次任务', maxRounds: 2 }) }))
  })

  it('validates run task and review settings before GROUP_ORCHESTRATION_RUN', async () => {
    const harness = createHarness()
    const view = createView(harness)
    view.registerOrchestrationEvents()
    harness.refs.openOrchestrationEl.click()
    dropRole(harness, 'role-2')
    await flushAsync()
    MockGraph.latest().selectNode(MockGraph.latest().nodes[0].id as string)
    const typeSelect = harness.refs.orchestrationStageSettingsEl.querySelector('select[data-stage-kind]') as HTMLSelectElement
    typeSelect.value = 'review'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))

    harness.refs.runOrchestrationEl.click()
    await Promise.resolve()
    expect(harness.errors).toContain('请输入编排任务')

    harness.refs.orchestrationTaskEl.value = '完成方案评审'
    harness.refs.runOrchestrationEl.click()
    await Promise.resolve()
    expect(harness.errors).toContain('审核阶段需要审核人员和审核标准')

    const criteria = harness.refs.orchestrationReviewSettingsEl.querySelector('textarea') as HTMLTextAreaElement
    criteria.value = '必须包含结论'
    criteria.dispatchEvent(new Event('input', { bubbles: true }))
    harness.refs.runOrchestrationEl.click()
    await flushAsync()

    expect(harness.runCommand).toHaveBeenCalledWith('GROUP_ORCHESTRATION_RUN', expect.objectContaining({ chatId: 'chat-1', task: '完成方案评审', flow: expect.any(Object) }))
  })

  it('recovers stage roles before running an orchestration', async () => {
    const harness = createHarness()
    const view = createView(harness)
    view.registerOrchestrationEvents()
    harness.refs.openOrchestrationEl.click()
    dropRole(harness, 'role-1')
    dropRole(harness, 'role-2')
    harness.refs.orchestrationTaskEl.value = '完成方案评审'

    harness.refs.runOrchestrationEl.click()
    await flushAsync()

    expect(harness.reconnectRolesForSend).toHaveBeenCalledWith(harness.store.chatsById['chat-1'], [harness.store.rolesById['role-1'], harness.store.rolesById['role-2']])
    expect(harness.runCommand.mock.invocationCallOrder[0]).toBeGreaterThan(harness.reconnectRolesForSend.mock.invocationCallOrder[0])
  })

  it('orders stages by graph edges when saving the draft', () => {
    const unorderedStages = [
      { id: 'stage-2', kind: 'roles' as const, name: '工程判断', roleIds: ['role-2'] },
      { id: 'stage-1', kind: 'roles' as const, name: '产品需求', roleIds: ['role-1'] },
      { id: 'review-1', kind: 'review' as const, name: '审核', roleIds: ['role-3'], review: { reviewerRoleIds: ['role-3'] } },
    ]

    const ordered = orderStagesByGraph(unorderedStages, [
      { sourceStageId: 'stage-1', targetStageId: 'stage-2' },
      { sourceStageId: 'stage-2', targetStageId: 'review-1' },
    ])

    expect(ordered.map(stage => stage.id)).toEqual(['stage-1', 'stage-2', 'review-1'])
  })

  it('drops roles as independent nodes and leaves connection decisions to the user', async () => {
    const harness = createHarness()
    const view = createView(harness)
    view.registerOrchestrationEvents()
    harness.refs.openOrchestrationEl.click()
    dropRole(harness, 'role-1')
    dropRole(harness, 'role-2')

    harness.refs.orchestrationTaskEl.value = '完成方案评审'
    harness.refs.runOrchestrationEl.click()
    await flushAsync()

    const runPayload = harness.runCommand.mock.calls.find(call => call[0] === 'GROUP_ORCHESTRATION_RUN')?.[1] as { flow?: { stages: Array<{ id: string; roleIds: string[] }>; graph?: { edges: Array<{ sourceStageId: string; targetStageId: string }> } } }
    expect(runPayload.flow?.stages.map(stage => stage.roleIds)).toEqual([['role-1'], ['role-2']])
    expect(runPayload.flow?.graph?.edges).toEqual([])
  })
})

function dropRole(harness: Harness, roleId: string): void {
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => roleId, types: ['application/x-openteam-role-id'] } })
  harness.refs.orchestrationCanvasEl.dispatchEvent(drop)
}

function flushAsync(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}
