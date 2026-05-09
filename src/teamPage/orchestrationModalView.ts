import type { ChatSite, ExternalModelConfig, GroupChat, GroupRole, OpenTeamStore, OrchestrationFlow, OrchestrationGraphSnapshot, OrchestrationStage } from '../group/types'
import { DEFAULT_ORCHESTRATION_MAX_NODE_EXECUTIONS, DEFAULT_ORCHESTRATION_REVIEW_MAX_ATTEMPTS, MAX_ORCHESTRATION_MAX_NODE_EXECUTIONS } from '../group/types'
import { arrangeOrchestrationGraph, createOrchestrationCanvas, type LoadX6, type OrchestrationCanvas } from './orchestrationCanvas'
import { runCommandWithReconnect } from './sendWithReconnect'

export interface OrchestrationModalDependencies {
  openOrchestrationEl: HTMLButtonElement
  orchestrationModalEl: HTMLElement
  closeOrchestrationEl: HTMLButtonElement
  orchestrationTaskEl: HTMLTextAreaElement
  orchestrationPeopleListEl: HTMLElement
  arrangeOrchestrationEl: HTMLButtonElement
  orchestrationCanvasEl: HTMLElement
  orchestrationHintEl: HTMLElement
  orchestrationStageSettingsEl: HTMLElement
  orchestrationReviewSettingsEl: HTMLElement
  orchestrationMaxRoundsEl: HTMLInputElement
  saveOrchestrationEl: HTMLButtonElement
  runOrchestrationEl: HTMLButtonElement
  getStore(): OpenTeamStore
  getCurrentChat(): GroupChat | undefined
  getCurrentRoles(): GroupRole[]
  reconnectRolesForSend(chat: GroupChat, roles: GroupRole[]): Promise<void>
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
  showSuccess(message: string): void
  loadX6?: LoadX6
}

export interface OrchestrationModalView {
  close(): void
  render(): void
  registerOrchestrationEvents(): void
}

interface FlowDraft {
  flowId?: string
  task: string
  stages: OrchestrationStage[]
  graphEdges: OrchestrationGraphSnapshot['edges']
  maxNodeExecutions: number
  selectedStageId?: string
}

