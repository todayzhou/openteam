import { buildUnsyncedContext } from '../group/contextSync'
import { extractSupportedConversationId, normalizeSupportedChatConversationUrl } from '../group/conversationUrl'
import { normalizeMessageHighlightColor } from '../group/highlightColors'
import { buildExternalModelPrompt, type ExternalMemoryPatch } from '../group/externalModelContext'
import { parseGroupMentions, roleMentionLabelOptionsFromSettings } from '../group/mentionParser'
import { buildPrompt } from '../group/promptBuilder'
import { mapRuntimeRoleStatus } from '../group/runtimeProtocol'
import type { BackgroundToRoleMessage } from '../group/runtimeProtocol'
import type { ExternalModelConfig, GroupChat, GroupMessage, GroupRole, MessageReference, OpenTeamStore, RuntimeFrameBinding } from '../group/types'
import { createExternalModelClient, type ExternalModelClient } from './externalModelClient'
import type { BackgroundMessageRoute } from './messageRouter'
import type { PromptDelivery, PromptSender } from './promptDelivery'
import { messageTabId, rememberHost, senderFrameId, senderTabId, type RuntimeMessage } from './runtimeClient'
import type { RuntimeFrameRegistry } from './runtimeFrames'
import { getChatMessages, getChatRoles, mutateStore, requireChat, requireRole } from './storeAccess'

const STALE_THINKING_MS = 120_000

interface ExternalPromptDelivery {
  roleId: string
  chatId: string
  messageId: string
  replyAttemptId: string
  model: ExternalModelConfig
  prompt: string
}

interface ExternalModelRunRegistry {
  register(chatId: string, roleId: string, replyAttemptId: string, controller: AbortController): void
  abort(chatId: string, roleId: string, replyAttemptId?: string): void
  unregister(chatId: string, roleId: string, replyAttemptId: string): void
}

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
  externalModelClient?: ExternalModelClient
  externalModelRuns?: ExternalModelRunRegistry
}

