import type { OrchestrationFlow, OpenTeamStore } from '../group/types'
import type { BackgroundMessageRoute } from './messageRouter'
import { type RuntimeMessage } from './runtimeClient'
import { mutateStore, requireChat } from './storeAccess'
import {
  type OrchestrationRuntimeDependencies,
  retryOrchestrationReview,
  retryOrchestrationStage,
  skipOrchestrationStage,
  startOrchestrationRun,
  stopOrchestrationRun,
} from './orchestrationRuntime'

export interface OrchestrationHandlersDependencies extends OrchestrationRuntimeDependencies {
  broadcastStoreUpdated(store: OpenTeamStore, excludeTabId?: number): Promise<void> | void
}

export function createOrchestrationHandlers(deps: OrchestrationHandlersDependencies): BackgroundMessageRoute[] {
  const handleFlowSave = async (message: RuntimeMessage) => {
    const flow = requireFlowPayload(message.flow)
    const { store, result } = await persistFlowDraft(deps, flow)
    await deps.broadcastStoreUpdated(store)
    return { ok: true, flow: result, store }
  }

  const handleFlowDelete = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const flowId = requireString(message.flowId, '缺少编排流程 ID')
    const { store } = await mutateStore(store => {
      requireChat(store, chatId)
      delete store.orchestrationFlowsById[flowId]
      store.orchestrationFlowOrderByChatId[chatId] = (store.orchestrationFlowOrderByChatId[chatId] ?? []).filter(id => id !== flowId)
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  return [
    { type: 'GROUP_ORCHESTRATION_FLOW_SAVE', handler: handleFlowSave },
    { type: 'GROUP_ORCHESTRATION_FLOW_DELETE', handler: handleFlowDelete },
    {
      type: 'GROUP_ORCHESTRATION_RUN',
      handler: async message => {
        const chatId = requireString(message.chatId, '缺少群聊 ID')
        const submittedFlow = isRecord(message.flow) ? requireFlowPayload(message.flow) : undefined
        if (submittedFlow && submittedFlow.chatId !== chatId) throw new Error('编排流程不属于当前群聊')
        const flowId = submittedFlow ? (await persistFlowDraft(deps, submittedFlow)).result.id : requireString(message.flowId, '缺少编排流程 ID')
        const response = await startOrchestrationRun(deps, {
          chatId,
          flowId,
          task: requireString(message.task ?? message.raw, '编排任务不能为空'),
          maxRounds: typeof message.maxRounds === 'number' ? message.maxRounds : submittedFlow?.maxRounds,
        })
        return { ok: true, ...response }
      },
    },
    {
      type: 'GROUP_ORCHESTRATION_STOP',
      handler: async message => ({ ok: true, ...(await stopOrchestrationRun(deps, requireString(message.chatId, '缺少群聊 ID'))) }),
    },
    {
      type: 'GROUP_ORCHESTRATION_RETRY_STAGE',
      handler: async message => ({ ok: true, ...(await retryOrchestrationStage(deps, requireString(message.chatId, '缺少群聊 ID'), readOptionalString(message.stageId))) }),
    },
    {
      type: 'GROUP_ORCHESTRATION_SKIP_STAGE',
      handler: async message => ({ ok: true, ...(await skipOrchestrationStage(deps, requireString(message.chatId, '缺少群聊 ID'), readOptionalString(message.stageId))) }),
    },
    {
      type: 'GROUP_ORCHESTRATION_RETRY_REVIEW',
      handler: async message => ({ ok: true, ...(await retryOrchestrationReview(deps, requireString(message.chatId, '缺少群聊 ID'))) }),
    },
  ]
}

async function persistFlowDraft(deps: OrchestrationHandlersDependencies, flow: OrchestrationFlow) {
  const timestamp = deps.now()
  return mutateStore(store => {
    requireChat(store, flow.chatId)
    const normalized: OrchestrationFlow = {
      ...flow,
      name: flow.name.trim(),
      stages: flow.stages,
      maxRounds: normalizeMaxRounds(flow.maxRounds),
      createdAt: store.orchestrationFlowsById[flow.id]?.createdAt ?? flow.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    if (!normalized.name) throw new Error('编排流程名称不能为空')
    store.orchestrationFlowsById[normalized.id] = normalized
    const order = store.orchestrationFlowOrderByChatId[normalized.chatId] ?? []
    store.orchestrationFlowOrderByChatId[normalized.chatId] = order.includes(normalized.id) ? order : [...order, normalized.id]
    return normalized
  })
}

function requireFlowPayload(value: unknown): OrchestrationFlow {
  if (!isRecord(value)) throw new Error('编排流程格式无效')
  if (typeof value.id !== 'string' || typeof value.chatId !== 'string' || typeof value.name !== 'string') throw new Error('编排流程格式无效')
  if (!Array.isArray(value.stages)) throw new Error('编排流程节点格式无效')
  return value as unknown as OrchestrationFlow
}

function normalizeMaxRounds(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(50, Math.max(1, Math.floor(value)))
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

function requireString(value: unknown, error: string): string {
  const result = readOptionalString(value)
  if (!result) throw new Error(error)
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
