import { buildOrchestrationReviewPrompt, buildOrchestrationRolePrompt } from '../group/orchestrationPrompts'
import { parseReviewDecision } from '../group/orchestrationReview'
import {
  DEFAULT_ORCHESTRATION_MAX_ROUNDS,
  MAX_ORCHESTRATION_MAX_ROUNDS,
  type ExternalModelConfig,
  type GroupChat,
  type GroupMessage,
  type GroupRole,
  type OpenTeamStore,
  type OrchestrationFlow,
  type OrchestrationGraphSnapshot,
  type OrchestrationReviewResult,
  type OrchestrationRun,
  type OrchestrationStage,
  type OrchestrationStageRun,
} from '../group/types'
import type { ExternalModelClient } from './externalModelClient'
import type { PromptDelivery, PromptSender } from './promptDelivery'
import type { RuntimeFrameRegistry } from './runtimeFrames'
import { getChatMessages, getChatRoles, mutateStore, requireChat, requireRole } from './storeAccess'

interface ExternalPromptDelivery {
  roleId: string
  chatId: string
  messageId: string
  replyAttemptId: string
  model: ExternalModelConfig
  prompt: string
}

export interface OrchestrationRuntimeDependencies {
  broadcastStoreUpdated(store: OpenTeamStore, excludeTabId?: number): Promise<void> | void
  getChatStatusFromRoles(store: OpenTeamStore, chat: GroupChat): GroupChat['status']
  log: {
    info(event: string, details?: Record<string, unknown>): void
    warn(event: string, details?: Record<string, unknown>): void
  }
  newId(prefix: string): string
  now(): number
  runtimeFrames: Pick<RuntimeFrameRegistry, 'getByRole'>
  sendPrompt: PromptSender
  externalModelClient?: ExternalModelClient
}

interface StartStageResult {
  store: OpenTeamStore
  deliveries: PromptDelivery[]
  externalDeliveries: ExternalPromptDelivery[]
}

type NextStageDecision = { next: true; runId: string; stageIndices: number[] } | { next: false }

export async function startOrchestrationRun(deps: OrchestrationRuntimeDependencies, input: { chatId: string; flowId: string; task: string; maxRounds?: number }): Promise<{ store: OpenTeamStore; run: OrchestrationRun }> {
  const timestamp = deps.now()
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, input.chatId)
    const flow = requireFlow(store, chat.id, input.flowId)
    validateExecutableFlow(store, chat, flow)
    const activeRunId = store.activeOrchestrationRunIdByChatId[chat.id]
    const activeRun = activeRunId ? store.orchestrationRunsById[activeRunId] : undefined
    if (activeRun && (activeRun.status === 'pending' || activeRun.status === 'running')) throw new Error('该群聊已有运行中的编排')
    if (activeRunId && !activeRun) delete store.activeOrchestrationRunIdByChatId[chat.id]

    const maxRounds = normalizeMaxRounds(input.maxRounds ?? flow.maxRounds)
    const taskMessage: GroupMessage = {
      id: deps.newId('msg'),
      chatId: chat.id,
      seq: chat.nextMessageSeq,
      type: 'user',
      content: input.task.trim(),
      targetRoleIds: [],
      mentionedRoleIds: [],
      mentionsAll: false,
      orchestrationKind: 'task',
      createdAt: timestamp,
      status: 'received',
    }
    if (!taskMessage.content) throw new Error('编排任务不能为空')

    const run: OrchestrationRun = {
      id: deps.newId('run'),
      chatId: chat.id,
      flowId: flow.id,
      status: 'running',
      currentRound: 1,
      maxRounds,
      stageRuns: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    taskMessage.orchestrationRunId = run.id
    taskMessage.orchestrationRound = 1

    store.messagesById[taskMessage.id] = taskMessage
    chat.messageIds.push(taskMessage.id)
    chat.nextMessageSeq += 1
    store.orchestrationRunsById[run.id] = run
    store.activeOrchestrationRunIdByChatId[chat.id] = run.id
    chat.status = 'running'
    chat.updatedAt = timestamp
    return { run, stageIndices: rootStageIndices(flow) }
  })

  await deps.broadcastStoreUpdated(store)
  await startStages(deps, result.run.id, result.stageIndices)
  const latest = await mutateStore(store => store.orchestrationRunsById[result.run.id])
  return { store: latest.store, run: latest.result }
}