export function createMessageHandlers(deps: MessageHandlersDependencies): BackgroundMessageRoute[] {
  const deepSeekPromptBatcher = createDeepSeekPromptBatcher(deps)
  const externalModelClient = deps.externalModelClient ?? createExternalModelClient()
  const externalModelRuns = deps.externalModelRuns ?? createExternalModelRunRegistry()

  const handleMessageSend = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const raw = requireString(message.raw, '消息内容不能为空')
    const timestamp = deps.now()
    deps.log.info('message-send:start', { chatId, rawLength: raw.length })

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const roles = getChatRoles(store, chat)
      const parsed = parseGroupMentions(raw, roles, { ...roleMentionLabelOptionsFromSettings(store.settings), defaultTarget: 'none' })
      if (!parsed.ok) throw new Error(parsed.error)
      deps.log.debug('message-send:parsed-targets', { chatId: chat.id, targetRoleIds: parsed.targetRoleIds })

      const targetRoles = parsed.targetRoleIds.map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role))
      const unavailable = targetRoles.filter(role => {
        if (isExternalModelRole(role)) return !getExternalModelForRole(store, role)
        return !isRoleDeliverable(role, deps.runtimeFrames.getByRole(chat.id, role.id), timestamp)
      })

      if (unavailable.length > 0) {
        deps.log.warn('message-send:unavailable-targets', {
          chatId: chat.id,
          targets: unavailable.map(role => ({
            id: role.id,
            name: role.name,
            status: role.status,
            updatedAt: role.updatedAt,
            staleThinking: isStaleThinkingRole(role, timestamp),
            binding: isExternalModelRole(role) ? undefined : deps.runtimeFrames.getByRole(chat.id, role.id),
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
        mentionsAll: parsed.mentionsAll,
        references: reference ? [reference] : undefined,
        createdAt: timestamp,
        status: parsed.targetRoleIds.length > 0 ? 'pending' : 'received',
        deliveryStatus: Object.fromEntries(parsed.targetRoleIds.map(roleId => [roleId, 'pending'])),
      }

      store.messagesById[userMessage.id] = userMessage
      chat.messageIds.push(userMessage.id)
      chat.nextMessageSeq += 1
      deps.log.info('message-send:stored', { chatId: chat.id, messageId: userMessage.id, targetCount: parsed.targetRoleIds.length })
      chat.updatedAt = timestamp
      if (parsed.targetRoleIds.length === 0) {
        return { message: userMessage, deliveries: [], externalDeliveries: [] }
      }

      chat.status = 'running'

      const messages = getChatMessages(store, chat)
      const deliveries: PromptDelivery[] = []
      const externalDeliveries: ExternalPromptDelivery[] = []
      for (const roleId of parsed.targetRoleIds) {
        const role = requireRole(store, chat.id, roleId)
        const roleHistoryCount = countLocalRoleHistory(messages, role, userMessage.id)
        const includesPersona = shouldIncludePersonaForPrompt(roleHistoryCount)
        const replyAttemptId = deps.newId('attempt')
        if (isExternalModelRole(role)) {
          const model = requireExternalModelForRole(store, role)
          const prompt = buildExternalModelPrompt(store, chat, role, userMessage, roles)
          if (prompt.memoryPatch) applyExternalMemoryPatch(store, prompt.memoryPatch, timestamp)
          externalDeliveries.push({
            roleId,
            chatId: chat.id,
            messageId: userMessage.id,
            replyAttemptId,
            model,
            prompt: prompt.content,
          })
        } else {
          const binding = deps.runtimeFrames.getByRole(chat.id, role.id)!
          const unsyncedContext = buildUnsyncedContext(chat, role, messages, userMessage, store.settings.maxContextChars)
          const content = buildPrompt({ chat, role, userMessage, roles, unsyncedContext, reference, includePersona: includesPersona })
          deliveries.push({
            roleId,
            chatSite: role.chatSite ?? store.settings.defaultChatSite,
            tabId: binding.tabId,
            frameId: binding.frameId,
            message: { type: 'TEAM_SEND_PROMPT', chatId: chat.id, roleId, messageId: userMessage.id, replyAttemptId, content, includesPersona },
          })
        }
        if (!includesPersona && !isExternalModelRole(role)) {
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
      }

      return { message: userMessage, deliveries, externalDeliveries }
    })

    deps.log.info('message-send:deliveries-ready', {
      chatId,
      messageId: result.message.id,
      deliveries: [
        ...result.deliveries.map(delivery => ({ roleId: delivery.roleId, modelSource: 'site', chatSite: delivery.chatSite, tabId: delivery.tabId, frameId: delivery.frameId, contentLength: delivery.message.content.length })),
        ...result.externalDeliveries.map(delivery => ({ roleId: delivery.roleId, modelSource: 'external', modelId: delivery.model.id, contentLength: delivery.prompt.length })),
      ],
    })
    await deps.broadcastStoreUpdated(store)

    await sendPromptDeliveries(deps, deepSeekPromptBatcher, chatId, result.message.id, result.deliveries)
    let responseStore = store
    for (const delivery of result.externalDeliveries) {
      responseStore = await sendExternalModelDelivery(deps, externalModelClient, externalModelRuns, delivery) ?? responseStore
    }

    return {
      ok: true,
      message: result.message,
      deliveries: [
        ...result.deliveries.map(delivery => ({ roleId: delivery.roleId, modelSource: 'site' })),
        ...result.externalDeliveries.map(delivery => ({ roleId: delivery.roleId, modelSource: 'external' })),
      ],
      store: responseStore,
    }
  }

  const handleRoleRetryReply = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const roleId = requireString(message.roleId, '缺少人员 ID')
    const timestamp = deps.now()

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      const requestedMessageId = readOptionalString(message.messageId)
      const retryTarget = resolveRetryTarget(store, chat, role, requestedMessageId, deps.log)
      const userMessage = retryTarget?.userMessage
      if (!userMessage) throw new Error(requestedMessageId ? '该消息没有发送给这个人员' : '找不到可重试的用户消息')
      if (retryTarget?.discardMessageId) discardMessage(store, chat, retryTarget.discardMessageId)

      const roles = getChatRoles(store, chat)
      const messages = getChatMessages(store, chat)
      const reference = userMessage.references?.[0]
      const roleHistoryCount = countLocalRoleHistory(messages, role, userMessage.id)
      const includesPersona = shouldIncludePersonaForPrompt(roleHistoryCount)
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

      if (isExternalModelRole(role)) {
        const model = requireExternalModelForRole(store, role)
        const prompt = buildExternalModelPrompt(store, chat, role, userMessage, roles)
        if (prompt.memoryPatch) applyExternalMemoryPatch(store, prompt.memoryPatch, timestamp)
        return {
          externalDelivery: {
            roleId,
            chatId: chat.id,
            messageId: userMessage.id,
            replyAttemptId,
            model,
            prompt: prompt.content,
          },
        }
      }

      const binding = deps.runtimeFrames.getByRole(chat.id, role.id)
      if (!binding?.ready) throw new Error('人员 iframe 尚未就绪，请先恢复人员')
      const unsyncedContext = buildUnsyncedContext(chat, role, messages, userMessage, store.settings.maxContextChars)
      const content = buildPrompt({ chat, role, userMessage, roles, unsyncedContext, reference, includePersona: includesPersona })
      return {
        delivery: {
          roleId,
          chatSite: role.chatSite ?? store.settings.defaultChatSite,
          tabId: binding.tabId,
          frameId: binding.frameId,
          message: { type: 'TEAM_SEND_PROMPT' as const, chatId: chat.id, roleId, messageId: userMessage.id, replyAttemptId, content, includesPersona },
        },
      }
    })

    await deps.broadcastStoreUpdated(store)
    const externalDelivery = 'externalDelivery' in result ? result.externalDelivery : undefined
    if (externalDelivery) {
      deps.log.info('role-retry-reply:deliver-external', {
        chatId,
        roleId,
        messageId: externalDelivery.messageId,
        replyAttemptId: externalDelivery.replyAttemptId,
        modelId: externalDelivery.model.id,
      })
      const responseStore = await sendExternalModelDelivery(deps, externalModelClient, externalModelRuns, externalDelivery) ?? store
      return { ok: true, store: responseStore, messageId: externalDelivery.messageId }
    }
    const delivery = 'delivery' in result ? result.delivery : undefined
    if (!delivery) throw new Error('重试投递生成失败')
    deps.log.info('role-retry-reply:deliver', {
      chatId,
      roleId,
      messageId: delivery.message.messageId,
      replyAttemptId: delivery.message.replyAttemptId,
      tabId: delivery.tabId,
      frameId: delivery.frameId,
    })
    try {
      await deps.sendPrompt(delivery)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await markDeliveryError(deps, chatId, roleId, delivery.message.messageId, reason)
    }
    return { ok: true, store, messageId: delivery.message.messageId }
  }

  const handleRoleStopReply = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const roleId = requireString(message.roleId, '缺少人员 ID')

    const { result: active } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      if (role.status !== 'thinking' || !role.lastPromptMessageId) throw new Error('该人员当前没有正在回复的任务')
      return {
        messageId: role.lastPromptMessageId,
        replyAttemptId: role.replyAttemptId,
        isExternal: isExternalModelRole(role),
      }
    })

    if (active.isExternal) {
      externalModelRuns.abort(chatId, roleId, active.replyAttemptId)
    } else {
      const binding = deps.runtimeFrames.getByRole(chatId, roleId)
      if (!binding?.ready) throw new Error('人员 iframe 尚未就绪，无法停止回复')
      const response = await deps.sendRoleMessage(binding.tabId, binding.frameId, {
        type: 'TEAM_STOP_GENERATION',
        chatId,
        roleId,
        messageId: active.messageId,
        replyAttemptId: active.replyAttemptId,
      })
      if (isRecord(response) && response.ok === false) throw new Error(readOptionalString(response.error) ?? '停止回复失败')
    }

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
    deps.log.info('role-stop-reply:stopped', { chatId, roleId, messageId: active.messageId, modelSource: active.isExternal ? 'external' : 'site' })
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
    const color = normalizeMessageHighlightColor(message.color)
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
        color,
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
    if (promptMessageId) await deepSeekPromptBatcher.complete(identity.chatId, promptMessageId, identity.roleId)
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
    if (promptMessageId) await deepSeekPromptBatcher.complete(identity.chatId, promptMessageId, identity.roleId)
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