export function createOrchestrationModalView(deps: OrchestrationModalDependencies): OrchestrationModalView {
  let draft: FlowDraft = emptyDraft()
  let canvas: OrchestrationCanvas | undefined
  let mounted = false
  let saving = false
  let running = false

  function emptyDraft(): FlowDraft {
    return { task: '', stages: [], graphEdges: [], maxNodeExecutions: DEFAULT_ORCHESTRATION_MAX_NODE_EXECUTIONS }
  }

  function open(): void {
    const chat = deps.getCurrentChat()
    if (!chat) {
      deps.showError('请选择群聊后再编排任务')
      return
    }
    loadDraft(chat)
    deps.orchestrationModalEl.hidden = false
    deps.orchestrationTaskEl.value = draft.task
    deps.orchestrationMaxRoundsEl.value = String(draft.maxNodeExecutions)
    deps.orchestrationMaxRoundsEl.max = String(MAX_ORCHESTRATION_MAX_NODE_EXECUTIONS)
    mountCanvas()
    render()
    deps.orchestrationTaskEl.focus()
  }

  function close(): void {
    deps.orchestrationModalEl.hidden = true
    canvas?.destroy()
    canvas = undefined
    mounted = false
    draft = emptyDraft()
  }

  function loadDraft(chat: GroupChat): void {
    const store = deps.getStore()
    const flowId = store.orchestrationFlowOrderByChatId[chat.id]?.[0]
    const flow = flowId ? store.orchestrationFlowsById[flowId] : undefined
    if (!flow) {
      draft = emptyDraft()
      return
    }
    const stages = cloneStages(flow.graph?.stageNodes?.length ? flow.graph.stageNodes : flow.stages)
    draft = {
      flowId: flow.id,
      task: flow.description?.trim() ?? '',
      stages,
      graphEdges: flow.graph?.edges ? cloneGraphEdges(flow.graph.edges) : sequentialGraphEdges(stages),
      maxNodeExecutions: clampMaxNodeExecutions(flow.maxNodeExecutions ?? DEFAULT_ORCHESTRATION_MAX_NODE_EXECUTIONS),
      selectedStageId: undefined,
    }
  }

  function mountCanvas(): void {
    canvas?.destroy()
    canvas = createOrchestrationCanvas({
      rootEl: deps.orchestrationCanvasEl,
      getRoleName,
      getRoleSiteLabel,
      onStageSelected(stageId) {
        draft.selectedStageId = stageId
        renderStageSettings()
        canvas?.selectStage(stageId)
      },
      onRoleDropped(roleId) {
        addRoleAsStage(roleId)
      },
      onGraphChanged(edges) {
        draft.graphEdges = cloneGraphEdges(edges)
      },
      loadX6: deps.loadX6,
    })
    canvas.mount(draft.stages, draft.selectedStageId, draft.graphEdges).then(() => {
      mounted = true
    }).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
  }

  function render(): void {
    if (deps.orchestrationModalEl.hidden) return
    draft.maxNodeExecutions = clampMaxNodeExecutions(Number(deps.orchestrationMaxRoundsEl.value || DEFAULT_ORCHESTRATION_MAX_NODE_EXECUTIONS))
    deps.orchestrationHintEl.hidden = draft.stages.length > 0
    deps.orchestrationHintEl.textContent = '把人员拖到画布生成节点，再从节点端口拖线编排执行关系。'
    renderPeopleList()
    renderStageSettings()
    if (mounted) canvas?.render(draft.stages, draft.selectedStageId, draft.graphEdges)
  }

  function renderPeopleList(): void {
    const roles = deps.getCurrentRoles()
    deps.orchestrationPeopleListEl.replaceChildren()
    if (roles.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty-card compact'
      empty.textContent = '当前群聊暂无人员，无法编排任务。'
      deps.orchestrationPeopleListEl.append(empty)
      return
    }
    for (const role of roles) {
      const card = document.createElement('div')
      card.className = 'orchestration-person'
      card.draggable = true
      card.addEventListener('dragstart', event => {
        event.dataTransfer?.setData('application/x-openteam-role-id', role.id)
      })
      const avatar = document.createElement('span')
      avatar.className = `orchestration-person-avatar ${roleToneClass(role.id)}`
      avatar.textContent = roleInitial(role.name)
      const body = document.createElement('div')
      body.className = 'orchestration-person-body'
      const row = document.createElement('div')
      row.className = 'orchestration-person-title'
      const name = document.createElement('strong')
      name.textContent = role.name
      row.append(name, roleSitePill(role))
      const description = document.createElement('span')
      description.className = 'tiny'
      description.textContent = role.description || '拖到画布创建节点'
      body.append(row, description)
      card.append(avatar, body)
      deps.orchestrationPeopleListEl.append(card)
    }
  }

  function roleSitePill(role: GroupRole): HTMLElement {
    const model = roleModelDisplay(role, deps.getStore())
    const pill = document.createElement('span')
    pill.className = `site-pill orchestration-person-site ${model.className}`
    pill.textContent = model.label
    return pill
  }

  function renderStageSettings(): void {
    const selected = selectedStage()
    deps.orchestrationStageSettingsEl.replaceChildren()
    deps.orchestrationReviewSettingsEl.replaceChildren()
    const settingsPanel = deps.orchestrationStageSettingsEl.closest<HTMLElement>('.orchestration-settings')
    const layout = deps.orchestrationStageSettingsEl.closest<HTMLElement>('.orchestration-layout')
    settingsPanel?.toggleAttribute('hidden', !selected)
    layout?.classList.toggle('settings-hidden', !selected)
    if (!selected) {
      return
    }

    const header = document.createElement('div')
    header.className = 'orchestration-node-editor-header'
    const title = document.createElement('h3')
    title.textContent = selected.kind === 'review' ? '审核节点' : '执行节点'
    const closeButton = document.createElement('button')
    closeButton.className = 'icon-btn orchestration-node-editor-close'
    closeButton.type = 'button'
    closeButton.ariaLabel = '关闭节点设置'
    closeButton.textContent = '×'
    closeButton.addEventListener('click', clearSelectedStage)
    header.append(title, closeButton)
    const kindField = document.createElement('label')
    kindField.className = 'field'
    kindField.textContent = '节点类型'
    const kindSelect = document.createElement('select')
    kindSelect.dataset.stageKind = 'true'
    kindSelect.append(new Option('执行', 'roles'), new Option('审核', 'review'))
    kindSelect.value = selected.kind
    kindSelect.addEventListener('change', () => {
      setStageKind(selected, kindSelect.value === 'review' ? 'review' : 'roles')
    })
    kindField.append(kindSelect)
    const nameField = document.createElement('label')
    nameField.className = 'field'
    nameField.textContent = '节点名称'
    const nameInput = document.createElement('input')
    nameInput.value = selected.name
    nameInput.addEventListener('input', () => {
      selected.name = nameInput.value.trim() || (selected.kind === 'review' ? '审核' : '执行节点')
      canvas?.render(draft.stages, draft.selectedStageId, draft.graphEdges)
    })
    nameField.append(nameInput)
    const descriptionField = document.createElement('label')
    descriptionField.className = 'field'
    descriptionField.textContent = '任务描述'
    const descriptionInput = document.createElement('textarea')
    descriptionInput.value = selected.description ?? ''
    descriptionInput.placeholder = '给这个节点单独补充任务说明，例如：先澄清目标，只输出优先级和风险。'
    descriptionInput.addEventListener('input', () => {
      const description = descriptionInput.value.trim()
      if (description) selected.description = description
      else delete selected.description
    })
    descriptionField.append(descriptionInput)
    const rolesField = document.createElement('div')
    rolesField.className = 'field'
    rolesField.textContent = selected.kind === 'review' ? '审核人员' : '执行人员'
    const roles = document.createElement('div')
    roles.className = 'stage-role-chips'
    for (const roleId of selectedRoleIds(selected)) roles.append(roleChip(roleId))
    rolesField.append(roles)
    const remove = document.createElement('button')
    remove.className = 'btn btn-danger'
    remove.type = 'button'
    remove.textContent = '删除节点'
    remove.addEventListener('click', () => removeStage(selected.id))
    deps.orchestrationStageSettingsEl.append(header, kindField, nameField, descriptionField, rolesField, remove)

    if (selected.kind === 'review') renderReviewSettings(selected)
  }

  function renderReviewSettings(stage: OrchestrationStage): void {
    const intro = settingsNote('审核节点由一个群聊人员根据标准判断通过或不通过。')
    const criteriaField = document.createElement('label')
    criteriaField.className = 'field'
    criteriaField.textContent = '审核标准'
    const criteria = document.createElement('textarea')
    criteria.value = stage.review?.instructions ?? ''
    criteria.placeholder = '例如：答案需要覆盖风险、方案和下一步行动。未满足时返回 fail。'
    criteria.addEventListener('input', () => {
      stage.review = normalizedReviewConfig(stage, { instructions: criteria.value })
    })
    criteriaField.append(criteria)
    const attemptsField = document.createElement('label')
    attemptsField.className = 'field'
    attemptsField.textContent = '最大审核次数'
    const attemptsInput = document.createElement('input')
    attemptsInput.type = 'number'
    attemptsInput.min = '1'
    attemptsInput.max = '50'
    attemptsInput.value = String(stage.review?.maxAttempts ?? DEFAULT_ORCHESTRATION_REVIEW_MAX_ATTEMPTS)
    attemptsInput.addEventListener('input', () => {
      stage.review = normalizedReviewConfig(stage, { maxAttempts: clampReviewAttempts(Number(attemptsInput.value || DEFAULT_ORCHESTRATION_REVIEW_MAX_ATTEMPTS)) })
    })
    attemptsField.append(attemptsInput)
    const actionField = document.createElement('label')
    actionField.className = 'field'
    actionField.textContent = '达到上限后'
    const actionSelect = document.createElement('select')
    actionSelect.append(new Option('停止流程', 'stop'), new Option('继续往下走', 'continue'))
    actionSelect.value = stage.review?.onMaxAttempts ?? 'stop'
    actionSelect.addEventListener('change', () => {
      stage.review = normalizedReviewConfig(stage, { onMaxAttempts: actionSelect.value === 'continue' ? 'continue' : 'stop' })
    })
    actionField.append(actionSelect)
    const preview = document.createElement('div')
    preview.className = 'orchestration-json-preview'
    const previewTitle = document.createElement('span')
    previewTitle.className = 'tiny'
    previewTitle.textContent = '审核返回 JSON 预览'
    const schema = document.createElement('pre')
    schema.textContent = '{\n  "decision": "pass | fail",\n  "reason": "审核说明",\n  "failedCriteria": [],\n  "nextRoundInstruction": "不通过时的重试说明"\n}'
    preview.append(previewTitle, schema)
    deps.orchestrationReviewSettingsEl.append(intro, criteriaField, attemptsField, actionField, preview)
  }

  function settingsNote(message: string): HTMLElement {
    const note = document.createElement('p')
    note.className = 'tiny orchestration-note'
    note.textContent = message
    return note
  }

  function roleChip(roleId: string): HTMLElement {
    const chip = document.createElement('span')
    chip.className = 'stage-role-chip'
    chip.textContent = getRoleName(roleId)
    return chip
  }

  function selectedRoleIds(stage: OrchestrationStage): string[] {
    if (stage.kind === 'review') return stage.review?.reviewerRoleIds.length ? stage.review.reviewerRoleIds : stage.roleIds
    return stage.roleIds
  }

  function addRoleAsStage(roleId: string): void {
    const stage: OrchestrationStage = { id: newId('stage'), kind: 'roles', name: getRoleName(roleId), roleIds: [roleId] }
    const reviewIndex = draft.stages.findIndex(item => item.kind === 'review')
    if (reviewIndex >= 0) draft.stages.splice(reviewIndex, 0, stage)
    else draft.stages.push(stage)
    draft.selectedStageId = undefined
    render()
  }

  function setStageKind(stage: OrchestrationStage, kind: OrchestrationStage['kind']): void {
    if (stage.kind === kind) return
    stage.kind = kind
    if (kind === 'review') {
      stage.name = stage.name.trim() || '审核'
      stage.roleIds = stage.roleIds.slice(0, 1)
      stage.review = normalizedReviewConfig(stage)
    } else {
      delete stage.review
      stage.name = stage.name.trim() || getRoleName(stage.roleIds[0] ?? '') || '执行'
    }
    render()
  }

  function removeStage(stageId: string): void {
    draft.stages = draft.stages.filter(stage => stage.id !== stageId)
    draft.graphEdges = draft.graphEdges.filter(edge => edge.sourceStageId !== stageId && edge.targetStageId !== stageId)
    draft.selectedStageId = undefined
    render()
  }

  function clearSelectedStage(): void {
    draft.selectedStageId = undefined
    renderStageSettings()
    canvas?.selectStage(undefined)
  }

  function arrangeCanvas(): void {
    const arranged = arrangeOrchestrationGraph(draft.stages, draft.graphEdges)
    draft.stages = arranged.stages
    draft.graphEdges = arranged.edges
    render()
  }

  async function save(): Promise<void> {
    if (saving || running) return
    const chat = deps.getCurrentChat()
    if (!chat || !validateDraft(false)) return
    saving = true
    updateActionButtons()
    try {
      const flow = buildFlow(chat)
      await deps.runCommand('GROUP_ORCHESTRATION_FLOW_SAVE', { chatId: chat.id, flow })
      draft.flowId = flow.id
      deps.showSuccess('编排流程已保存')
    } finally {
      saving = false
      updateActionButtons()
    }
  }

  async function run(): Promise<void> {
    if (running || saving) return
    const chat = deps.getCurrentChat()
    const task = deps.orchestrationTaskEl.value.trim()
    if (!chat || !validateDraft(true)) return
    if (!task) {
      deps.showError('请输入编排任务')
      return
    }
    running = true
    updateActionButtons()
    try {
      const flow = buildFlow(chat)
      await runCommandWithReconnect(deps, { chat, roles: getDraftRoles(), type: 'GROUP_ORCHESTRATION_RUN', payload: { chatId: chat.id, task, flow }, preconnectAll: true })
      draft.flowId = flow.id
      deps.showSuccess('编排任务已开始')
      close()
    } finally {
      running = false
      updateActionButtons()
    }
  }

  function updateActionButtons(): void {
    deps.saveOrchestrationEl.disabled = saving || running
    deps.runOrchestrationEl.disabled = saving || running
  }

  function buildFlow(chat: GroupChat): OrchestrationFlow {
    const now = Date.now()
    const graphEdges = filterGraphEdges(draft.graphEdges, draft.stages)
    const stages = orderStagesByGraph(cloneStages(draft.stages), graphEdges)
    const task = deps.orchestrationTaskEl.value.trim()
    return {
      id: draft.flowId ?? newId('flow'),
      chatId: chat.id,
      name: `${chat.name} 编排流程`,
      description: task || undefined,
      stages,
      graph: {
        stageNodes: stages,
        edges: graphEdges,
      },
      maxNodeExecutions: readMaxNodeExecutionsInput(deps.orchestrationMaxRoundsEl),
      maxRounds: readMaxNodeExecutionsInput(deps.orchestrationMaxRoundsEl),
      createdAt: now,
      updatedAt: now,
    }
  }

  function validateDraft(requireTask: boolean): boolean {
    if (deps.getCurrentRoles().length === 0) {
      deps.showError('当前群聊暂无人员，无法编排任务')
      return false
    }
    if (requireTask && !deps.orchestrationTaskEl.value.trim()) {
      deps.showError('请输入编排任务')
      return false
    }
    if (draft.stages.length === 0) {
      deps.showError('请至少添加一个流程节点')
      return false
    }
    if (draft.stages.some(stage => stage.roleIds.length === 0)) {
      deps.showError('每个节点都需要至少一个人员')
      return false
    }
    const review = draft.stages.find(stage => stage.kind === 'review')
    if (review && (!review.review?.reviewerRoleIds.length || !review.review.instructions?.trim())) {
      deps.showError('审核节点需要审核人员和审核标准')
      return false
    }
    const rawMaxNodeExecutions = Number(deps.orchestrationMaxRoundsEl.value)
    if (!Number.isFinite(rawMaxNodeExecutions) || rawMaxNodeExecutions < 1 || rawMaxNodeExecutions > MAX_ORCHESTRATION_MAX_NODE_EXECUTIONS) {
      deps.showError(`最大节点执行数需在 1-${MAX_ORCHESTRATION_MAX_NODE_EXECUTIONS} 之间`)
      return false
    }
    return true
  }

  function selectedStage(): OrchestrationStage | undefined {
    return draft.stages.find(stage => stage.id === draft.selectedStageId)
  }

  function getRoleName(roleId: string): string {
    return deps.getStore().rolesById[roleId]?.name ?? '未知人员'
  }

  function getRoleSiteLabel(roleId: string): string {
    const role = deps.getStore().rolesById[roleId]
    return role ? roleModelDisplay(role, deps.getStore()).label : ''
  }

  function getDraftRoles(): GroupRole[] {
    const rolesById = new Map(deps.getCurrentRoles().map(role => [role.id, role]))
    const roleIds = new Set<string>()
    for (const stage of draft.stages) {
      for (const roleId of stage.roleIds) roleIds.add(roleId)
      if (stage.kind === 'review') {
        for (const roleId of stage.review?.reviewerRoleIds ?? []) roleIds.add(roleId)
      }
    }
    return [...roleIds].map(roleId => rolesById.get(roleId)).filter((role): role is GroupRole => Boolean(role))
  }

  function registerOrchestrationEvents(): void {
    deps.openOrchestrationEl.addEventListener('click', open)
    deps.closeOrchestrationEl.addEventListener('click', close)
    deps.arrangeOrchestrationEl.addEventListener('click', arrangeCanvas)
    deps.orchestrationMaxRoundsEl.addEventListener('input', render)
    deps.saveOrchestrationEl.addEventListener('click', () => save().catch(error => deps.showError(error instanceof Error ? error.message : String(error))))
    deps.runOrchestrationEl.addEventListener('click', () => run().catch(error => deps.showError(error instanceof Error ? error.message : String(error))))
  }

  return { close, render, registerOrchestrationEvents }
}

