import { buildUnsyncedContext } from '../group/contextSync'
import { parseGroupMentions } from '../group/mentionParser'
import { buildPrompt } from '../group/promptBuilder'
import type { GroupChat, GroupMessage, GroupRole, MessageReference, OpenTeamStore, RuntimeFrameBinding } from '../group/types'
import type { BackgroundMessageRoute } from './messageRouter'
import type { PromptDelivery, PromptSender } from './promptDelivery'
import type { RuntimeMessage } from './runtimeClient'
import type { RuntimeFrameRegistry } from './runtimeFrames'
import { getChatMessages, getChatRoles, mutateStore, requireChat, requireRole } from './storeAccess'

const STALE_THINKING_MS = 120_000

export const MESSAGE_ROUTE_TYPES = [
  'GROUP_ROLE_RETRY_REPLY',
  'GROUP_MESSAGE_SEND',
] as const

export interface MessageHandlersDependencies {
  broadcastStoreUpdated(store: OpenTeamStore, excludeTabId?: number): Promise<void> | void
  log: {
    debug(event: string, details?: Record<string, unknown>): void
    info(event: string, details?: Record<string, unknown>): void
    warn(event: string, details?: Record<string, unknown>): void
  }
  newId(prefix: string): string
  now(): number
  runtimeFrames: Pick<RuntimeFrameRegistry, 'getByRole'>
  sendError(reason: string): Promise<void> | void
  sendPrompt: PromptSender
}