export async function stopOrchestrationRun(deps: OrchestrationRuntimeDependencies, chatId: string): Promise<{ store: OpenTeamStore; run?: OrchestrationRun }> {
  const timestamp = deps.now()
  const active = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const runId = store.activeOrchestrationRunIdByChatId[chat.id]
    const run = runId ? store.orchestrationRunsById[runId] : undefined
    if (!run) return undefined
    run.status = 'stopped'
    run.updatedAt = timestamp
    run.completedAt = timestamp
    for (const stageRun of run.stageRuns) {
      if (stageRun.status === 'running' || stageRun.status === 'pending' || stageRun.status === 'error') {
        stageRun.status = 'skipped'
        stageRun.completedAt = timestamp
        for (const roleRun of Object.values(stageRun.roleRuns)) {
          if (roleRun.status === 'running' || roleRun.status === 'pending' || roleRun.status === 'error') {
            roleRun.status = 'skipped'
            roleRun.completedAt = timestamp
          }
        }
      }
    }
    delete store.activeOrchestrationRunIdByChatId[chat.id]
    for (const role of getChatRoles(store, chat)) {
      if (role.status === 'thinking') {
        role.status = 'stopped'
        delete role.lastPromptMessageId
        delete role.replyAttemptId
        role.updatedAt = timestamp
      }
    }
    chat.status = deps.getChatStatusFromRoles(store, chat)
    chat.updatedAt = timestamp
    return run
  })
  await deps.broadcastStoreUpdated(active.store)
  return { store: active.store, run: active.result }
}

export async function maybeAdvanceOrchestrationRun(deps: OrchestrationRuntimeDependencies, input: { chatId: string; roleId: string; promptMessageId?: string; replyMessage?: GroupMessage }): Promise<OpenTeamStore | undefined> {
  if (!input.promptMessageId) return undefined
  const promptMessageId = input.promptMessageId
  const timestamp = deps.now()
  const advance = await mutateStore(store => {
    const chat = requireChat(store, input.chatId)
    const activeRunId = store.activeOrchestrationRunIdByChatId[chat.id]
    const run = activeRunId ? store.orchestrationRunsById[activeRunId] : undefined
    if (!run || run.status !== 'running') return { next: false as const }
    const stageRun = findRunningStageRunForRolePrompt(run, input.roleId, promptMessageId)
    if (!stageRun || stageRun.status !== 'running') return { next: false as const }
    const roleRun = stageRun.roleRuns[input.roleId]
    if (!roleRun || roleRun.messageId !== promptMessageId || roleRun.status !== 'running') return { next: false as const }
    if (input.replyMessage) {
      const persistedReply = store.messagesById[input.replyMessage.id]
      if (persistedReply) {
        persistedReply.orchestrationRunId = run.id
        persistedReply.orchestrationRound = stageRun.round
        persistedReply.orchestrationStageId = stageRun.stageId
        persistedReply.orchestrationStageIndex = stageRun.stageIndex
      }
    }

    roleRun.status = 'completed'
    roleRun.completedAt = timestamp
    run.updatedAt = timestamp

    if (stageRun.kind === 'review') {
      const reply = input.replyMessage
      if (!reply) return { next: false as const }
      const parsed = parseReviewDecision(reply.content)
      if (!parsed.ok) {
        roleRun.status = 'error'
        roleRun.error = parsed.error
        stageRun.status = 'error'
        run.status = 'error'
        run.error = parsed.error
        run.updatedAt = timestamp
        chat.status = 'error'
        chat.updatedAt = timestamp
        return { next: false as const }
      }
      stageRun.reviewResults ??= []
      stageRun.reviewResults.push({
        round: stageRun.round,
        stageRunId: stageRun.stageId,
        reviewerRoleId: input.roleId,
        messageId: reply.id,
        ...parsed.decision,
        createdAt: timestamp,
      })
      stageRun.status = 'completed'
      stageRun.completedAt = timestamp
      return applyReviewDecision(store, chat, run, parsed.decision.decision, timestamp)
    }

    if (!allRoleRunsFinished(stageRun)) return { next: false as const }
    stageRun.status = 'completed'
    stageRun.completedAt = timestamp
    return nextStageDecision(store, chat, run, timestamp)
  })

  await deps.broadcastStoreUpdated(advance.store)
  if (advance.result.next) await startStages(deps, advance.result.runId, advance.result.stageIndices)
  return advance.store
}

