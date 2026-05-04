import { buildUnsyncedContext } from '../group/contextSync'
import { extractSupportedConversationId, normalizeSupportedChatConversationUrl } from '../group/conversationUrl'
import { parseGroupMentions } from '../group/mentionParser'
import { buildPrompt } from '../group/promptBuilder'
import { mapRuntimeRoleStatus } from '../group/runtimeProtocol'
import type { BackgroundToRoleMessage } from '../group/runtimeProtocol'
import type { GroupChat, GroupMessage, GroupRole, MessageReference, OpenTeamStore, RuntimeFrameBinding } from '../group/types'
import type { BackgroundMessageRoute } from './messageRouter'
import type { PromptDelivery, PromptSender } from './promptDelivery'
import { messageTabId, rememberHost, senderFrameId, senderTabId, type RuntimeMessage } from './runtimeClient'
import type { RuntimeFrameRegistry } from './runtimeFrames'
import { getChatMessages, getChatRoles, mutateStore, requireChat, requireRole } from './storeAccess'

const STALE_THINKING_MS = 120_000

export const MESSAGE_ROUTE_TYPES = [
  'GROUP_ROLE_RETRY_REPLY',
  'GROUP_ROLE_STOP_REPLY',
  'GROUP_NOTE_SAVE',
  'GROUP_MESSAGE_HIGHLIGHT_CREATE',
  'GROUP_MESSAGE_RESYNC_REPLY',
  'GROUP_MESSAGE_SEND',
  'TEAM_FRAME_ROLE_READY',
  'TEAM_ROLE_CONVERSATION_UPDATED',
  'TEAM_SEND_ACK',
  'TEAM_ROLE_STATUS',
  'TEAM_ROLE_REPLY',
  'TEAM_ROLE_REPLY_RESYNC',
  'TEAM_ROLE_ERROR',
] as const

export interface MessageHandlersDependencies {
  broadcastStoreUpdated(store: OpenTeamStore, excludeTabId?: number): Promise<void> | void
  getChatStatusFromRoles(store: OpenTeamStore, chat: GroupChat): GroupChat['status']
  log: {
    debug(event: string, details?: Record<string, unknown>): void
    info(event: string, details?: Record<string, unknown>): void
    warn(event: string, details?: Record<string, unknown>): void
  }
  newId(prefix: string): string
  now(): number
  runtimeFrames: Pick<RuntimeFrameRegistry, 'bind' | 'getByAddress' | 'getByRole'>
  sendRoleMessage(tabId: number, frameId: number, message: BackgroundToRoleMessage): Promise<unknown>
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

  const handleRoleStopReply = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const roleId = requireString(message.roleId, '缺少人员 ID')
    const binding = deps.runtimeFrames.getByRole(chatId, roleId)
    if (!binding?.ready) throw new Error('人员 iframe 尚未就绪，无法停止回复')

