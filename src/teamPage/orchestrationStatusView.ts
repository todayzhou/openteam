import type { GroupChat, GroupRole, OpenTeamStore, OrchestrationFlow, OrchestrationRun, OrchestrationStageRun } from '../group/types'

export interface OrchestrationStatusViewDependencies {
  getStore(): OpenTeamStore
  getCurrentChat(): GroupChat | undefined
  getCurrentRoles(): GroupRole[]
  reconnectRolesForSend(chat: GroupChat, roles: GroupRole[]): Promise<void>
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
}

export interface OrchestrationStatusView {
  renderOrchestrationStatus(): HTMLElement | undefined
}

const STATUS_LABELS: Record<OrchestrationRun['status'], string> = {
  pending: '编排等待中',
  running: '编排运行中',
  completed: '编排已完成',
  stopped: '编排已停止',
  error: '编排出错',
}

export function createOrchestrationStatusView(deps: OrchestrationStatusViewDependencies): OrchestrationStatusView {
  function renderOrchestrationStatus(): HTMLElement | undefined {
    const chat = deps.getCurrentChat()
    if (!chat) return undefined
    const store = deps.getStore()
    const runId = store.activeOrchestrationRunIdByChatId[chat.id]
    const run = runId ? store.orchestrationRunsById[runId] : undefined
    if (!run) return undefined
    const flow = store.orchestrationFlowsById[run.flowId]
    if (!flow) return undefined

    const current = currentStageRun(run)
    const card = document.createElement('section')
    card.className = `orchestration-status orchestration-status-${run.status}`
    card.dataset.runId = run.id

    const header = document.createElement('div')
    header.className = 'orchestration-status-header'
    const title = document.createElement('div')
    title.className = 'orchestration-status-title'
    title.textContent = statusTitle(run, flow, current)
    header.append(title)

    const actions = renderActions(chat, run, current)
    if (actions) header.append(actions)
    card.append(header)

    const details = document.createElement('div')
    details.className = 'orchestration-status-details'
    const roleText = currentRoleText(current)
    if (roleText) details.append(detail('当前', roleText))
    const waitingText = waitingStageText(run, flow)
    if (waitingText) details.append(detail('等待', waitingText))
    if (run.status === 'error' && run.error) details.append(detail('错误', run.error, 'error'))
    if (details.childElementCount > 0) card.append(details)

    return card
  }

  function statusTitle(run: OrchestrationRun, flow: OrchestrationFlow, current: OrchestrationStageRun | undefined): string {
    const stageCount = flow.stages.length
    const step = current ? current.stageIndex + 1 : Math.min(run.stageRuns.length, stageCount)
    if (run.status === 'running') return `编排运行中 · 第 ${run.currentRound} 轮 · 第 ${Math.max(1, step)} 步 / 共 ${stageCount} 步`
    if (run.status === 'pending') return `编排等待中 · 第 ${run.currentRound} 轮 · 第 ${Math.max(1, step)} 步 / 共 ${stageCount} 步`
    return `${STATUS_LABELS[run.status]} · 第 ${run.currentRound} 轮 · ${run.stageRuns.length} / ${stageCount} 步`
  }

  function currentRoleText(current: OrchestrationStageRun | undefined): string | undefined {
    if (!current) return undefined
    const rolesById = new Map(deps.getCurrentRoles().map(role => [role.id, role.name]))
    const running = Object.values(current.roleRuns)
      .filter(roleRun => roleRun.status === 'running')
      .map(roleRun => rolesById.get(roleRun.roleId) ?? roleRun.roleId)
    if (running.length > 0) return running.join('、')
    if (current.status === 'running') return current.kind === 'review' ? '复核中' : '节点执行中'
    if (current.status === 'error') return current.kind === 'review' ? '复核失败' : '节点失败'
    return undefined
  }

  function waitingStageText(run: OrchestrationRun, flow: OrchestrationFlow): string | undefined {
    if (run.status !== 'running' && run.status !== 'pending') return undefined
    const current = currentStageRun(run)
    const nextIndex = current ? current.stageIndex + 1 : run.stageRuns.length
    const waiting = flow.stages.slice(nextIndex).map(stage => stage.name)
    return waiting.length > 0 ? waiting.join('、') : undefined
  }

  function renderActions(chat: GroupChat, run: OrchestrationRun, current: OrchestrationStageRun | undefined): HTMLElement | undefined {
    const actions = document.createElement('div')
    actions.className = 'orchestration-status-actions'
    if (run.status === 'running' || run.status === 'pending') {
      actions.append(actionButton('停止', 'btn-danger', () => runAction('GROUP_ORCHESTRATION_STOP', { chatId: chat.id })))
    }
    if ((run.status === 'error' || current?.status === 'error') && current) {
      if (current.kind === 'review') {
        actions.append(actionButton('重试复核', 'btn-primary', () => retryAction(chat, current, 'GROUP_ORCHESTRATION_RETRY_REVIEW', { chatId: chat.id })))
      } else {
        actions.append(actionButton('重试节点', 'btn-primary', () => retryAction(chat, current, 'GROUP_ORCHESTRATION_RETRY_STAGE', { chatId: chat.id, stageId: current.stageId })))
      }
      actions.append(actionButton('跳过节点', 'btn-ghost', () => runAction('GROUP_ORCHESTRATION_SKIP_STAGE', { chatId: chat.id, stageId: current.stageId })))
    }
    return actions.childElementCount > 0 ? actions : undefined
  }

  function actionButton(label: string, extraClass: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `btn ${extraClass}`
    button.textContent = label
    button.addEventListener('click', onClick)
    return button
  }

  function runAction(type: string, payload: Record<string, unknown>): void {
    deps.runCommand(type, payload).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
  }

  function retryAction(chat: GroupChat, current: OrchestrationStageRun, type: string, payload: Record<string, unknown>): void {
    deps.reconnectRolesForSend(chat, getStageRoles(current))
      .then(() => deps.runCommand(type, payload))
      .catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
  }

  function getStageRoles(current: OrchestrationStageRun): GroupRole[] {
    const rolesById = new Map(deps.getCurrentRoles().map(role => [role.id, role]))
    return Object.keys(current.roleRuns).map(roleId => rolesById.get(roleId)).filter((role): role is GroupRole => Boolean(role))
  }

  function detail(label: string, value: string, tone?: 'error'): HTMLElement {
    const item = document.createElement('div')
    item.className = `orchestration-status-detail${tone ? ` ${tone}` : ''}`
    const labelEl = document.createElement('span')
    labelEl.className = 'orchestration-status-detail-label'
    labelEl.textContent = label
    const valueEl = document.createElement('span')
    valueEl.textContent = value
    item.append(labelEl, valueEl)
    return item
  }

  return { renderOrchestrationStatus }
}

function currentStageRun(run: OrchestrationRun): OrchestrationStageRun | undefined {
  return [...run.stageRuns].reverse().find(stageRun => stageRun.status === 'running' || stageRun.status === 'error') ?? run.stageRuns[run.stageRuns.length - 1]
}
