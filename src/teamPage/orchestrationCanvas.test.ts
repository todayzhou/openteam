// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationGraphSnapshot, OrchestrationStage } from '../group/types'
import { createOrchestrationCanvas } from './orchestrationCanvas'

interface MockEdgeEvent {
  getSourceCellId?: () => string | undefined
  getTargetCellId?: () => string | undefined
  getSource?: () => unknown
  getTarget?: () => unknown
}

class MockGraph {
  static instances: MockGraph[] = []
  static emitGraphEventsDuringFromJSON = false
  nodes: unknown[] = []
  edges: unknown[] = []
  fromJSONCalls = 0
  disposed = false
  handlers = new Map<string, (args: { node?: { getData(): Record<string, unknown> }; edge?: MockEdgeEvent }) => void>()

  constructor(public options: Record<string, unknown>) {
    MockGraph.instances.push(this)
  }

  clearCells(): void {
    this.nodes = []
    this.edges = []
  }

  addNode(node: unknown): unknown {
    this.nodes.push(node)
    return node
  }

  addEdge(edge: unknown): unknown {
    this.edges.push(edge)
    return edge
  }

  fromJSON(data: { nodes?: unknown[]; edges?: unknown[] }): void {
    this.fromJSONCalls += 1
    if (MockGraph.emitGraphEventsDuringFromJSON) {
      this.handlers.get('edge:removed')?.({ edge: { getSourceCellId: () => 'stage-1', getTargetCellId: () => 'review-1' } })
      this.handlers.get('edge:connected')?.({ edge: { getSourceCellId: () => 'stage-1', getTargetCellId: () => 'review-1' } })
    }
    this.nodes = data.nodes ?? []
    this.edges = data.edges ?? []
  }

  on(eventName: string, handler: (args: { node?: { getData(): Record<string, unknown> }; edge?: MockEdgeEvent }) => void): void {
    this.handlers.set(eventName, handler)
  }

  dispose(): void {
    this.disposed = true
  }
}

const stages: OrchestrationStage[] = [
  { id: 'stage-1', kind: 'roles', name: '分析', roleIds: ['role-1', 'role-2'] },
  { id: 'review-1', kind: 'review', name: '审核', roleIds: ['role-3'], review: { reviewerRoleIds: ['role-3'], instructions: '必须完整' } },
]

describe('orchestration canvas', () => {
  it('loads X6 through the injected dynamic loader and renders one node per stage', async () => {
    MockGraph.instances = []
    const rootEl = document.createElement('div')
    const loadX6 = vi.fn(async () => ({ Graph: MockGraph }))
    const onStageSelected = vi.fn()
    const canvas = createOrchestrationCanvas({
      rootEl,
      getRoleName: roleId => ({ 'role-1': '产品', 'role-2': '工程', 'role-3': '评审' })[roleId] ?? roleId,
      onStageSelected,
      onRoleDropped: vi.fn(),
      loadX6,
    })

    await canvas.mount(stages, 'stage-1')

    expect(loadX6).toHaveBeenCalledTimes(1)
    expect(MockGraph.instances[0].options.container).toBe(rootEl)
    expect(MockGraph.instances[0].fromJSONCalls).toBe(1)
    expect(MockGraph.instances[0].nodes).toHaveLength(2)
    expect(MockGraph.instances[0].edges).toHaveLength(0)
    MockGraph.instances[0].handlers.get('node:click')?.({ node: { getData: () => ({ stageId: 'review-1' }) } })
    expect(onStageSelected).toHaveBeenCalledWith('review-1')
  })

  it('renders graph edges and reports dragged connections back to the draft', async () => {
    MockGraph.instances = []
    const rootEl = document.createElement('div')
    const onGraphChanged = vi.fn()
    const canvas = createOrchestrationCanvas({
      rootEl,
      getRoleName: roleId => roleId,
      onStageSelected: vi.fn(),
      onRoleDropped: vi.fn(),
      onGraphChanged,
      loadX6: async () => ({ Graph: MockGraph }),
    })
    const graphEdges: OrchestrationGraphSnapshot['edges'] = [{ sourceStageId: 'stage-1', targetStageId: 'review-1' }]

    await canvas.mount(stages, undefined, graphEdges)

    expect(MockGraph.instances[0].edges).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ cell: 'stage-1' }), target: expect.objectContaining({ cell: 'review-1' }) }),
    ])
    MockGraph.instances[0].handlers.get('edge:connected')?.({
      edge: {
        getSourceCellId: () => 'review-1',
        getTargetCellId: () => 'stage-1',
      },
    })
    expect(onGraphChanged).toHaveBeenLastCalledWith([
      { sourceStageId: 'stage-1', targetStageId: 'review-1' },
      { sourceStageId: 'review-1', targetStageId: 'stage-1' },
    ])
  })

  it('replaces graph content on repeated renders instead of duplicating cells', async () => {
    MockGraph.instances = []
    const rootEl = document.createElement('div')
    const canvas = createOrchestrationCanvas({
      rootEl,
      getRoleName: roleId => roleId,
      onStageSelected: vi.fn(),
      onRoleDropped: vi.fn(),
      loadX6: async () => ({ Graph: MockGraph }),
    })

    await canvas.mount(stages, 'stage-1')
    canvas.render(stages, 'review-1')
    canvas.render(stages, 'stage-1')

    expect(MockGraph.instances[0].fromJSONCalls).toBe(3)
    expect(MockGraph.instances[0].nodes).toHaveLength(2)
    expect(MockGraph.instances[0].edges).toHaveLength(0)
  })

  it('does not report graph change events caused by programmatic rerenders', async () => {
    MockGraph.instances = []
    MockGraph.emitGraphEventsDuringFromJSON = true
    const rootEl = document.createElement('div')
    const onGraphChanged = vi.fn()
    const canvas = createOrchestrationCanvas({
      rootEl,
      getRoleName: roleId => roleId,
      onStageSelected: vi.fn(),
      onRoleDropped: vi.fn(),
      onGraphChanged,
      loadX6: async () => ({ Graph: MockGraph }),
    })

    await canvas.mount(stages, undefined, [{ sourceStageId: 'stage-1', targetStageId: 'review-1' }])
    canvas.render(stages, 'stage-1', [{ sourceStageId: 'stage-1', targetStageId: 'review-1' }])

    expect(onGraphChanged).not.toHaveBeenCalled()
    MockGraph.emitGraphEventsDuringFromJSON = false
  })

  it('handles role drops and disposes X6 graph on destroy', async () => {
    MockGraph.instances = []
    const rootEl = document.createElement('div')
    const onRoleDropped = vi.fn()
    const canvas = createOrchestrationCanvas({
      rootEl,
      getRoleName: roleId => roleId,
      onStageSelected: vi.fn(),
      onRoleDropped,
      loadX6: async () => ({ Graph: MockGraph }),
    })
    await canvas.mount(stages)

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'role-4' } })
    rootEl.dispatchEvent(drop)

    expect(onRoleDropped).toHaveBeenCalledWith('role-4', undefined)
    canvas.destroy()
    expect(MockGraph.instances[0].disposed).toBe(true)
  })
})