    const { result: active } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      if (role.status !== 'thinking' || !role.lastPromptMessageId) throw new Error('该人员当前没有正在回复的任务')
      return {
        messageId: role.lastPromptMessageId,
        replyAttemptId: role.replyAttemptId,
      }
    })

    const response = await deps.sendRoleMessage(binding.tabId, binding.frameId, {
      type: 'TEAM_STOP_GENERATION',
      chatId,
      roleId,
      messageId: active.messageId,
      replyAttemptId: active.replyAttemptId,
    })
    if (isRecord(response) && response.ok === false) throw new Error(readOptionalString(response.error) ?? '停止回复失败')

    const timestamp = deps.now()
    const { store } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      if (role.lastPromptMessageId !== active.messageId) return
      role.status = 'stopped'
      role.replyAttemptId = deps.newId('stopped')
      role.updatedAt = timestamp
      chat.status = deps.getChatStatusFromRoles(store, chat)
      chat.updatedAt = timestamp
    })
    deps.log.info('role-stop-reply:stopped', { chatId, roleId, messageId: active.messageId, tabId: binding.tabId, frameId: binding.frameId })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store, messageId: active.messageId }
  }

  const handleNoteSave = async (message: RuntimeMessage) => {
    const scope = readOptionalString(message.scope)
    if (scope !== 'global' && scope !== 'chat') throw new Error('未知笔记范围')
    const content = requireNoteContent(message.content)

    const { store } = await mutateStore(store => {
      if (scope === 'global') {
        store.globalNote = content
        return
      }

      const chatId = requireString(message.chatId, '缺少群聊 ID')
      requireChat(store, chatId)
      store.chatNotesById ??= {}
      store.chatNotesById[chatId] = content
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  const handleMessageHighlightCreate = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const messageId = requireString(message.messageId, '缺少消息 ID')
    const text = requireString(message.text, '高亮内容不能为空')
    const startOffset = requireNumber(message.startOffset, '缺少高亮起点')
    const endOffset = requireNumber(message.endOffset, '缺少高亮终点')
    if (endOffset <= startOffset) throw new Error('高亮范围无效')
    const timestamp = deps.now()

    const { store } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const target = store.messagesById[messageId]
      if (!target || target.chatId !== chat.id) throw new Error('找不到消息')
      if (startOffset < 0 || endOffset > target.content.length || target.content.slice(startOffset, endOffset) !== text) throw new Error('高亮范围与消息内容不匹配')

      store.messageHighlightsById ??= {}
      store.messageHighlightsById[messageId] ??= []
      store.messageHighlightsById[messageId].push({
        id: deps.newId('highlight'),
        messageId,
        text,
        startOffset,
        endOffset,
        createdAt: timestamp,
      })
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  const handleMessageResyncReply = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const roleId = requireString(message.roleId, '缺少人员 ID')
    const messageId = requireString(message.messageId, '缺少消息 ID')
    const binding = deps.runtimeFrames.getByRole(chatId, roleId)
    if (!binding?.ready) throw new Error('人员 iframe 尚未就绪，请先恢复人员')

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      const assistantMessage = store.messagesById[messageId]
      if (!isAssistantMessageForRole(assistantMessage, chat, role)) throw new Error('该回复不属于这个人员')
      return { currentContent: assistantMessage.content }
    })

    deps.log.warn('message-resync-reply:request', { chatId, roleId, messageId, tabId: binding.tabId, frameId: binding.frameId, currentContentLength: result.currentContent.length })
    const response = await deps.sendRoleMessage(binding.tabId, binding.frameId, {
      type: 'TEAM_RESYNC_REPLY',
      chatId,
      roleId,
      messageId,
      currentContent: result.currentContent,
    })
    if (isRecord(response) && response.ok === false) throw new Error(readOptionalString(response.error) ?? '重新同步回复失败')
    if (isRecord(response) && isRecord(response.store)) {
      const updatedMessage = isRecord(response.message) ? response.message : undefined
      deps.log.warn('message-resync-reply:updated-store', {
        chatId,
        roleId,
        messageId,
        updatedContentLength: typeof updatedMessage?.content === 'string' ? updatedMessage.content.length : undefined,
      })
      return { ok: true, store: response.store as unknown as OpenTeamStore, message: response.message, messageId }
    }
    deps.log.warn('message-resync-reply:no-updated-store', { chatId, roleId, messageId, response })
    return { ok: true, store, messageId }
  }

  const handleFrameRoleReady = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const tabId = messageTabId(message, sender)
    if (tabId === undefined) throw new Error('缺少 sender tab')
    rememberHost(sender, tabId)

    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const roleId = requireString(message.roleId, '缺少人员 ID')
    const frameId = senderFrameId(sender)
    const timestamp = deps.now()
    deps.log.info('frame-ready:received', {
      chatId,
      roleId,
      tabId,
      frameId,
      senderTabId: senderTabId(sender),
      hostTabId: message.hostTabId,
      senderUrl: sender.url,
      conversationId: message.conversationId,
      conversationUrl: message.conversationUrl,
    })
    deps.runtimeFrames.bind({ chatId, roleId, tabId, frameId, ready: true, lastSeenAt: timestamp })

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      role.status = 'ready'
      role.updatedAt = timestamp
      updateConversation(role, readOptionalString(message.conversationUrl), readOptionalString(message.conversationId))
      chat.status = deps.getChatStatusFromRoles(store, chat)
      chat.updatedAt = timestamp
      return { role, replyHistory: getRoleReplyHistory(store, chat, role.id) }
    })

    deps.log.info('frame-ready:store-updated', { chatId, roleId, roleName: result.role.name, status: result.role.status, replyHistoryCount: result.replyHistory.length, binding: deps.runtimeFrames.getByRole(chatId, roleId) })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, role: result.role, replyHistory: result.replyHistory, store }
  }

  const handleConversationUpdated = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, identity.chatId)
      const role = requireRole(store, chat.id, identity.roleId)
      updateConversation(role, readOptionalString(message.conversationUrl), readOptionalString(message.conversationId))
      role.updatedAt = deps.now()
      chat.updatedAt = role.updatedAt
      return role
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, role: result, store }
  }

  const handleSendAck = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const messageId = requireString(message.messageId, '缺少消息 ID')
    deps.log.info('send-ack:received', { ...identity, messageId, senderUrl: sender.url, tabId: messageTabId(message, sender), frameId: senderFrameId(sender) })
    const { store } = await mutateStore(store => {
      const chat = requireChat(store, identity.chatId)
      const role = requireRole(store, chat.id, identity.roleId)
      const userMessage = store.messagesById[messageId]
      if (userMessage?.deliveryStatus?.[role.id] === 'pending') {
        userMessage.deliveryStatus[role.id] = 'sent'
        if (Object.values(userMessage.deliveryStatus).every(status => status === 'sent' || status === 'received')) {
          userMessage.status = 'sent'
        }
      }
      if (userMessage) role.contextCursor = Math.max(role.contextCursor, userMessage.seq)
      role.updatedAt = deps.now()
      chat.updatedAt = role.updatedAt
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  const handleRoleStatus = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const mappedStatus = mapRuntimeRoleStatus(message.status)
    if (!mappedStatus) return { ok: false, error: '未知人员状态' }

    const identity = readIdentity(deps, message, sender)
    const timestamp = deps.now()
    deps.log.info('role-status:received', {
      ...identity,
      runtimeStatus: message.status,
      mappedStatus,
      error: message.error,
      senderUrl: sender.url,
      tabId: messageTabId(message, sender),
      frameId: senderFrameId(sender),
    })

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, identity.chatId)
      const role = requireRole(store, chat.id, identity.roleId)
      role.status = mappedStatus
      role.updatedAt = timestamp
      if (mappedStatus === 'ready' || mappedStatus === 'error') delete role.lastPromptMessageId
      if (mappedStatus === 'ready' || mappedStatus === 'error') delete role.replyAttemptId
      if (mappedStatus === 'stopped') role.replyAttemptId = deps.newId('stopped')
      chat.status = deps.getChatStatusFromRoles(store, chat)
      chat.updatedAt = timestamp
      return role
    })

    await deps.broadcastStoreUpdated(store)
    return { ok: true, role: result, store }
  }

  const handleRoleReply = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const content = requireString(message.content, '回复内容不能为空')
    const contentFormat = message.contentFormat === 'markdown' ? 'markdown' : undefined
    const promptMessageId = readOptionalString(message.messageId)
    const replyAttemptId = readOptionalString(message.replyAttemptId)
    const timestamp = deps.now()
    deps.log.info('role-reply:received', { ...identity, promptMessageId, replyAttemptId, contentLength: content.length, senderUrl: sender.url })

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, identity.chatId)
      const role = requireRole(store, chat.id, identity.roleId)
      const staleReason = staleReplyReason(store, chat, role, promptMessageId, replyAttemptId)
      if (staleReason) {
        return { ignored: true as const, reason: staleReason, roleId: role.id, promptMessageId }
      }

      updateConversation(role, readOptionalString(message.conversationUrl), readOptionalString(message.conversationId))

      const reply: GroupMessage = {
        id: deps.newId('msg'),
        chatId: chat.id,
        seq: chat.nextMessageSeq,
        type: 'assistant',
        content,
        contentFormat,
        roleId: role.id,
        roleName: role.name,
        createdAt: timestamp,
        status: 'received',
      }
      store.messagesById[reply.id] = reply
      chat.messageIds.push(reply.id)
      chat.nextMessageSeq += 1
      markChatHasNewMessage(store, chat)

      if (promptMessageId) {
        const userMessage = store.messagesById[promptMessageId]
        if (userMessage?.deliveryStatus?.[role.id]) {
          userMessage.deliveryStatus[role.id] = 'received'
          if (Object.values(userMessage.deliveryStatus).every(status => status === 'received')) userMessage.status = 'received'
        }
      }

      role.status = 'ready'
      role.lastReplyAt = timestamp
      role.updatedAt = timestamp
      if (!promptMessageId || role.lastPromptMessageId === promptMessageId) delete role.lastPromptMessageId
      if (!replyAttemptId || role.replyAttemptId === replyAttemptId) delete role.replyAttemptId
      chat.status = deps.getChatStatusFromRoles(store, chat)
      chat.updatedAt = timestamp
      return { ignored: false as const, reply }
    })

    if (result.ignored) {
      deps.log.warn('role-reply:ignored-stale', { ...identity, promptMessageId: result.promptMessageId, reason: result.reason })
      return { ok: true, ignored: true, reason: result.reason, store }
    }

    deps.log.info('role-reply:stored', { chatId: result.reply.chatId, roleId: result.reply.roleId, replyMessageId: result.reply.id })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, message: result.reply, store }
  }

  const handleRoleReplyResync = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const messageId = requireString(message.messageId, '缺少消息 ID')
    const content = requireString(message.content, '回复内容不能为空')
    const contentFormat = message.contentFormat === 'markdown' ? 'markdown' : undefined
    const timestamp = deps.now()
    deps.log.info('role-reply-resync:received', { ...identity, messageId, contentLength: content.length, senderUrl: sender.url })

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, identity.chatId)
      const role = requireRole(store, chat.id, identity.roleId)
      const assistantMessage = store.messagesById[messageId]
      if (!isAssistantMessageForRole(assistantMessage, chat, role)) throw new Error('该回复不属于这个人员')

      updateConversation(role, readOptionalString(message.conversationUrl), readOptionalString(message.conversationId))
      assistantMessage.content = content
      assistantMessage.contentFormat = contentFormat
      assistantMessage.status = 'received'
      chat.updatedAt = timestamp
      return { message: assistantMessage }
    })

    deps.log.info('role-reply-resync:stored', { chatId: result.message.chatId, roleId: result.message.roleId, replyMessageId: result.message.id })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, message: result.message, store }
  }

  const handleRoleError = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const reason = readOptionalString(message.reason) ?? readOptionalString(message.error) ?? '人员执行失败'
    const promptMessageId = readOptionalString(message.messageId)
    const replyAttemptId = readOptionalString(message.replyAttemptId)
    deps.log.warn('role-error:received', { ...identity, promptMessageId, replyAttemptId, reason, senderUrl: sender.url, tabId: messageTabId(message, sender), frameId: senderFrameId(sender) })

    const { store } = await mutateStore(store => {
      const chat = requireChat(store, identity.chatId)
      const role = requireRole(store, chat.id, identity.roleId)
      role.status = 'error'
      role.updatedAt = deps.now()
      if (!promptMessageId || role.lastPromptMessageId === promptMessageId) delete role.lastPromptMessageId
      if (!replyAttemptId || role.replyAttemptId === replyAttemptId) delete role.replyAttemptId

      if (promptMessageId) {
        const userMessage = store.messagesById[promptMessageId]
        if (userMessage?.deliveryStatus?.[role.id]) {
          userMessage.deliveryStatus[role.id] = 'error'
          userMessage.status = 'error'
        }
      }
      chat.status = 'error'
      chat.updatedAt = role.updatedAt
    })

    await deps.broadcastStoreUpdated(store)
    await deps.sendError(reason)
    return { ok: true, store }
  }

  return [
    { type: 'GROUP_ROLE_RETRY_REPLY', handler: handleRoleRetryReply },
    { type: 'GROUP_ROLE_STOP_REPLY', handler: handleRoleStopReply },
    { type: 'GROUP_NOTE_SAVE', handler: handleNoteSave },
    { type: 'GROUP_MESSAGE_HIGHLIGHT_CREATE', handler: handleMessageHighlightCreate },
    { type: 'GROUP_MESSAGE_RESYNC_REPLY', handler: handleMessageResyncReply },
    { type: 'GROUP_MESSAGE_SEND', handler: handleMessageSend },
    {
      type: 'TEAM_FRAME_ROLE_READY',
      handler: (message, sender) => readOptionalString(message.chatId) ? handleFrameRoleReady(message, sender) : { ok: false, error: 'TEAM_FRAME_ROLE_READY 缺少 chatId' },
    },
    { type: 'TEAM_ROLE_CONVERSATION_UPDATED', handler: handleConversationUpdated },
    { type: 'TEAM_SEND_ACK', handler: handleSendAck },
    { type: 'TEAM_ROLE_STATUS', handler: handleRoleStatus },
    { type: 'TEAM_ROLE_REPLY', handler: handleRoleReply },
    { type: 'TEAM_ROLE_REPLY_RESYNC', handler: handleRoleReplyResync },
    { type: 'TEAM_ROLE_ERROR', handler: handleRoleError },
  ]
}