export function createMessageHandlers(deps: MessageHandlersDependencies): BackgroundMessageRoute[] {
  const handleMessageSend = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const raw = requireString(message.raw, '消息内容不能为空')
    const timestamp = deps.now()
    deps.log.info('message-send:start', { chatId, rawLength: raw.length })

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const roles = getChatRoles(store, chat)
      const parsed = parseGroupMentions(raw, roles)
      if (!parsed.ok) throw new Error(parsed.error)
      if (parsed.targetRoleIds.length === 0) throw new Error('当前群聊没有可投递人员')
      deps.log.debug('message-send:parsed-targets', { chatId: chat.id, targetRoleIds: parsed.targetRoleIds })

      const targetRoles = parsed.targetRoleIds.map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role))
      const unavailable = targetRoles.filter(role => !isRoleDeliverable(role, deps.runtimeFrames.getByRole(chat.id, role.id), timestamp))

      if (unavailable.length > 0) {
        deps.log.warn('message-send:unavailable-targets', {
          chatId: chat.id,
          targets: unavailable.map(role => ({
            id: role.id,
            name: role.name,
            status: role.status,
            updatedAt: role.updatedAt,
            staleThinking: isStaleThinkingRole(role, timestamp),
            binding: deps.runtimeFrames.getByRole(chat.id, role.id),
          })),
        })
        throw new Error(`以下人员不可用，请等待或恢复：${unavailable.map(role => role.name).join('、')}`)
      }

      for (const role of targetRoles) recoverDeliverableRoleStatus(role, timestamp, deps.log)

      const reference = resolveReference(store, chat, message.reference ?? (Array.isArray(message.references) ? message.references[0] : undefined), deps.newId)
      const userMessage: GroupMessage = {
        id: deps.newId('msg'),
        chatId: chat.id,
        seq: chat.nextMessageSeq,
        type: 'user',
        content: parsed.content,
        targetRoleIds: parsed.targetRoleIds,
        mentionedRoleIds: parsed.mentionedRoleIds.length > 0 ? parsed.mentionedRoleIds : undefined,
        references: reference ? [reference] : undefined,
        createdAt: timestamp,
        status: 'pending',
        deliveryStatus: Object.fromEntries(parsed.targetRoleIds.map(roleId => [roleId, 'pending'])),
      }

      store.messagesById[userMessage.id] = userMessage
      chat.messageIds.push(userMessage.id)
      chat.nextMessageSeq += 1
      deps.log.info('message-send:stored', { chatId: chat.id, messageId: userMessage.id, targetCount: parsed.targetRoleIds.length })
      chat.status = 'running'
      chat.updatedAt = timestamp

      const messages = getChatMessages(store, chat)
      const deliveries: PromptDelivery[] = parsed.targetRoleIds.map(roleId => {
        const role = requireRole(store, chat.id, roleId)
        const binding = deps.runtimeFrames.getByRole(chat.id, role.id)!
        const unsyncedContext = buildUnsyncedContext(chat, role, messages, userMessage, store.settings.maxContextChars)
        const roleHistoryCount = countLocalRoleHistory(messages, role, userMessage.id)
        const includesPersona = shouldIncludePersonaForPrompt(roleHistoryCount)
        const content = buildPrompt({ chat, role, userMessage, roles, unsyncedContext, reference, includePersona: includesPersona })
        const replyAttemptId = deps.newId('attempt')
        if (!includesPersona) {
          deps.log.debug('prompt:persona-skipped', {
            chatId: chat.id,
            roleId: role.id,
            messageId: userMessage.id,
            conversationUrlPresent: Boolean(role.geminiConversationUrl),
            contextCursor: role.contextCursor,
            roleHistoryCount,
            personaLength: readPersonaLength(role),
          })
        }

        role.status = 'thinking'
        role.lastPromptMessageId = userMessage.id
        role.replyAttemptId = replyAttemptId
        role.updatedAt = timestamp

        return {
          roleId,
          tabId: binding.tabId,
          frameId: binding.frameId,
          message: { type: 'TEAM_SEND_PROMPT', chatId: chat.id, roleId, messageId: userMessage.id, replyAttemptId, content, includesPersona },
        }
      })

      return { message: userMessage, deliveries }
    })

    deps.log.info('message-send:deliveries-ready', {
      chatId,
      messageId: result.message.id,
      deliveries: result.deliveries.map(delivery => ({ roleId: delivery.roleId, tabId: delivery.tabId, frameId: delivery.frameId, contentLength: delivery.message.content.length })),
    })
    await deps.broadcastStoreUpdated(store)

    for (const delivery of result.deliveries) {
      try {
        await deps.sendPrompt(delivery)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await markDeliveryError(deps, chatId, delivery.roleId, result.message.id, reason)
      }
    }

    return { ok: true, message: result.message, deliveries: result.deliveries.map(delivery => ({ roleId: delivery.roleId })), store }
  }

  const handleRoleRetryReply = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const roleId = requireString(message.roleId, '缺少人员 ID')
    const timestamp = deps.now()
    const binding = deps.runtimeFrames.getByRole(chatId, roleId)
    if (!binding?.ready) throw new Error('人员 iframe 尚未就绪，请先恢复人员')

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      const requestedMessageId = readOptionalString(message.messageId)
      const userMessage = resolveRetryUserMessage(store, chat, role, requestedMessageId, deps.log)
      if (!userMessage) throw new Error(requestedMessageId ? '该消息没有发送给这个人员' : '找不到可重试的用户消息')

      const roles = getChatRoles(store, chat)
      const messages = getChatMessages(store, chat)
      const reference = userMessage.references?.[0]
      const unsyncedContext = buildUnsyncedContext(chat, role, messages, userMessage, store.settings.maxContextChars)
      const roleHistoryCount = countLocalRoleHistory(messages, role, userMessage.id)
      const includesPersona = shouldIncludePersonaForPrompt(roleHistoryCount)
      const content = buildPrompt({ chat, role, userMessage, roles, unsyncedContext, reference, includePersona: includesPersona })
      const replyAttemptId = deps.newId('attempt')

      userMessage.deliveryStatus ??= {}
      userMessage.deliveryStatus[role.id] = 'pending'
      userMessage.status = 'pending'
      role.status = 'thinking'
      role.lastPromptMessageId = userMessage.id
      role.replyAttemptId = replyAttemptId
      role.updatedAt = timestamp
      chat.status = 'running'
      chat.updatedAt = timestamp

      return {
        delivery: {
          roleId,
          tabId: binding.tabId,
          frameId: binding.frameId,
          message: { type: 'TEAM_SEND_PROMPT' as const, chatId: chat.id, roleId, messageId: userMessage.id, replyAttemptId, content, includesPersona },
        },
      }
    })

    deps.log.info('role-retry-reply:deliver', {
      chatId,
      roleId,
      messageId: result.delivery.message.messageId,
      replyAttemptId: result.delivery.message.replyAttemptId,
      tabId: result.delivery.tabId,
      frameId: result.delivery.frameId,
    })
    await deps.broadcastStoreUpdated(store)
    try {
      await deps.sendPrompt(result.delivery)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await markDeliveryError(deps, chatId, roleId, result.delivery.message.messageId, reason)
    }
    return { ok: true, store, messageId: result.delivery.message.messageId }
  }

  return [
    { type: 'GROUP_ROLE_RETRY_REPLY', handler: handleRoleRetryReply },
    { type: 'GROUP_MESSAGE_SEND', handler: handleMessageSend },
  ]
}

async function markDeliveryError(deps: MessageHandlersDependencies, chatId: string, roleId: string, messageId: string, reason: string): Promise<void> {
  deps.log.warn('delivery:error', { chatId, roleId, messageId, reason })
  const { store } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const role = requireRole(store, chat.id, roleId)
    role.status = 'error'
    role.updatedAt = deps.now()
    if (role.lastPromptMessageId === messageId) delete role.lastPromptMessageId
    delete role.replyAttemptId

    const userMessage = store.messagesById[messageId]
    if (userMessage?.deliveryStatus) {
      userMessage.deliveryStatus[roleId] = 'error'
      userMessage.status = 'error'
    }
    chat.status = 'error'
    chat.updatedAt = role.updatedAt
  })
  await deps.broadcastStoreUpdated(store)
  await deps.sendError(reason)
}