function cloneStages(stages: OrchestrationStage[]): OrchestrationStage[] {
  return stages.map(stage => ({
    ...stage,
    position: stage.position ? { x: stage.position.x, y: stage.position.y } : undefined,
    roleIds: [...stage.roleIds],
    review: stage.review ? { ...stage.review, reviewerRoleIds: [...stage.review.reviewerRoleIds] } : undefined,
  }))
}

function normalizedReviewConfig(stage: OrchestrationStage, patch: Partial<NonNullable<OrchestrationStage['review']>> = {}): NonNullable<OrchestrationStage['review']> {
  return {
    reviewerRoleIds: stage.review?.reviewerRoleIds?.length ? [...stage.review.reviewerRoleIds] : [...stage.roleIds.slice(0, 1)],
    instructions: stage.review?.instructions ?? '',
    maxAttempts: clampReviewAttempts(stage.review?.maxAttempts ?? DEFAULT_ORCHESTRATION_REVIEW_MAX_ATTEMPTS),
    onMaxAttempts: stage.review?.onMaxAttempts === 'continue' ? 'continue' : 'stop',
    ...patch,
  }
}

function cloneGraphEdges(edges: OrchestrationGraphSnapshot['edges']): OrchestrationGraphSnapshot['edges'] {
  return edges.map(edge => ({
    sourceStageId: edge.sourceStageId,
    targetStageId: edge.targetStageId,
    ...(edge.sourcePort ? { sourcePort: edge.sourcePort } : {}),
    ...(edge.targetPort ? { targetPort: edge.targetPort } : {}),
    ...(edge.vertices && edge.vertices.length > 0 ? { vertices: edge.vertices.map(vertex => ({ x: vertex.x, y: vertex.y })) } : {}),
  }))
}

