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

interface X6GraphNodeCell {
  getData?: () => Record<string, unknown>
  attr?: (path: string, value: unknown) => void
}

interface X6GraphEdge {
  id?: string
  shape?: string
  source: string | { cell: string; port?: string }
  target: string | { cell: string; port?: string }
  vertices?: Array<{ x: number; y: number }>
  attrs?: Record<string, unknown>
  labels?: Array<Record<string, unknown>>
  tools?: Record<string, unknown>
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
  getSourcePortId?: () => string | undefined
  getTargetPortId?: () => string | undefined
  getSource?: () => unknown
  getTarget?: () => unknown
  getVertices?: () => unknown
}

interface X6Graph {
  clearCells(): void
  addNode(node: X6GraphNode): unknown
  addEdge(edge: X6GraphEdge): unknown
  getNodes?(): X6GraphNodeCell[]
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
  getRoleSiteLabel?(roleId: string): string
  onStageSelected(stageId: string): void
  onRoleDropped(roleId: string, targetStageId?: string): void
  onGraphChanged?(edges: OrchestrationGraphSnapshot['edges']): void
  loadX6?: LoadX6
}

export interface OrchestrationCanvas {
  mount(stages: OrchestrationStage[], selectedStageId?: string, graphEdges?: OrchestrationGraphSnapshot['edges']): Promise<void>
  render(stages: OrchestrationStage[], selectedStageId?: string, graphEdges?: OrchestrationGraphSnapshot['edges']): void
  selectStage(stageId?: string): void
  destroy(): void
}