function getRoleReplyHistory(store: OpenTeamStore, chat: GroupChat, roleId: string, limit = 100): string[] {
  return getChatMessages(store, chat)
    .filter(message => message.type === 'assistant' && message.roleId === roleId && message.content.trim())
    .slice(-limit)
    .map(message => message.content)
}

function staleReplyReason(store: OpenTeamStore, chat: GroupChat, role: GroupRole, promptMessageId: string | undefined, replyAttemptId?: string): string | undefined {
  if (!promptMessageId) return 'missing-prompt-message-id'
  if (role.lastPromptMessageId !== promptMessageId) return 'prompt-message-mismatch'
  if (replyAttemptId && role.replyAttemptId && role.replyAttemptId !== replyAttemptId) return 'reply-attempt-mismatch'

  const userMessage = store.messagesById[promptMessageId]
  if (!userMessage || userMessage.chatId !== chat.id || userMessage.type !== 'user') return 'prompt-message-not-found'

  const deliveryStatus = userMessage.deliveryStatus?.[role.id]
  if (deliveryStatus !== 'pending' && deliveryStatus !== 'sent') return `delivery-already-${deliveryStatus ?? 'missing'}`

  return undefined
}

function markChatHasNewMessage(store: OpenTeamStore, chat: GroupChat): void {
  if (store.currentChatId === chat.id) return
  store.viewState ??= { chatReadSeqById: {}, chatHasNewMessageById: {} }
  store.viewState.chatHasNewMessageById ??= {}
  store.viewState.chatHasNewMessageById[chat.id] = true
}