export async function markOrchestrationRoleError(deps: OrchestrationRuntimeDependencies, input: { chatId: string; roleId: string; promptMessageId?: string; error: string }): Promise<OpenTeamStore | undefined> {
  if (!input.promptMessageId) return undefined
  const promptMessageId = input.promptMessageId
  const timestamp = deps.now()
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, input.chatId)
    const activeRunId = store.activeOrchestrationRunIdByChatId[chat.id]
    const run = activeRunId ? store.orchestrationRunsById[activeRunId] : undefined
    if (!run || run.status !== 'running') return false
    const stageRun = findRunningStageRunForRolePrompt(run, input.roleId, promptMessageId)
    const roleRun = stageRun?.roleRuns[input.roleId]
    if (!stageRun || !roleRun || roleRun.messageId !== promptMessageId || roleRun.status !== 'running') return false
    roleRun.status = 'error'
    roleRun.error = input.error
    roleRun.completedAt = timestamp
    stageRun.status = 'error'
    run.status = 'error'
    run.error = input.error
    run.updatedAt = timestamp
    chat.status = 'error'
    chat.updatedAt = timestamp
    return true
  })
  if (result) await deps.broadcastStoreUpdated(store)
  return result ? store : undefined
}

export async function retryOrchestrationStage(deps: OrchestrationRuntimeDependencies, chatId: string, stageId?: string): Promise<{ store: OpenTeamStore }> {
  const timestamp = deps.now()
  const prepared = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const run = requireActiveRun(store, chat)
    const stageRun = findRetryableStageRun(run, stageId)
    if (!stageRun) throw new Error('找不到可重试的编排阶段')
    removeStageRunAndFollowing(run, stageRun)
    run.status = 'running'
    delete run.error
    run.updatedAt = timestamp
    chat.status = 'running'
    chat.updatedAt = timestamp
    return { runId: run.id, stageIndex: stageRun.stageIndex }
  })
  await deps.broadcastStoreUpdated(prepared.store)
  await startStage(deps, prepared.result.runId, prepared.result.stageIndex)
  return { store: prepared.store }
}

export async function skipOrchestrationStage(deps: OrchestrationRuntimeDependencies, chatId: string, stageId?: string): Promise<{ store: OpenTeamStore }> {
  const timestamp = deps.now()
  const advance = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const run = requireActiveRun(store, chat)
    const stageRun = findRetryableStageRun(run, stageId)
    if (!stageRun) throw new Error('找不到可跳过的编排阶段')
    stageRun.status = 'skipped'
    stageRun.completedAt = timestamp
    for (const roleRun of Object.values(stageRun.roleRuns)) {
      if (roleRun.status !== 'completed') {
        roleRun.status = 'skipped'
        roleRun.completedAt = timestamp
      }
    }
    run.status = 'running'
    delete run.error
    run.updatedAt = timestamp
    return nextStageDecision(store, chat, run, timestamp)
  })
  await deps.broadcastStoreUpdated(advance.store)
  if (advance.result.next) await startStages(deps, advance.result.runId, advance.result.stageIndices)
  return { store: advance.store }
}