export function createOrchestrationCanvas(deps: OrchestrationCanvasDependencies): OrchestrationCanvas {
  let graph: X6Graph | undefined
  let destroyed = false
  let currentEdges: OrchestrationGraphSnapshot['edges'] = []
  let currentStages: OrchestrationStage[] = []
  let currentSelectedStageId: string | undefined
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
      interacting: {
        edgeMovable: true,
        arrowheadMovable: true,
        vertexMovable: true,
        toolsAddable: true,
      },
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
          if (!sourceCell?.id || !targetCell?.id || sourceCell.id === targetCell.id || (targetPort && targetPort !== 'in')) return false
          const sourceStage = currentStages.find(stage => stage.id === sourceCell.id)
          if (sourceStage?.kind === 'review') return sourcePort === 'pass' || sourcePort === 'continue'
          return sourcePort === 'out'
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
      render(currentStages, currentSelectedStageId, currentEdges)
    })
    graph.on('edge:removed', ({ edge }) => {
      if (applyingGraphData) return
      const removed = readEdgeEvent(edge)
      if (!removed) return
      currentEdges = currentEdges.filter(edgeItem => edgeKey(edgeItem) !== edgeKey(removed))
      deps.onGraphChanged?.(currentEdges)
      render(currentStages, currentSelectedStageId, currentEdges)
    })
    graph.on('edge:change:vertices', ({ edge }) => {
      if (applyingGraphData) return
      const changed = readEdgeEvent(edge)
      if (!changed) return
      const changedKey = edgeKey(changed)
      const existingIndex = currentEdges.findIndex(edgeItem => edgeKey(edgeItem) === changedKey)
      currentEdges = existingIndex >= 0
        ? currentEdges.map((edgeItem, index) => index === existingIndex ? changed : edgeItem)
        : uniqueEdges([...currentEdges, changed])
      deps.onGraphChanged?.(currentEdges)
    })
    render(stages, selectedStageId, graphEdges)
  }

  function render(stages: OrchestrationStage[], selectedStageId?: string, graphEdges?: OrchestrationGraphSnapshot['edges']): void {
    if (!graph) return
    currentStages = stages
    currentSelectedStageId = selectedStageId
    currentEdges = uniqueEdges(graphEdges ?? [])
    const data = buildGraphData(stages, selectedStageId, currentEdges, deps.getRoleName, deps.getRoleSiteLabel)
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

  function selectStage(stageId?: string): void {
    if (!graph?.getNodes) return
    const stagesById = new Map(currentStages.map(stage => [stage.id, stage]))
    for (const node of graph.getNodes()) {
      const nodeStageId = node.getData?.().stageId
      if (typeof nodeStageId !== 'string') continue
      const stage = stagesById.get(nodeStageId)
      if (!stage) continue
      const style = nodeStyle(stageId === nodeStageId)
      node.attr?.('body/stroke', style.stroke)
      node.attr?.('body/strokeWidth', style.strokeWidth)
      node.attr?.('body/filter', style.filter)
    }
  }

  function buildGraphData(
    stages: OrchestrationStage[],
    selectedStageId: string | undefined,
    edges: OrchestrationGraphSnapshot['edges'],
    getRoleName: (roleId: string) => string,
    getRoleSiteLabel: ((roleId: string) => string) | undefined,
  ): X6GraphData {
    return {
      nodes: stages.map((stage, index) => {
        const roleNames = stage.roleIds.map(getRoleName)
        const roleLabel = roleNames[0] ?? '未选择人员'
        const siteLabel = stage.roleIds[0] ? getRoleSiteLabel?.(stage.roleIds[0]).trim() : ''
        const isReview = stage.kind === 'review'
        const selected = selectedStageId === stage.id
        const style = nodeStyle(selected)
        return {
          id: stage.id,
          shape: isReview ? 'polygon' : 'rect',
          x: 48 + index * 154,
          y: isReview ? 106 : 72,
          width: isReview ? 104 : 124,
          height: isReview ? 78 : 56,
          label: `${roleLabel}${siteLabel ? `\n${siteLabel}` : ''}`,
          data: { stageId: stage.id },
          ports: {
            groups: {
              in: portGroup('left'),
              ...(isReview ? { pass: portGroup('right'), continue: portGroup('bottom') } : { out: portGroup('right') }),
            },
            items: isReview ? [
              { id: 'in', group: 'in' },
              { id: 'pass', group: 'pass' },
              { id: 'continue', group: 'continue' },
            ] : [
              { id: 'in', group: 'in' },
              { id: 'out', group: 'out' },
            ],
          },
          attrs: {
            root: { 'data-stage-id': stage.id },
            body: {
              fill: '#101e2a',
              stroke: style.stroke,
              strokeWidth: style.strokeWidth,
              refPoints: isReview ? '0,10 10,0 20,10 10,20' : undefined,
              rx: 12,
              ry: 12,
              filter: style.filter,
            },
            label: {
              fill: '#edf5f7',
              fontSize: 11,
              fontWeight: 720,
              lineHeight: 15,
              textWrap: { width: 96, height: 34, ellipsis: true },
            },
          },
        }
      }),
      edges: edges.map(edge => buildEdge(edge, stages)),
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

  return { mount, render, selectStage, destroy }
}

function buildEdge(edge: OrchestrationGraphSnapshot['edges'][number], stages: OrchestrationStage[]): X6GraphEdge {
  const branch = reviewEdgeBranch(edge, stages)
  const sourcePort = edge.sourcePort ?? (branch ? (branch === 'continue' ? 'continue' : 'pass') : 'out')
  return {
    id: edgeKey(edge),
    shape: 'edge',
    source: { cell: edge.sourceStageId, port: sourcePort },
    target: { cell: edge.targetStageId, port: edge.targetPort ?? 'in' },
    vertices: cloneEdgeVertices(edge.vertices),
    labels: branch ? [edgeBranchLabel(branch)] : undefined,
    tools: edgeTools(),
    attrs: {
      line: {
        stroke: '#7de6ea',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeDasharray: undefined,
        targetMarker: { name: 'classic', width: 5, height: 4 },
      },
    },
  }
}

function edgeTools(): Record<string, unknown> {
  const handleAttrs = {
    r: 3.6,
    fill: '#07111b',
    stroke: '#7de6ea',
    strokeWidth: 1.7,
  }
  return {
    name: 'edge-tools',
    items: [
      { name: 'vertices', args: { snapRadius: 12, addable: true, removable: true, removeRedundancies: true, attrs: handleAttrs } },
      { name: 'source-arrowhead', args: { attrs: handleAttrs } },
      { name: 'target-arrowhead', args: { attrs: handleAttrs } },
    ],
  }
}

function edgeBranchLabel(branch: 'pass' | 'continue'): Record<string, unknown> {
  const continueBranch = branch === 'continue'
  return {
    position: 0.55,
    attrs: {
      label: {
        text: continueBranch ? '不通过' : '通过',
        fill: '#c9fbef',
        fontSize: 9,
        fontWeight: 720,
      },
      body: {
        fill: 'rgba(5, 32, 34, 0.92)',
        stroke: 'rgba(125, 230, 234, 0.5)',
        strokeWidth: 1,
        rx: 5,
        ry: 5,
      },
    },
  }
}

function reviewEdgeBranch(edge: OrchestrationGraphSnapshot['edges'][number], stages: OrchestrationStage[]): 'pass' | 'continue' | undefined {
  if (edge.sourcePort === 'pass' || edge.sourcePort === 'continue') return edge.sourcePort
  const sourceIndex = stages.findIndex(stage => stage.id === edge.sourceStageId)
  const targetIndex = stages.findIndex(stage => stage.id === edge.targetStageId)
  const source = stages[sourceIndex]
  if (!source || source.kind !== 'review' || sourceIndex < 0 || targetIndex < 0) return undefined
  return targetIndex <= sourceIndex ? 'continue' : 'pass'
}

function nodeStyle(selected: boolean): { stroke: string; strokeWidth: number; filter: string } {
  return {
    stroke: selected ? '#7de6ea' : '#42667c',
    strokeWidth: selected ? 2.4 : 1.3,
    filter: selected ? 'drop-shadow(0 0 10px rgba(87, 216, 221, 0.24))' : 'drop-shadow(0 8px 18px rgba(0, 0, 0, 0.24))',
  }
}

function uniqueEdges(edges: OrchestrationGraphSnapshot['edges']): OrchestrationGraphSnapshot['edges'] {
  const seen = new Set<string>()
  const result: OrchestrationGraphSnapshot['edges'] = []
  for (const edge of edges) {
    if (!edge.sourceStageId || !edge.targetStageId || edge.sourceStageId === edge.targetStageId) continue
    const key = edgeKey(edge)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(edge)
  }
  return result
}

function edgeKey(edge: OrchestrationGraphSnapshot['edges'][number]): string {
  const sourcePort = edge.sourcePort === 'out' ? '' : edge.sourcePort ?? ''
  const targetPort = edge.targetPort === 'in' ? '' : edge.targetPort ?? ''
  return `${edge.sourceStageId}:${sourcePort}->${edge.targetStageId}:${targetPort}`
}

function portGroup(position: 'left' | 'right' | 'bottom'): Record<string, unknown> {
  return {
    position,
    attrs: {
      circle: {
        r: 4.5,
        magnet: true,
        stroke: '#57d8dd',
        strokeWidth: 2,
        fill: '#07111b',
        opacity: 0.98,
        cursor: position === 'left' ? 'default' : 'crosshair',
      },
    },
  }
}

function readEdgeEvent(edge: X6GraphEdgeEvent | undefined): OrchestrationGraphSnapshot['edges'][number] | undefined {
  const sourceStageId = edge?.getSourceCellId?.() ?? readCellId(edge?.getSource?.())
  const targetStageId = edge?.getTargetCellId?.() ?? readCellId(edge?.getTarget?.())
  if (!sourceStageId || !targetStageId || sourceStageId === targetStageId) return undefined
  const sourcePort = normalizeSourcePort(edge?.getSourcePortId?.() ?? readPortId(edge?.getSource?.()))
  const targetPort = normalizeTargetPort(edge?.getTargetPortId?.() ?? readPortId(edge?.getTarget?.()))
  const vertices = readEdgeVertices(edge?.getVertices?.())
  return {
    sourceStageId,
    targetStageId,
    ...(sourcePort ? { sourcePort } : {}),
    ...(targetPort ? { targetPort } : {}),
    ...(vertices ? { vertices } : {}),
  }
}

function cloneEdgeVertices(vertices: OrchestrationGraphSnapshot['edges'][number]['vertices']): Array<{ x: number; y: number }> | undefined {
  return vertices && vertices.length > 0 ? vertices.map(vertex => ({ x: vertex.x, y: vertex.y })) : undefined
}

function readEdgeVertices(value: unknown): Array<{ x: number; y: number }> | undefined {
  if (!Array.isArray(value)) return undefined
  const vertices = value.flatMap(vertex => {
    if (!isRecord(vertex) || typeof vertex.x !== 'number' || typeof vertex.y !== 'number' || !Number.isFinite(vertex.x) || !Number.isFinite(vertex.y)) return []
    return [{ x: vertex.x, y: vertex.y }]
  })
  return vertices.length > 0 ? vertices : undefined
}

function readCellId(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined
  const cell = value.cell
  return typeof cell === 'string' ? cell : undefined
}

function readPortId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const port = value.port
  return typeof port === 'string' ? port : undefined
}

function normalizeSourcePort(port: string | undefined): OrchestrationGraphSnapshot['edges'][number]['sourcePort'] | undefined {
  return port === 'out' || port === 'pass' || port === 'continue' ? port : undefined
}

function normalizeTargetPort(port: string | undefined): OrchestrationGraphSnapshot['edges'][number]['targetPort'] | undefined {
  return port === 'in' ? port : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stageRoleLabel(stage: OrchestrationStage, rolesById: Record<string, GroupRole>): string {
  return stage.roleIds.map(roleId => rolesById[roleId]?.name ?? '未知人员').join(' + ')
}