function isStaleThinkingRole(role: GroupRole, timestamp: number): boolean {
  return role.status === 'thinking' && timestamp - role.updatedAt >= STALE_THINKING_MS
}

function isRoleDeliverable(role: GroupRole, binding: RuntimeFrameBinding | undefined, timestamp: number): boolean {
  if (!binding?.ready) return false
  return role.status === 'ready' || role.status === 'error' || role.status === 'loading' || role.status === 'pending' || isStaleThinkingRole(role, timestamp)
}

function recoverDeliverableRoleStatus(role: GroupRole, timestamp: number, log: MessageHandlersDependencies['log']): void {
  if (role.status === 'ready') return

  log.warn('role:auto-recover-status', { roleId: role.id, roleName: role.name, previousStatus: role.status, lastPromptMessageId: role.lastPromptMessageId })
  role.status = 'ready'
  delete role.lastPromptMessageId
  delete role.replyAttemptId
  role.updatedAt = timestamp
}

function shouldIncludePersonaForPrompt(roleHistoryCount: number): boolean {
  return roleHistoryCount === 0
}

function countLocalRoleHistory(messages: GroupMessage[], role: GroupRole, currentMessageId: string): number {
  return messages.filter(message => message.id !== currentMessageId && isRoleHistoryMessage(message, role.id)).length
}

function isRoleHistoryMessage(message: GroupMessage, roleId: string): boolean {
  if (message.roleId === roleId) return true
  return Array.isArray(message.targetRoleIds) && message.targetRoleIds.includes(roleId)
}

function readPersonaLength(role: GroupRole): number {
  return (role.systemPrompt?.trim() || role.description?.trim() || role.name.trim()).length
}

function isUserMessageForRole(message: GroupMessage | undefined, chat: GroupChat, role: GroupRole): message is GroupMessage {
  return Boolean(
    message &&
      message.chatId === chat.id &&
      message.type === 'user' &&
      (!message.targetRoleIds || message.targetRoleIds.includes(role.id)),
  )
}

function isPendingRetryStatus(message: GroupMessage, role: GroupRole): boolean {
  const deliveryStatus = message.deliveryStatus?.[role.id]
  return deliveryStatus === 'pending' || deliveryStatus === 'sent'
}

function findLatestPendingRetryMessage(store: OpenTeamStore, chat: GroupChat, role: GroupRole): GroupMessage | undefined {
  for (const messageId of [...chat.messageIds].reverse()) {
    const message = store.messagesById[messageId]
    if (isUserMessageForRole(message, chat, role) && isPendingRetryStatus(message, role)) return message
  }
  return undefined
}

function resolveRetryUserMessage(
  store: OpenTeamStore,
  chat: GroupChat,
  role: GroupRole,
  requestedMessageId: string | undefined,
  log: MessageHandlersDependencies['log'],
): GroupMessage | undefined {
  if (requestedMessageId) {
    const requestedMessage = store.messagesById[requestedMessageId]
    return isUserMessageForRole(requestedMessage, chat, role) ? requestedMessage : undefined
  }

  const activePromptMessage = role.lastPromptMessageId ? store.messagesById[role.lastPromptMessageId] : undefined
  if (isUserMessageForRole(activePromptMessage, chat, role) && isPendingRetryStatus(activePromptMessage, role)) return activePromptMessage

  const latestPendingMessage = findLatestPendingRetryMessage(store, chat, role)
  if (latestPendingMessage && role.lastPromptMessageId && latestPendingMessage.id !== role.lastPromptMessageId) {
    log.warn('role-retry-reply:stale-prompt-pointer', {
      chatId: chat.id,
      roleId: role.id,
      staleMessageId: role.lastPromptMessageId,
      retryMessageId: latestPendingMessage.id,
    })
  }
  return latestPendingMessage
}

function resolveReference(store: OpenTeamStore, chat: GroupChat, raw: unknown, newId: (prefix: string) => string): MessageReference | undefined {
  if (!isRecord(raw)) return undefined

  const messageId = readOptionalString(raw.messageId)
  if (messageId) {
    const message = store.messagesById[messageId]
    if (message && message.chatId === chat.id) {
      return {
        messageId: message.id,
        roleId: message.roleId,
        roleName: message.roleName,
        contentSnapshot: message.content,
      }
    }
  }

  const contentSnapshot = readOptionalString(raw.contentSnapshot)
  if (!contentSnapshot) return undefined
  return {
    messageId: messageId ?? newId('ref'),
    roleId: readOptionalString(raw.roleId),
    roleName: readOptionalString(raw.roleName),
    contentSnapshot,
  }
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