interface DeepSeekPromptBatcher {
  enqueue(chatId: string, messageId: string, deliveries: PromptDelivery[]): Promise<void>
  complete(chatId: string, messageId: string, roleId: string): Promise<void>
}

interface DeepSeekPromptBatchState {
  chatId: string
  messageId: string
  pending: PromptDelivery[]
  activeRoleIds: Set<string>
}

function createDeepSeekPromptBatcher(deps: MessageHandlersDependencies): DeepSeekPromptBatcher {
  const batches = new Map<string, DeepSeekPromptBatchState>()

  const pump = async (state: DeepSeekPromptBatchState): Promise<void> => {
    const launched: Array<Promise<void>> = []
    while (state.activeRoleIds.size < 2 && state.pending.length > 0) {
      const delivery = state.pending.shift()!
      state.activeRoleIds.add(delivery.roleId)
      deps.log.info('deepseek-prompt:batch-send', {
        chatId: state.chatId,
        messageId: state.messageId,
        roleId: delivery.roleId,
        activeCount: state.activeRoleIds.size,
        remainingCount: state.pending.length,
      })
      launched.push(sendPromptDelivery(deps, state.chatId, state.messageId, delivery).then(async sent => {
        if (!sent) await complete(state.chatId, state.messageId, delivery.roleId)
      }))
    }
    await Promise.all(launched)
  }

  const complete = async (chatId: string, messageId: string, roleId: string): Promise<void> => {
    const key = deepSeekBatchKey(chatId, messageId)
    const state = batches.get(key)
    if (!state || !state.activeRoleIds.delete(roleId)) return
    if (state.pending.length === 0 && state.activeRoleIds.size === 0) {
      batches.delete(key)
      return
    }
    await pump(state)
  }

  return {
    async enqueue(chatId, messageId, deliveries) {
      if (deliveries.length === 0) return
      const key = deepSeekBatchKey(chatId, messageId)
      const state: DeepSeekPromptBatchState = { chatId, messageId, pending: [...deliveries], activeRoleIds: new Set() }
      batches.set(key, state)
      await pump(state)
    },
    complete,
  }
}