export async function retryOrchestrationReview(deps: OrchestrationRuntimeDependencies, chatId: string): Promise<{ store: OpenTeamStore }> {
  return retryOrchestrationStage(deps, chatId)
}

async function startStages(deps: OrchestrationRuntimeDependencies, runId: string, stageIndices: number[]): Promise<void> {
  for (const stageIndex of uniqueNumbers(stageIndices)) {
    await startStage(deps, runId, stageIndex)
  }
}

async function startStage(deps: OrchestrationRuntimeDependencies, runId: string, stageIndex: number): Promise<StartStageResult> {
  const timestamp = deps.now()
  const prepared = await mutateStore(store => {
    const run = store.orchestrationRunsById[runId]
    if (!run || run.status !== 'running') return { deliveries: [], externalDeliveries: [] }
    const chat = requireChat(store, run.chatId)
    if (store.activeOrchestrationRunIdByChatId[chat.id] !== run.id) return { deliveries: [], externalDeliveries: [] }
    const flow = requireFlow(store, chat.id, run.flowId)
    const stage = flow.stages[stageIndex]
    if (!stage) {
      completeRun(store, chat, run, timestamp)
      return { deliveries: [], externalDeliveries: [] }
    }

    const taskMessage = getRunTaskMessage(store, chat, run)
    if (!taskMessage) throw new Error('找不到编排任务消息')
    const promptMessage = createStagePromptMessage(deps, store, chat, run, flow, stage, stageIndex, taskMessage.content, timestamp)
    const targetRoleIds = stage.kind === 'review' ? [firstReviewerRoleId(stage)] : stage.roleIds
    promptMessage.targetRoleIds = targetRoleIds
    promptMessage.deliveryStatus = Object.fromEntries(targetRoleIds.map(roleId => [roleId, 'pending' as const]))
    promptMessage.status = targetRoleIds.length > 0 ? 'pending' : 'received'
    store.messagesById[promptMessage.id] = promptMessage
    chat.messageIds.push(promptMessage.id)
    chat.nextMessageSeq += 1

    const stageRun: OrchestrationStageRun = {
      stageId: stage.id,
      stageIndex,
      kind: stage.kind,
      round: run.currentRound,
      status: 'running',
      roleRuns: {},
      startedAt: timestamp,
    }
    run.stageRuns.push(stageRun)
    run.updatedAt = timestamp
    chat.status = 'running'
    chat.updatedAt = timestamp

    const deliveries: PromptDelivery[] = []
    const externalDeliveries: ExternalPromptDelivery[] = []
    for (const roleId of targetRoleIds) {
      const role = requireRole(store, chat.id, roleId)
      const replyAttemptId = deps.newId('attempt')
      stageRun.roleRuns[role.id] = { roleId: role.id, status: 'running', messageId: promptMessage.id, startedAt: timestamp }
      role.status = 'thinking'
      role.lastPromptMessageId = promptMessage.id
      role.replyAttemptId = replyAttemptId
      role.updatedAt = timestamp
      const rolePrompt = stage.kind === 'review'
        ? promptMessage.content
        : buildOrchestrationRolePrompt({
          userTask: taskMessage.content,
          flow,
          currentStage: stage,
          role,
          currentRound: run.currentRound,
          maxRounds: run.maxRounds,
          priorStageMessages: getPriorRoundMessages(store, chat, run),
          previousReviewResult: lastReviewResult(run),
          maxContextChars: store.settings.maxContextChars,
        })
      if (isExternalModelRole(role)) {
        const model = requireExternalModelForRole(store, role)
        externalDeliveries.push({ roleId: role.id, chatId: chat.id, messageId: promptMessage.id, replyAttemptId, model, prompt: rolePrompt })
      } else {
        const binding = deps.runtimeFrames.getByRole(chat.id, role.id)
        if (!binding?.ready) {
          stageRun.roleRuns[role.id].status = 'error'
          stageRun.roleRuns[role.id].error = '人员 iframe 尚未就绪，请先恢复人员'
          role.status = 'error'
          delete role.lastPromptMessageId
          delete role.replyAttemptId
          continue
        }
        deliveries.push({
          roleId: role.id,
          chatSite: role.chatSite ?? store.settings.defaultChatSite,
          tabId: binding.tabId,
          frameId: binding.frameId,
          message: { type: 'TEAM_SEND_PROMPT', chatId: chat.id, roleId: role.id, messageId: promptMessage.id, replyAttemptId, content: rolePrompt, includesPersona: true },
        })
      }
    }
    const failedRoleRun = Object.values(stageRun.roleRuns).find(roleRun => roleRun.status === 'error')
    if (failedRoleRun) {
      deliveries.length = 0
      externalDeliveries.length = 0
      stageRun.status = 'error'
      stageRun.completedAt = timestamp
      run.status = 'error'
      run.error = failedRoleRun.error ?? '阶段投递失败'
      chat.status = 'error'
    } else if (targetRoleIds.length === 0 || allRoleRunsFinished(stageRun)) {
      stageRun.status = targetRoleIds.length === 0 ? 'skipped' : 'error'
      stageRun.completedAt = timestamp
      if (stageRun.status === 'error') {
        run.status = 'error'
        run.error = '阶段没有可投递人员'
        chat.status = 'error'
      }
    }
    return { deliveries, externalDeliveries }
  })

  await deps.broadcastStoreUpdated(prepared.store)
  await Promise.all(prepared.result.deliveries.map(async delivery => {
    try {
      await deps.sendPrompt(delivery)
    } catch (error) {
      await markOrchestrationRoleError(deps, { chatId: delivery.message.chatId, roleId: delivery.roleId, promptMessageId: delivery.message.messageId, error: error instanceof Error ? error.message : String(error) })
    }
  }))
  for (const delivery of prepared.result.externalDeliveries) {
    sendExternalOrchestrationPrompt(deps, delivery).catch(error => {
      deps.log.warn('orchestration-external:failed', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, error: error instanceof Error ? error.message : String(error) })
    })
  }
  return { store: prepared.store, deliveries: prepared.result.deliveries, externalDeliveries: prepared.result.externalDeliveries }
}

