import type { GroupRole, OrchestrationGraphSnapshot, OrchestrationStage } from '../group/types'

interface X6GraphNode {
  id?: string
  shape?: string
  x?: number
  y?: number
  width?: number
  height?: number
  label?: string
  data?: Record<string, unknown>
  attrs?: Record<string, unknown>
  ports?: Record<string, unknown>
}

interface X6GraphEdge {
  id?: string
  shape?: string
  source: string | { cell: string; port?: string }
  target: string | { cell: string; port?: string }
  attrs?: Record<string, unknown>
}

interface X6GraphData {
  nodes: X6GraphNode[]
  edges: X6GraphEdge[]
}

interface X6GraphCell {
  id?: string
}

interface X6GraphConnectionArgs {
  sourceCell?: X6GraphCell
  targetCell?: X6GraphCell
  sourcePort?: string
  targetPort?: string
}

interface X6GraphEdgeEvent {
  getSourceCellId?: () => string | undefined
  getTargetCellId?: () => string | undefined
  getSource?: () => unknown
  getTarget?: () => unknown
}

interface X6Graph {
  clearCells(): void
  addNode(node: X6GraphNode): unknown
  addEdge(edge: X6GraphEdge): unknown
  fromJSON?(data: X6GraphData): unknown
  on(eventName: string, handler: (args: { node?: { getData(): Record<string, unknown> }; edge?: X6GraphEdgeEvent }) => void): void
  dispose(): void
}

interface X6Module {
  Graph: new (options: Record<string, unknown>) => X6Graph
}

export type LoadX6 = () => Promise<X6Module>

export interface OrchestrationCanvasDependencies {
  rootEl: HTMLElement
  getRoleName(roleId: string): string
  onStageSelected(stageId: string): void
  onRoleDropped(roleId: string, targetStageId?: string): void
  onGraphChanged?(edges: OrchestrationGraphSnapshot['edges']): void
  loadX6?: LoadX6
}

export interface OrchestrationCanvas {
  mount(stages: OrchestrationStage[], selectedStageId?: string, graphEdges?: OrchestrationGraphSnapshot['edges']): Promise<void>
  render(stages: OrchestrationStage[], selectedStageId?: string, graphEdges?: OrchestrationGraphSnapshot['edges']): void
  destroy(): void
}