async function sendPromptDeliveries(deps: MessageHandlersDependencies, deepSeekPromptBatcher: DeepSeekPromptBatcher, chatId: string, messageId: string, deliveries: PromptDelivery[]): Promise<void> {
  const deepSeekDeliveries: PromptDelivery[] = []
  for (const delivery of deliveries) {
    if (delivery.chatSite === 'deepseek') {
      deepSeekDeliveries.push(delivery)
      continue
    }
    await sendPromptDelivery(deps, chatId, messageId, delivery)
  }
  await deepSeekPromptBatcher.enqueue(chatId, messageId, deepSeekDeliveries)
}

async function sendPromptDelivery(deps: MessageHandlersDependencies, chatId: string, messageId: string, delivery: PromptDelivery): Promise<boolean> {
  try {
    await deps.sendPrompt(delivery)
    return true
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await markDeliveryError(deps, chatId, delivery.roleId, messageId, reason)
    return false
  }
}

async function sendExternalModelDelivery(deps: MessageHandlersDependencies, client: ExternalModelClient, runs: ExternalModelRunRegistry, delivery: ExternalPromptDelivery): Promise<OpenTeamStore | undefined> {
  const controller = new AbortController()
  runs.register(delivery.chatId, delivery.roleId, delivery.replyAttemptId, controller)
  let replyMessageId: string | undefined
  let content = ''
  try {
    deps.log.info('external-model:send:start', {
      chatId: delivery.chatId,
      roleId: delivery.roleId,
      messageId: delivery.messageId,
      modelId: delivery.model.id,
      format: delivery.model.format,
      promptLength: delivery.prompt.length,
    })

    const initialized = await createExternalAssistantPlaceholder(deps, delivery)
    if (initialized.ignored) {
      deps.log.warn('external-model:reply:ignored-stale', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, reason: initialized.reason })
      return initialized.store
    }
    replyMessageId = initialized.replyMessageId
    await deps.broadcastStoreUpdated(initialized.store)

    const stream = typeof client.stream === 'function'
      ? client.stream({ model: delivery.model, prompt: delivery.prompt, abortSignal: controller.signal })
      : streamCompleteFallback(client, { model: delivery.model, prompt: delivery.prompt, abortSignal: controller.signal })
    for await (const chunk of stream) {
      if (!chunk) continue
      content += chunk
      const update = await updateExternalAssistantContent(deps, delivery, replyMessageId, content)
      if (update.ignored) {
        deps.log.warn('external-model:stream:ignored-stale', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, reason: update.reason })
        return update.store
      }
      await deps.broadcastStoreUpdated(update.store)
    }

    if (!content.trim()) throw new Error('外部模型返回格式无效')
    const finalized = await finishExternalAssistantReply(deps, delivery, replyMessageId, content)
    if (finalized.ignored) {
      deps.log.warn('external-model:reply:ignored-stale', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, reason: finalized.reason })
      return finalized.store
    }
    deps.log.info('external-model:reply:stored', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, replyMessageId })
    await deps.broadcastStoreUpdated(finalized.store)
    return finalized.store
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      deps.log.info('external-model:send:aborted', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, replyMessageId, contentLength: content.length })
      if (replyMessageId) {
        const stopped = await markExternalAssistantStopped(deps, delivery, replyMessageId, content)
        await deps.broadcastStoreUpdated(stopped.store)
        return stopped.store
      }
      return undefined
    }
    const reason = error instanceof Error ? error.message : String(error)
    deps.log.warn('external-model:send:failed', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, reason })
    await markDeliveryError(deps, delivery.chatId, delivery.roleId, delivery.messageId, reason)
    return undefined
  } finally {
    runs.unregister(delivery.chatId, delivery.roleId, delivery.replyAttemptId)
  }
}