async function sendExternalOrchestrationPrompt(deps: OrchestrationRuntimeDependencies, delivery: ExternalPromptDelivery): Promise<void> {
  const client = deps.externalModelClient
  if (!client) {
    await markOrchestrationRoleError(deps, { chatId: delivery.chatId, roleId: delivery.roleId, promptMessageId: delivery.messageId, error: '外部模型客户端不可用' })
    return
  }
  try {
    const result = await client.complete({ model: delivery.model, prompt: delivery.prompt })
    const timestamp = deps.now()
    const stored = await mutateStore(store => {
      const chat = requireChat(store, delivery.chatId)
      const role = requireRole(store, chat.id, delivery.roleId)
      const run = store.orchestrationRunsById[store.activeOrchestrationRunIdByChatId[chat.id]]
      const stageRun = run ? findRunningStageRunForRolePrompt(run, role.id, delivery.messageId) : undefined
      if (role.lastPromptMessageId !== delivery.messageId || role.replyAttemptId !== delivery.replyAttemptId) return undefined
      const reply: GroupMessage = {
        id: deps.newId('msg'),
        chatId: chat.id,
        seq: chat.nextMessageSeq,
        type: 'assistant',
        content: result.content,
        contentFormat: 'markdown',
        roleId: role.id,
        roleName: role.name,
        orchestrationRunId: run?.id,
        orchestrationRound: stageRun?.round,
        orchestrationStageId: stageRun?.stageId,
        orchestrationStageIndex: stageRun?.stageIndex,
        createdAt: timestamp,
        status: 'received',
      }
      store.messagesById[reply.id] = reply
      chat.messageIds.push(reply.id)
      chat.nextMessageSeq += 1
      const prompt = store.messagesById[delivery.messageId]
      if (prompt?.deliveryStatus?.[role.id]) prompt.deliveryStatus[role.id] = 'received'
      role.status = 'ready'
      role.lastReplyAt = timestamp
      role.updatedAt = timestamp
      delete role.lastPromptMessageId
      delete role.replyAttemptId
      chat.status = deps.getChatStatusFromRoles(store, chat)
      chat.updatedAt = timestamp
      return reply
    })
    await deps.broadcastStoreUpdated(stored.store)
    if (stored.result) await maybeAdvanceOrchestrationRun(deps, { chatId: delivery.chatId, roleId: delivery.roleId, promptMessageId: delivery.messageId, replyMessage: stored.result })
  } catch (error) {
    await markOrchestrationRoleError(deps, { chatId: delivery.chatId, roleId: delivery.roleId, promptMessageId: delivery.messageId, error: error instanceof Error ? error.message : String(error) })
  }
}