function sequentialGraphEdges(stages: OrchestrationStage[]): OrchestrationGraphSnapshot['edges'] {
  return stages.slice(1).map((stage, index) => ({ sourceStageId: stages[index].id, targetStageId: stage.id }))
}

function filterGraphEdges(edges: OrchestrationGraphSnapshot['edges'], stages: OrchestrationStage[]): OrchestrationGraphSnapshot['edges'] {
  const stageIds = new Set(stages.map(stage => stage.id))
  const seen = new Set<string>()
  const result: OrchestrationGraphSnapshot['edges'] = []
  for (const edge of edges) {
    if (!stageIds.has(edge.sourceStageId) || !stageIds.has(edge.targetStageId) || edge.sourceStageId === edge.targetStageId) continue
    const sourcePort = edge.sourcePort ?? ''
    const targetPort = edge.targetPort ?? ''
    const key = `${edge.sourceStageId}:${sourcePort}->${edge.targetStageId}:${targetPort}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      sourceStageId: edge.sourceStageId,
      targetStageId: edge.targetStageId,
      ...(edge.sourcePort ? { sourcePort: edge.sourcePort } : {}),
      ...(edge.targetPort ? { targetPort: edge.targetPort } : {}),
      ...(edge.vertices && edge.vertices.length > 0 ? { vertices: edge.vertices.map(vertex => ({ x: vertex.x, y: vertex.y })) } : {}),
    })
  }
  return result
}

export function orderStagesByGraph(stages: OrchestrationStage[], edges: OrchestrationGraphSnapshot['edges']): OrchestrationStage[] {
  const stageIds = new Set(stages.map(stage => stage.id))
  const validEdges = filterGraphEdges(edges, stages)
  if (validEdges.length === 0) return stages

  const outgoing = new Map<string, string[]>()
  const indegree = new Map(stages.map(stage => [stage.id, 0]))
  for (const edge of validEdges) {
    outgoing.set(edge.sourceStageId, [...outgoing.get(edge.sourceStageId) ?? [], edge.targetStageId])
    indegree.set(edge.targetStageId, (indegree.get(edge.targetStageId) ?? 0) + 1)
  }

  const byId = new Map(stages.map(stage => [stage.id, stage]))
  const queue = stages.filter(stage => (indegree.get(stage.id) ?? 0) === 0)
  const ordered: OrchestrationStage[] = []
  const emitted = new Set<string>()
  for (let index = 0; index < queue.length; index += 1) {
    const stage = queue[index]
    if (!stage || emitted.has(stage.id)) continue
    ordered.push(stage)
    emitted.add(stage.id)
    for (const targetId of outgoing.get(stage.id) ?? []) {
      if (!stageIds.has(targetId)) continue
      const nextIndegree = (indegree.get(targetId) ?? 0) - 1
      indegree.set(targetId, nextIndegree)
      const target = byId.get(targetId)
      if (target && nextIndegree === 0) queue.push(target)
    }
  }

  if (ordered.length === stages.length) return ordered
  return [...ordered, ...stages.filter(stage => !emitted.has(stage.id))]
}

function clampMaxNodeExecutions(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ORCHESTRATION_MAX_NODE_EXECUTIONS
  return Math.min(MAX_ORCHESTRATION_MAX_NODE_EXECUTIONS, Math.max(1, Math.trunc(value)))
}

function readMaxNodeExecutionsInput(input: HTMLInputElement): number {
  return clampMaxNodeExecutions(Number(input.value || DEFAULT_ORCHESTRATION_MAX_NODE_EXECUTIONS))
}

function clampReviewAttempts(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ORCHESTRATION_REVIEW_MAX_ATTEMPTS
  return Math.min(50, Math.max(1, Math.trunc(value)))
}

function roleInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '员'
}

function roleToneClass(seed: string): string {
  const tones = ['tone-blue', 'tone-green', 'tone-purple', 'tone-orange']
  const total = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  return tones[total % tones.length]
}

function roleModelDisplay(role: Pick<GroupRole, 'modelSource' | 'externalModelId' | 'chatSite'>, store: OpenTeamStore): { label: string; className: string } {
  if (role.modelSource === 'external' && role.externalModelId) {
    return { label: externalModelLabel(store.settings.externalModelsById[role.externalModelId]), className: 'site-pill-external' }
  }
  const site = visibleChatSite(role.chatSite ?? store.settings.defaultChatSite)
  return { label: siteLabel(site), className: `site-pill-${site}` }
}

function siteLabel(site: ChatSite): string {
  if (site === 'chatgpt') return 'ChatGPT'
  if (site === 'claude') return 'Claude'
  if (site === 'deepseek') return 'DeepSeek'
  if (site === 'kimi') return 'Kimi'
  if (site === 'qwen') return '千问'
  return 'Gemini'
}

function externalModelLabel(model: ExternalModelConfig | undefined): string {
  return model ? `API · ${model.name}` : 'API · 未配置'
}

function visibleChatSite(site: ChatSite): ChatSite {
  return ['gemini', 'chatgpt', 'claude', 'deepseek', 'kimi', 'qwen'].includes(site) ? site : 'gemini'
}

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}-${crypto.randomUUID()}`
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