export function createOrchestrationCanvas(deps: OrchestrationCanvasDependencies): OrchestrationCanvas {
  let graph: X6Graph | undefined
  let destroyed = false
  let currentEdges: OrchestrationGraphSnapshot['edges'] = []
  let applyingGraphData = false
  const loadX6 = deps.loadX6 ?? (async () => await import('@antv/x6') as X6Module)

  const handleDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes('application/x-openteam-role-id')) return
    event.preventDefault()
  }

  const handleDrop = (event: DragEvent): void => {
    const roleId = event.dataTransfer?.getData('application/x-openteam-role-id')
    if (!roleId) return
    event.preventDefault()
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-stage-id]') : undefined
    deps.onRoleDropped(roleId, target?.dataset.stageId)
  }

  async function mount(stages: OrchestrationStage[], selectedStageId?: string, graphEdges?: OrchestrationGraphSnapshot['edges']): Promise<void> {
    destroyed = false
    deps.rootEl.addEventListener('dragover', handleDragOver)
    deps.rootEl.addEventListener('drop', handleDrop)
    const { Graph } = await loadX6()
    if (destroyed) return
    graph = new Graph({
      container: deps.rootEl,
      autoResize: true,
      grid: { size: 18, visible: true, type: 'dot', args: { color: 'rgba(87, 216, 221, 0.14)' } },
      panning: true,
      mousewheel: { enabled: true, modifiers: ['ctrl', 'meta'] },
      connecting: {
        allowBlank: false,
        allowLoop: false,
        allowNode: true,
        allowMulti: false,
        highlight: true,
        snap: true,
        connector: { name: 'smooth' },
        router: { name: 'normal' },
        validateConnection({ sourceCell, targetCell, sourcePort, targetPort }: X6GraphConnectionArgs) {
          return Boolean(sourceCell?.id && targetCell?.id && sourceCell.id !== targetCell.id && sourcePort === 'out' && (!targetPort || targetPort === 'in'))
        },
      },
    })
    graph.on('node:click', ({ node }) => {
      const stageId = node?.getData().stageId
      if (typeof stageId === 'string') deps.onStageSelected(stageId)
    })
    graph.on('edge:connected', ({ edge }) => {
      if (applyingGraphData) return
      const nextEdge = readEdgeEvent(edge)
      if (!nextEdge) return
      currentEdges = uniqueEdges([...currentEdges, nextEdge])
      deps.onGraphChanged?.(currentEdges)
    })
    graph.on('edge:removed', ({ edge }) => {
      if (applyingGraphData) return
      const removed = readEdgeEvent(edge)
      if (!removed) return
      currentEdges = currentEdges.filter(edgeItem => edgeItem.sourceStageId !== removed.sourceStageId || edgeItem.targetStageId !== removed.targetStageId)
      deps.onGraphChanged?.(currentEdges)
    })
    render(stages, selectedStageId, graphEdges)
  }

  function render(stages: OrchestrationStage[], selectedStageId?: string, graphEdges?: OrchestrationGraphSnapshot['edges']): void {
    if (!graph) return
    currentEdges = uniqueEdges(graphEdges ?? [])
    const data = buildGraphData(stages, selectedStageId, currentEdges, deps.getRoleName)
    applyingGraphData = true
    try {
      if (graph.fromJSON) {
        graph.fromJSON(data)
        return
      }
      graph.clearCells()
      for (const node of data.nodes) graph.addNode(node)
      for (const edge of data.edges) graph.addEdge(edge)
    } finally {
      applyingGraphData = false
    }
  }

  function buildGraphData(
    stages: OrchestrationStage[],
    selectedStageId: string | undefined,
    edges: OrchestrationGraphSnapshot['edges'],
    getRoleName: (roleId: string) => string,
  ): X6GraphData {
    return {
      nodes: stages.map((stage, index) => {
        const roleNames = stage.roleIds.map(getRoleName)
        const roleLabel = roleNames[0] ?? '未选择人员'
        const isReview = stage.kind === 'review'
        const selected = selectedStageId === stage.id
        const nodeLabel = isReview ? '审核' : '执行'
        return {
          id: stage.id,
          shape: 'rect',
          x: 48 + index * 184,
          y: isReview ? 132 : 72,
          width: 148,
          height: 70,
          label: `${roleLabel}\n${nodeLabel}`,
          data: { stageId: stage.id },
          ports: {
            groups: {
              in: portGroup('left'),
              out: portGroup('right'),
            },
            items: [
              { id: 'in', group: 'in' },
              { id: 'out', group: 'out' },
            ],
          },
          attrs: {
            root: { 'data-stage-id': stage.id },
            body: {
              fill: isReview ? '#21172b' : '#101e2a',
              stroke: selected ? '#7de6ea' : isReview ? '#a684ff' : '#42667c',
              strokeWidth: selected ? 2.4 : 1.3,
              rx: 14,
              ry: 14,
              filter: selected ? 'drop-shadow(0 0 10px rgba(87, 216, 221, 0.24))' : 'drop-shadow(0 8px 18px rgba(0, 0, 0, 0.24))',
            },
            label: {
              fill: '#edf5f7',
              fontSize: 12,
              fontWeight: 720,
              lineHeight: 18,
              textWrap: { width: 112, height: 44, ellipsis: true },
            },
          },
        }
      }),
      edges: edges.map(edge => ({
        id: `${edge.sourceStageId}->${edge.targetStageId}`,
        shape: 'edge',
        source: { cell: edge.sourceStageId, port: 'out' },
        target: { cell: edge.targetStageId, port: 'in' },
        attrs: {
          line: {
            stroke: '#7de6ea',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            targetMarker: { name: 'classic', width: 7, height: 5 },
          },
        },
      })),
    }
  }

  function destroy(): void {
    destroyed = true
    deps.rootEl.removeEventListener('dragover', handleDragOver)
    deps.rootEl.removeEventListener('drop', handleDrop)
    graph?.dispose()
    graph = undefined
    deps.rootEl.replaceChildren()
  }

  return { mount, render, destroy }
}

function uniqueEdges(edges: OrchestrationGraphSnapshot['edges']): OrchestrationGraphSnapshot['edges'] {
  const seen = new Set<string>()
  const result: OrchestrationGraphSnapshot['edges'] = []
  for (const edge of edges) {
    if (!edge.sourceStageId || !edge.targetStageId || edge.sourceStageId === edge.targetStageId) continue
    const key = `${edge.sourceStageId}->${edge.targetStageId}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(edge)
  }
  return result
}

function portGroup(position: 'left' | 'right'): Record<string, unknown> {
  return {
    position,
    attrs: {
      circle: {
        r: 6,
        magnet: true,
        stroke: '#57d8dd',
        strokeWidth: 2,
        fill: '#07111b',
        opacity: 0.98,
        cursor: position === 'right' ? 'crosshair' : 'default',
      },
    },
  }
}

function readEdgeEvent(edge: X6GraphEdgeEvent | undefined): OrchestrationGraphSnapshot['edges'][number] | undefined {
  const sourceStageId = edge?.getSourceCellId?.() ?? readCellId(edge?.getSource?.())
  const targetStageId = edge?.getTargetCellId?.() ?? readCellId(edge?.getTarget?.())
  if (!sourceStageId || !targetStageId || sourceStageId === targetStageId) return undefined
  return { sourceStageId, targetStageId }
}

function readCellId(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined
  const cell = value.cell
  return typeof cell === 'string' ? cell : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stageRoleLabel(stage: OrchestrationStage, rolesById: Record<string, GroupRole>): string {
  return stage.roleIds.map(roleId => rolesById[roleId]?.name ?? '未知人员').join(' + ')
}