async function createExternalAssistantPlaceholder(
  deps: MessageHandlersDependencies,
  delivery: ExternalPromptDelivery,
): Promise<{ ignored: true; reason: string; store: OpenTeamStore } | { ignored: false; replyMessageId: string; store: OpenTeamStore }> {
  const timestamp = deps.now()
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, delivery.chatId)
    const role = requireRole(store, chat.id, delivery.roleId)
    const staleReason = staleReplyReason(store, chat, role, delivery.messageId, delivery.replyAttemptId)
    if (staleReason) return { ignored: true as const, reason: staleReason }

    const reply: GroupMessage = {
      id: deps.newId('msg'),
      chatId: chat.id,
      seq: chat.nextMessageSeq,
      type: 'assistant',
      content: '',
      contentFormat: 'markdown',
      roleId: role.id,
      roleName: role.name,
      createdAt: timestamp,
      status: 'pending',
    }
    store.messagesById[reply.id] = reply
    chat.messageIds.push(reply.id)
    chat.nextMessageSeq += 1

    const userMessage = store.messagesById[delivery.messageId]
    if (userMessage?.deliveryStatus?.[role.id] === 'pending') {
      userMessage.deliveryStatus[role.id] = 'sent'
      if (Object.values(userMessage.deliveryStatus).every(status => status === 'sent' || status === 'received')) userMessage.status = 'sent'
    }
    role.updatedAt = timestamp
    chat.updatedAt = timestamp
    return { ignored: false as const, replyMessageId: reply.id }
  })
  return result.ignored ? { ...result, store } : { ...result, store }
}

