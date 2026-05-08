import type { PromptDelivery, PromptSender } from './promptDelivery'

export const DEFAULT_PROMPT_DELIVERY_RETRY_DELAYS_MS = [2_000, 2_000, 4_000, 8_000, 15_000] as const

export interface LatestPromptBinding {
  ready?: boolean
  tabId: number
  frameId: number
}

export interface PromptDeliveryRetryDependencies {
  log: {
    warn(event: string, details?: Record<string, unknown>): void
  }
  sendPrompt: PromptSender
  getLatestBinding(chatId: string, roleId: string): LatestPromptBinding | undefined
  isDeliveryStillActive(chatId: string, roleId: string, messageId: string, replyAttemptId: string | undefined): Promise<boolean>
  markDeliveryError(chatId: string, roleId: string, messageId: string, reason: string): Promise<void>
  waitForRetry?(ms: number): Promise<void>
}

export async function sendPromptDeliveryWithRetry(
  deps: PromptDeliveryRetryDependencies,
  input: {
    chatId: string
    messageId: string
    delivery: PromptDelivery
    retryDelaysMs?: readonly number[]
  },
): Promise<boolean> {
  const retryDelays = input.retryDelaysMs ?? DEFAULT_PROMPT_DELIVERY_RETRY_DELAYS_MS
  let lastReason = '发送失败'

  for (let attemptIndex = 0; attemptIndex <= retryDelays.length; attemptIndex += 1) {
    try {
      await deps.sendPrompt(withLatestPromptBinding(deps, input.chatId, input.delivery))
      return true
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error)
      const canRetry = attemptIndex < retryDelays.length && await deps.isDeliveryStillActive(
        input.chatId,
        input.delivery.roleId,
        input.messageId,
        input.delivery.message.replyAttemptId,
      )
      if (!canRetry) break

      const delayMs = retryDelays[attemptIndex] ?? 0
      deps.log.warn('delivery:retry-scheduled', {
        chatId: input.chatId,
        roleId: input.delivery.roleId,
        messageId: input.messageId,
        retryCount: attemptIndex + 1,
        delayMs,
        reason: lastReason,
      })
      await waitForRetryDelay(deps, delayMs)
    }
  }

  await deps.markDeliveryError(input.chatId, input.delivery.roleId, input.messageId, lastReason)
  return false
}

export function withLatestPromptBinding(
  deps: Pick<PromptDeliveryRetryDependencies, 'getLatestBinding'>,
  chatId: string,
  delivery: PromptDelivery,
): PromptDelivery {
  const binding = deps.getLatestBinding(chatId, delivery.roleId)
  if (!binding?.ready) return delivery
  return { ...delivery, tabId: binding.tabId, frameId: binding.frameId }
}

async function waitForRetryDelay(deps: Pick<PromptDeliveryRetryDependencies, 'waitForRetry'>, delayMs: number): Promise<void> {
  if (delayMs <= 0) return
  if (deps.waitForRetry) {
    await deps.waitForRetry(delayMs)
    return
  }
  await new Promise<void>(resolve => setTimeout(resolve, delayMs))
}