function createStagePromptMessage(deps: OrchestrationRuntimeDependencies, store: OpenTeamStore, chat: GroupChat, run: OrchestrationRun, flow: OrchestrationFlow, stage: OrchestrationStage, stageIndex: number, userTask: string, timestamp: number): GroupMessage {
  const content = stage.kind === 'review'
    ? buildOrchestrationReviewPrompt({ userTask, flow, currentStage: stage, currentRound: run.currentRound, maxRounds: run.maxRounds, currentRoundOutputs: getCurrentRoundOutputs(store, chat, run), maxContextChars: store.settings.maxContextChars })
    : `Orchestration stage ${stageIndex + 1}: ${stage.name}\nRound ${run.currentRound} / ${run.maxRounds}\n\n${userTask}`

  return {
    id: deps.newId('msg'),
    chatId: chat.id,
    seq: chat.nextMessageSeq,
    type: 'user',
    content,
    orchestrationRunId: run.id,
    orchestrationRound: run.currentRound,
    orchestrationStageId: stage.id,
    orchestrationStageIndex: stageIndex,
    orchestrationKind: stage.kind === 'review' ? 'review' : 'role',
    createdAt: timestamp,
    status: 'pending',
  }
}

function getPriorRoundMessages(store: OpenTeamStore, chat: GroupChat, run: OrchestrationRun): GroupMessage[] {
  const stageIds = new Set(run.stageRuns.filter(stageRun => stageRun.round === run.currentRound && stageRun.status === 'completed').map(stageRun => stageRun.stageId))
  return getChatMessages(store, chat).filter(message => message.type === 'assistant' && message.orchestrationRunId === run.id && message.orchestrationStageId && stageIds.has(message.orchestrationStageId))
}

function getCurrentRoundOutputs(store: OpenTeamStore, chat: GroupChat, run: OrchestrationRun): GroupMessage[] {
  return getChatMessages(store, chat).filter(message => message.type === 'assistant' && message.orchestrationRunId === run.id && message.orchestrationRound === run.currentRound)
}

function lastReviewResult(run: OrchestrationRun): OrchestrationReviewResult | undefined {
  for (const stageRun of [...run.stageRuns].reverse()) {
    const results = stageRun.reviewResults
    const result = results ? results[results.length - 1] : undefined
    if (result) return result
  }
  return undefined
}

function nextStageDecision(store: OpenTeamStore, chat: GroupChat, run: OrchestrationRun, timestamp: number, options: { allowNextRound?: boolean } = {}): NextStageDecision {
  const flow = requireFlow(store, chat.id, run.flowId)
  const readyStageIndices = findReadyStageIndices(flow, run)
  if (readyStageIndices.length > 0) return { next: true, runId: run.id, stageIndices: readyStageIndices }
  if (hasRunningStageRuns(run)) return { next: false }
  if (options.allowNextRound !== false && run.currentRound < run.maxRounds) {
    run.currentRound += 1
    run.updatedAt = timestamp
    return { next: true, runId: run.id, stageIndices: rootStageIndices(flow) }
  }
  completeRun(store, chat, run, timestamp)
  return { next: false }
}