async function updateExternalAssistantContent(
  deps: MessageHandlersDependencies,
  delivery: ExternalPromptDelivery,
  replyMessageId: string,
  content: string,
): Promise<{ ignored: true; reason: string; store: OpenTeamStore } | { ignored: false; store: OpenTeamStore }> {
  const timestamp = deps.now()
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, delivery.chatId)
    const role = requireRole(store, chat.id, delivery.roleId)
    const staleReason = staleReplyReason(store, chat, role, delivery.messageId, delivery.replyAttemptId)
    if (staleReason) return { ignored: true as const, reason: staleReason }
    const reply = store.messagesById[replyMessageId]
    if (!isAssistantMessageForRole(reply, chat, role)) return { ignored: true as const, reason: 'reply-message-not-found' }
    reply.content = content
    reply.status = 'pending'
    role.updatedAt = timestamp
    chat.updatedAt = timestamp
    return { ignored: false as const }
  })
  return result.ignored ? { ...result, store } : { ...result, store }
}

async function finishExternalAssistantReply(
  deps: MessageHandlersDependencies,
  delivery: ExternalPromptDelivery,
  replyMessageId: string,
  content: string,
): Promise<{ ignored: true; reason: string; store: OpenTeamStore } | { ignored: false; store: OpenTeamStore }> {
  const timestamp = deps.now()
  const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, delivery.chatId)
      const role = requireRole(store, chat.id, delivery.roleId)
      const staleReason = staleReplyReason(store, chat, role, delivery.messageId, delivery.replyAttemptId)
      if (staleReason) return { ignored: true as const, reason: staleReason }
      const reply = store.messagesById[replyMessageId]
      if (!isAssistantMessageForRole(reply, chat, role)) return { ignored: true as const, reason: 'reply-message-not-found' }
      reply.content = content
      reply.status = 'received'
      markChatHasNewMessage(store, chat)

      const userMessage = store.messagesById[delivery.messageId]
      if (userMessage?.deliveryStatus?.[role.id]) {
        userMessage.deliveryStatus[role.id] = 'received'
        if (Object.values(userMessage.deliveryStatus).every(status => status === 'received')) userMessage.status = 'received'
      }

      role.status = 'ready'
      role.lastReplyAt = timestamp
      role.updatedAt = timestamp
      if (role.lastPromptMessageId === delivery.messageId) delete role.lastPromptMessageId
      if (role.replyAttemptId === delivery.replyAttemptId) delete role.replyAttemptId
      chat.status = deps.getChatStatusFromRoles(store, chat)
      chat.updatedAt = timestamp
      return { ignored: false as const }
    })
  return result.ignored ? { ...result, store } : { ...result, store }
}

async function markExternalAssistantStopped(
  deps: MessageHandlersDependencies,
  delivery: ExternalPromptDelivery,
  replyMessageId: string,
  content: string,
): Promise<{ store: OpenTeamStore }> {
  const timestamp = deps.now()
  const { store } = await mutateStore(store => {
    const chat = requireChat(store, delivery.chatId)
    const role = requireRole(store, chat.id, delivery.roleId)
    const reply = store.messagesById[replyMessageId]
    if (isAssistantMessageForRole(reply, chat, role)) {
      reply.content = content
      reply.status = content.trim() ? 'received' : 'error'
    }
    if (role.lastPromptMessageId === delivery.messageId) role.status = 'stopped'
    role.updatedAt = timestamp
    chat.status = deps.getChatStatusFromRoles(store, chat)
    chat.updatedAt = timestamp
  })
  return { store }
}