function readIdentity(deps: MessageHandlersDependencies, message: RuntimeMessage, sender: chrome.runtime.MessageSender): { chatId: string; roleId: string } {
  const chatId = readOptionalString(message.chatId)
  const roleId = readOptionalString(message.roleId)
  if (chatId && roleId) return { chatId, roleId }

  const tabId = messageTabId(message, sender)
  if (tabId !== undefined) {
    const binding = deps.runtimeFrames.getByAddress(tabId, senderFrameId(sender))
    if (binding) return { chatId: binding.chatId, roleId: binding.roleId }
  }

  throw new Error('缺少 chatId/roleId')
}

function updateConversation(role: GroupRole, conversationUrl: string | undefined, conversationId: string | undefined): void {
  const safeUrl = normalizeSupportedChatConversationUrl(conversationUrl)
  const conversationIdFromUrl = extractSupportedConversationId(safeUrl)
  if (safeUrl && conversationIdFromUrl) {
    role.geminiConversationUrl = safeUrl
    role.geminiConversationId = conversationIdFromUrl
    return
  }

  if (isMeaningfulConversationId(conversationId)) role.geminiConversationId = conversationId
}

function isMeaningfulConversationId(value: string | undefined): value is string {
  return Boolean(value && value !== '__default__')
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
  return role.status === 'ready' || role.status === 'error' || role.status === 'stopped' || role.status === 'loading' || role.status === 'pending' || isStaleThinkingRole(role, timestamp)
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

function isAssistantMessageForRole(message: GroupMessage | undefined, chat: GroupChat, role: GroupRole): message is GroupMessage {
  return Boolean(message && message.chatId === chat.id && message.type === 'assistant' && message.roleId === role.id)
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

function requireNumber(value: unknown, error: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(error)
  return value
}

function requireNoteContent(value: unknown): NonNullable<OpenTeamStore['globalNote']> {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('笔记内容格式无效')
  return value as NonNullable<OpenTeamStore['globalNote']>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