function applyReviewDecision(store: OpenTeamStore, chat: GroupChat, run: OrchestrationRun, decision: 'pass' | 'continue' | 'stop', timestamp: number): NextStageDecision {
  if (decision === 'stop') {
    run.status = 'stopped'
    run.completedAt = timestamp
    delete store.activeOrchestrationRunIdByChatId[chat.id]
    chat.status = 'ready'
    chat.updatedAt = timestamp
    return { next: false }
  }
  if (decision === 'continue' && run.currentRound < run.maxRounds) {
    run.currentRound += 1
    run.updatedAt = timestamp
    const flow = requireFlow(store, chat.id, run.flowId)
    return { next: true, runId: run.id, stageIndices: rootStageIndices(flow) }
  }
  if (decision === 'continue' && run.currentRound >= run.maxRounds) {
    run.error = '已达到最大轮次，编排自动完成'
  }
  return nextStageDecision(store, chat, run, timestamp, { allowNextRound: decision !== 'pass' })
}

function completeRun(store: OpenTeamStore, chat: GroupChat, run: OrchestrationRun, timestamp: number): void {
  run.status = 'completed'
  run.completedAt = timestamp
  run.updatedAt = timestamp
  delete store.activeOrchestrationRunIdByChatId[chat.id]
  chat.status = 'ready'
  chat.updatedAt = timestamp
}

function requireFlow(store: OpenTeamStore, chatId: string, flowId: string): OrchestrationFlow {
  const flow = store.orchestrationFlowsById[flowId]
  if (!flow || flow.chatId !== chatId) throw new Error(`找不到编排流程：${flowId}`)
  return flow
}

function validateExecutableFlow(store: OpenTeamStore, chat: GroupChat, flow: OrchestrationFlow): void {
  if (!Array.isArray(flow.stages) || flow.stages.length === 0) throw new Error('编排流程没有可执行阶段')
  if (rootStageIndices(flow).length === 0) throw new Error('编排流程存在循环，无法找到起始节点')
  for (const stage of flow.stages) {
    if (stage.kind === 'roles' && stage.roleIds.length === 0) throw new Error(`角色阶段缺少人员：${stage.name}`)
    if (stage.kind === 'review' && stage.review?.reviewerRoleIds?.length !== 1) throw new Error(`复核阶段必须绑定一个复核人员：${stage.name}`)
    const roleIds = stage.kind === 'review' ? stage.review?.reviewerRoleIds ?? [] : stage.roleIds
    for (const roleId of roleIds) requireRole(store, chat.id, roleId)
  }
}

function normalizeMaxRounds(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ORCHESTRATION_MAX_ROUNDS
  return Math.min(MAX_ORCHESTRATION_MAX_ROUNDS, Math.max(1, Math.floor(value)))
}

function currentStageRun(run: OrchestrationRun): OrchestrationStageRun | undefined {
  return run.stageRuns[run.stageRuns.length - 1]
}

function findRunningStageRunForRolePrompt(run: OrchestrationRun, roleId: string, promptMessageId: string): OrchestrationStageRun | undefined {
  return run.stageRuns.find(stageRun => {
    const roleRun = stageRun.roleRuns[roleId]
    return stageRun.status === 'running' && roleRun?.messageId === promptMessageId && roleRun.status === 'running'
  })
}

function allRoleRunsFinished(stageRun: OrchestrationStageRun): boolean {
  const roleRuns = Object.values(stageRun.roleRuns)
  return roleRuns.length > 0 && roleRuns.every(roleRun => roleRun.status === 'completed' || roleRun.status === 'skipped')
}

function hasRunningStageRuns(run: OrchestrationRun): boolean {
  return run.stageRuns.some(stageRun => stageRun.round === run.currentRound && stageRun.status === 'running')
}