async function* streamCompleteFallback(client: ExternalModelClient, input: { model: ExternalModelConfig; prompt: string; abortSignal?: AbortSignal }): AsyncIterable<string> {
  const result = await client.complete(input)
  yield result.content
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function deepSeekBatchKey(chatId: string, messageId: string): string {
  return `${chatId}:${messageId}`
}

function createExternalModelRunRegistry(): ExternalModelRunRegistry {
  const runs = new Map<string, AbortController>()
  return {
    register(chatId, roleId, replyAttemptId, controller) {
      runs.set(externalModelRunKey(chatId, roleId, replyAttemptId), controller)
    },
    abort(chatId, roleId, replyAttemptId) {
      if (replyAttemptId) {
        runs.get(externalModelRunKey(chatId, roleId, replyAttemptId))?.abort()
        return
      }
      for (const [key, controller] of runs) {
        if (key.startsWith(`${chatId}:${roleId}:`)) controller.abort()
      }
    },
    unregister(chatId, roleId, replyAttemptId) {
      runs.delete(externalModelRunKey(chatId, roleId, replyAttemptId))
    },
  }
}

function externalModelRunKey(chatId: string, roleId: string, replyAttemptId: string): string {
  return `${chatId}:${roleId}:${replyAttemptId}`
}

function isExternalModelRole(role: GroupRole): boolean {
  return role.modelSource === 'external'
}

function getExternalModelForRole(store: OpenTeamStore, role: GroupRole): ExternalModelConfig | undefined {
  if (!isExternalModelRole(role) || !role.externalModelId) return undefined
  return store.settings.externalModelsById[role.externalModelId]
}

function requireExternalModelForRole(store: OpenTeamStore, role: GroupRole): ExternalModelConfig {
  const model = getExternalModelForRole(store, role)
  if (!model) throw new Error(`找不到外部模型：${role.externalModelId ?? role.name}`)
  return model
}

function applyExternalMemoryPatch(store: OpenTeamStore, patch: ExternalMemoryPatch, timestamp: number): void {
  if (patch.scope === 'chat') {
    store.externalChatMemoriesById ??= {}
    store.externalChatMemoriesById[patch.id] = {
      chatId: patch.id,
      summary: patch.summary,
      summarizedThroughSeq: patch.summarizedThroughSeq,
      updatedAt: timestamp,
    }
    return
  }

  store.externalRoleMemoriesById ??= {}
  store.externalRoleMemoriesById[patch.id] = {
    roleId: patch.id,
    summary: patch.summary,
    summarizedThroughSeq: patch.summarizedThroughSeq,
    updatedAt: timestamp,
  }
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

type UserGroupMessage = GroupMessage & { type: 'user' }
type AssistantGroupMessage = GroupMessage & { type: 'assistant' }

function isUserMessageForRole(message: GroupMessage | undefined, chat: GroupChat, role: GroupRole): message is UserGroupMessage {
  return Boolean(
    message &&
      message.chatId === chat.id &&
      message.type === 'user' &&
      (!message.targetRoleIds || message.targetRoleIds.includes(role.id)),
  )
}

function isAssistantMessageForRole(message: GroupMessage | undefined, chat: GroupChat, role: GroupRole): message is AssistantGroupMessage {
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

interface RetryTarget {
  userMessage: GroupMessage
  discardMessageId?: string
}

function resolveRetryTarget(
  store: OpenTeamStore,
  chat: GroupChat,
  role: GroupRole,
  requestedMessageId: string | undefined,
  log: MessageHandlersDependencies['log'],
): RetryTarget | undefined {
  if (!requestedMessageId) {
    const userMessage = resolveRetryUserMessage(store, chat, role, undefined, log)
    return userMessage ? { userMessage } : undefined
  }

  const requestedMessage = store.messagesById[requestedMessageId]
  if (isUserMessageForRole(requestedMessage, chat, role)) return { userMessage: requestedMessage }

  if (isExternalModelRole(role) && isAssistantMessageForRole(requestedMessage, chat, role)) {
    const userMessage = findPromptBeforeAssistant(store, chat, role, requestedMessage.id)
    return userMessage ? { userMessage, discardMessageId: requestedMessage.id } : undefined
  }

  return undefined
}

function findPromptBeforeAssistant(store: OpenTeamStore, chat: GroupChat, role: GroupRole, assistantMessageId: string): GroupMessage | undefined {
  const assistantIndex = chat.messageIds.indexOf(assistantMessageId)
  if (assistantIndex <= 0) return undefined

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = store.messagesById[chat.messageIds[index]]
    if (isUserMessageForRole(message, chat, role)) return message
  }
  return undefined
}

function discardMessage(store: OpenTeamStore, chat: GroupChat, messageId: string): void {
  delete store.messagesById[messageId]
  chat.messageIds = chat.messageIds.filter(id => id !== messageId)
  if (store.messageHighlightsById) delete store.messageHighlightsById[messageId]
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