function findReadyStageIndices(flow: OrchestrationFlow, run: OrchestrationRun): number[] {
  const stageIndexById = new Map(flow.stages.map((stage, index) => [stage.id, index]))
  const incoming = incomingEdgesByTarget(flow)
  const started = new Set(run.stageRuns.filter(stageRun => stageRun.round === run.currentRound).map(stageRun => stageRun.stageId))
  const completed = new Set(run.stageRuns.filter(stageRun => stageRun.round === run.currentRound && (stageRun.status === 'completed' || stageRun.status === 'skipped')).map(stageRun => stageRun.stageId))
  const ready: number[] = []
  for (const stage of flow.stages) {
    if (started.has(stage.id)) continue
    const dependencies = incoming.get(stage.id) ?? []
    if (dependencies.every(stageId => completed.has(stageId))) {
      const index = stageIndexById.get(stage.id)
      if (typeof index === 'number') ready.push(index)
    }
  }
  return ready
}

function rootStageIndices(flow: OrchestrationFlow): number[] {
  const targetIds = new Set(effectiveGraphEdges(flow).map(edge => edge.targetStageId))
  return flow.stages.map((stage, index) => targetIds.has(stage.id) ? undefined : index).filter((index): index is number => typeof index === 'number')
}

function incomingEdgesByTarget(flow: OrchestrationFlow): Map<string, string[]> {
  const incoming = new Map<string, string[]>()
  for (const edge of effectiveGraphEdges(flow)) {
    incoming.set(edge.targetStageId, [...incoming.get(edge.targetStageId) ?? [], edge.sourceStageId])
  }
  return incoming
}

function effectiveGraphEdges(flow: OrchestrationFlow): OrchestrationGraphSnapshot['edges'] {
  const stageIds = new Set(flow.stages.map(stage => stage.id))
  const edges = flow.graph ? flow.graph.edges : flow.stages.slice(1).map((stage, index) => ({ sourceStageId: flow.stages[index].id, targetStageId: stage.id }))
  return edges.filter(edge => stageIds.has(edge.sourceStageId) && stageIds.has(edge.targetStageId) && edge.sourceStageId !== edge.targetStageId)
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)]
}

function requireActiveRun(store: OpenTeamStore, chat: GroupChat): OrchestrationRun {
  const runId = store.activeOrchestrationRunIdByChatId[chat.id]
  const run = runId ? store.orchestrationRunsById[runId] : undefined
  if (!run) throw new Error('该群聊没有运行中的编排')
  return run
}

function findRetryableStageRun(run: OrchestrationRun, stageId?: string): OrchestrationStageRun | undefined {
  const candidate = stageId ? [...run.stageRuns].reverse().find(stageRun => stageRun.stageId === stageId) : currentStageRun(run)
  if (!candidate || (candidate.status !== 'error' && candidate.status !== 'running')) return undefined
  return candidate
}

function removeStageRunAndFollowing(run: OrchestrationRun, stageRun: OrchestrationStageRun): void {
  const index = run.stageRuns.indexOf(stageRun)
  if (index >= 0) run.stageRuns.splice(index)
}

function firstReviewerRoleId(stage: OrchestrationStage): string {
  const roleId = stage.review?.reviewerRoleIds[0]
  if (!roleId) throw new Error(`复核阶段缺少复核人员：${stage.name}`)
  return roleId
}

function getRunTaskMessage(store: OpenTeamStore, chat: GroupChat, run: OrchestrationRun): GroupMessage | undefined {
  return getChatMessages(store, chat).find(message => message.orchestrationRunId === run.id && message.orchestrationKind === 'task')
}

function isExternalModelRole(role: GroupRole): boolean {
  return role.modelSource === 'external'
}

function requireExternalModelForRole(store: OpenTeamStore, role: GroupRole): ExternalModelConfig {
  if (!role.externalModelId) throw new Error(`找不到外部模型：${role.name}`)
  const model = store.settings.externalModelsById[role.externalModelId]
  if (!model) throw new Error(`找不到外部模型：${role.externalModelId}`)
  return model
}
