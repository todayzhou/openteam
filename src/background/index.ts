import { extractSupportedConversationId, normalizeSupportedChatConversationUrl } from '../group/conversationUrl'
import { loadStore } from '../group/store'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore, RoleStatus } from '../group/types'
import { createChatHandlers } from './chatHandlers'
import { createMessageHandlers } from './messageHandlers'
import {
  broadcastStoreUpdated as broadcastRuntimeStoreUpdated,
  forgetHostTab,
  listHostTabIds,
  messageTabId,
  rememberHost,
  sendError,
  senderFrameId,
  senderTabId,
  type RuntimeMessage,
} from './runtimeClient'
import { createMessageRouter } from './messageRouter'
import { createPromptSender } from './promptDelivery'
import { createRoleHandlers } from './roleHandlers'
import { createRuntimeFrameRegistry } from './runtimeFrames'
import { getChatMessages, getChatRoles, mutateStore, requireChat, requireRole } from './storeAccess'

const runtimeFrames = createRuntimeFrameRegistry()

const log = {
  debug(event: string, details?: Record<string, unknown>): void {
    console.debug('[OpenTeam][background]', event, details || {})
  },
  info(event: string, details?: Record<string, unknown>): void {
    console.info('[OpenTeam][background]', event, details || {})
  },
  warn(event: string, details?: Record<string, unknown>): void {
    console.warn('[OpenTeam][background]', event, details || {})
  },
  error(event: string, details?: Record<string, unknown>): void {
    console.error('[OpenTeam][background]', event, details || {})
  },
}

const sendPrompt = createPromptSender({ log })

function now(): number {
  return Date.now()
}

function newId(prefix: string): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  return `${prefix}-${cryptoApi?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

async function broadcastStoreUpdated(store: OpenTeamStore, excludeTabId?: number): Promise<void> {
  await broadcastRuntimeStoreUpdated(store, { excludeTabId, legacyState: toLegacyState(store) })
}

function getRoleReplyHistory(store: OpenTeamStore, chat: GroupChat, roleId: string, limit = 100): string[] {
  return getChatMessages(store, chat)
    .filter(message => message.type === 'assistant' && message.roleId === roleId && message.content.trim())
    .slice(-limit)
    .map(message => message.content)
}

function getChatStatusFromRoles(store: OpenTeamStore, chat: GroupChat): GroupChat['status'] {
  const roles = getChatRoles(store, chat)
  if (roles.length === 0) return 'draft'
  if (roles.some(role => role.status === 'thinking' || role.status === 'loading')) return 'running'
  if (roles.some(role => role.status === 'error')) return 'error'
  return 'ready'
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

function isMeaningfulConversationId(value: string | undefined): value is string {
  return Boolean(value && value !== '__default__')
}

function mapRuntimeRoleStatus(value: unknown): RoleStatus | undefined {
  switch (value) {
    case 'opening':
    case 'offline':
      return 'loading'
    case 'sending':
    case 'generating':
      return 'thinking'
    case 'online':
    case 'idle':
      return 'ready'
    case 'error':
      return 'error'
    default:
      return undefined
  }
}

function markChatHasNewMessage(store: OpenTeamStore, chat: GroupChat): void {
  if (store.currentChatId === chat.id) return
  store.viewState ??= { chatReadSeqById: {}, chatHasNewMessageById: {} }
  store.viewState.chatHasNewMessageById ??= {}
  store.viewState.chatHasNewMessageById[chat.id] = true
}

async function handleStoreGet(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  rememberHost(sender, message.hostTabId)
  const store = await loadStore()
  return { ok: true, store, state: toLegacyState(store), bindings: runtimeFrames.list() }
}

async function handleSettingsUpdate(message: RuntimeMessage) {
  const { store } = await mutateStore(store => {
    const defaultChatSite = readOptionalString(message.defaultChatSite)
    if (defaultChatSite === 'chatgpt' || defaultChatSite === 'gemini' || defaultChatSite === 'claude') {
      store.settings.defaultChatSite = defaultChatSite
    }
  })
  await broadcastStoreUpdated(store)
  return { ok: true, store }
}

async function handleFrameRoleReady(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  const tabId = messageTabId(message, sender)
  if (tabId === undefined) throw new Error('缺少 sender tab')
  rememberHost(sender, tabId)

  const chatId = requireString(message.chatId, '缺少群聊 ID')
  const roleId = requireString(message.roleId, '缺少人员 ID')
  const frameId = senderFrameId(sender)
  const timestamp = now()
  log.info('frame-ready:received', {
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
  runtimeFrames.bind({ chatId, roleId, tabId, frameId, ready: true, lastSeenAt: timestamp })

  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const role = requireRole(store, chat.id, roleId)
    role.status = 'ready'
    role.updatedAt = timestamp
    updateConversation(role, readOptionalString(message.conversationUrl), readOptionalString(message.conversationId))
    chat.status = getChatStatusFromRoles(store, chat)
    chat.updatedAt = timestamp
    return { role, replyHistory: getRoleReplyHistory(store, chat, role.id) }
  })

  log.info('frame-ready:store-updated', { chatId, roleId, roleName: result.role.name, status: result.role.status, replyHistoryCount: result.replyHistory.length, binding: runtimeFrames.getByRole(chatId, roleId) })
  await broadcastStoreUpdated(store)
  return { ok: true, role: result.role, replyHistory: result.replyHistory, store }
}

async function handleConversationUpdated(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  const identity = readIdentity(message, sender)
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, identity.chatId)
    const role = requireRole(store, chat.id, identity.roleId)
    updateConversation(role, readOptionalString(message.conversationUrl), readOptionalString(message.conversationId))
    role.updatedAt = now()
    chat.updatedAt = role.updatedAt
    return role
  })
  await broadcastStoreUpdated(store)
  return { ok: true, role: result, store }
}

async function handleSendAck(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  const identity = readIdentity(message, sender)
  const messageId = requireString(message.messageId, '缺少消息 ID')
  log.info('send-ack:received', { ...identity, messageId, senderUrl: sender.url, tabId: messageTabId(message, sender), frameId: senderFrameId(sender) })
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
    role.updatedAt = now()
    chat.updatedAt = role.updatedAt
  })
  await broadcastStoreUpdated(store)
  return { ok: true, store }
}

async function handleRoleStatus(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  const mappedStatus = mapRuntimeRoleStatus(message.status)
  if (!mappedStatus) return { ok: false, error: '未知人员状态' }

  const identity = readIdentity(message, sender)
  const timestamp = now()
  log.info('role-status:received', {
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
    chat.status = getChatStatusFromRoles(store, chat)
    chat.updatedAt = timestamp
    return role
  })

  await broadcastStoreUpdated(store)
  return { ok: true, role: result, store }
}

async function handleRoleReply(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  const identity = readIdentity(message, sender)
  const content = requireString(message.content, '回复内容不能为空')
  const contentFormat = message.contentFormat === 'markdown' ? 'markdown' : undefined
  const promptMessageId = readOptionalString(message.messageId)
  const replyAttemptId = readOptionalString(message.replyAttemptId)
  const timestamp = now()
  log.info('role-reply:received', { ...identity, promptMessageId, replyAttemptId, contentLength: content.length, senderUrl: sender.url })

  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, identity.chatId)
    const role = requireRole(store, chat.id, identity.roleId)
    const staleReason = staleReplyReason(store, chat, role, promptMessageId, replyAttemptId)
    if (staleReason) {
      return { ignored: true as const, reason: staleReason, roleId: role.id, promptMessageId }
    }

    updateConversation(role, readOptionalString(message.conversationUrl), readOptionalString(message.conversationId))

    const reply: GroupMessage = {
      id: newId('msg'),
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
    chat.status = getChatStatusFromRoles(store, chat)
    chat.updatedAt = timestamp
    return { ignored: false as const, reply }
  })

  if (result.ignored) {
    log.warn('role-reply:ignored-stale', { ...identity, promptMessageId: result.promptMessageId, reason: result.reason })
    return { ok: true, ignored: true, reason: result.reason, store }
  }

  log.info('role-reply:stored', { chatId: result.reply.chatId, roleId: result.reply.roleId, replyMessageId: result.reply.id })
  await broadcastStoreUpdated(store)
  return { ok: true, message: result.reply, store }
}

async function handleRoleError(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  const identity = readIdentity(message, sender)
  const reason = readOptionalString(message.reason) ?? readOptionalString(message.error) ?? '人员执行失败'
  const promptMessageId = readOptionalString(message.messageId)
  const replyAttemptId = readOptionalString(message.replyAttemptId)
  log.warn('role-error:received', { ...identity, promptMessageId, replyAttemptId, reason, senderUrl: sender.url, tabId: messageTabId(message, sender), frameId: senderFrameId(sender) })

  const { store } = await mutateStore(store => {
    const chat = requireChat(store, identity.chatId)
    const role = requireRole(store, chat.id, identity.roleId)
    role.status = 'error'
    role.updatedAt = now()
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

  await broadcastStoreUpdated(store)
  await sendError(reason)
  return { ok: true, store }
}

function readIdentity(message: RuntimeMessage, sender: chrome.runtime.MessageSender): { chatId: string; roleId: string } {
  const chatId = readOptionalString(message.chatId)
  const roleId = readOptionalString(message.roleId)
  if (chatId && roleId) return { chatId, roleId }

  const tabId = messageTabId(message, sender)
  if (tabId !== undefined) {
    const binding = runtimeFrames.getByAddress(tabId, senderFrameId(sender))
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

function toLegacyState(store: OpenTeamStore) {
  const chat = store.currentChatId ? store.chatsById[store.currentChatId] : undefined
  const roles = chat ? getChatRoles(store, chat).map(role => ({
    id: role.id,
    name: role.name,
    tabId: runtimeFrames.getByRole(chat.id, role.id)?.tabId ?? -1,
    frameId: runtimeFrames.getByRole(chat.id, role.id)?.frameId,
    conversationId: role.geminiConversationId ?? '__default__',
    status: legacyStatus(role.status),
    createdAt: role.createdAt,
    lastMessageAt: role.lastReplyAt,
  })) : []
  const messages = chat ? getChatMessages(store, chat).map(message => ({
    id: message.id,
    roomId: chat.id,
    roleId: message.roleId,
    roleName: message.roleName,
    from: message.type === 'assistant' ? 'role' : message.type,
    target: message.targetRoleIds && message.targetRoleIds.length > 0 ? message.targetRoleIds.length === roles.length ? 'all' : 'role' : 'none',
    targetRoleName: message.targetRoleIds?.length === 1 ? store.rolesById[message.targetRoleIds[0]]?.name : undefined,
    content: message.content,
    createdAt: message.createdAt,
    status: message.status,
  })) : []

  return { roomId: chat?.id ?? 'group-empty', hostTabId: listHostTabIds()[0] ?? -1, roles, messages }
}

function legacyStatus(status: GroupRole['status']): string {
  if (status === 'pending' || status === 'loading') return 'opening'
  if (status === 'ready') return 'idle'
  if (status === 'thinking') return 'generating'
  return 'error'
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

function requireString(value: unknown, error: string): string {
  const result = readOptionalString(value)
  if (!result) throw new Error(error)
  return result
}

async function handleLegacyHostReady(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  rememberHost(sender, message.hostTabId)
  const store = await loadStore()
  return { ok: true, store, state: toLegacyState(store) }
}

async function handleLegacyCreateRole(message: RuntimeMessage) {
  const store = await loadStore()
  let chatId = store.currentChatId
  if (!chatId) {
    const created = await routeMessage({ type: 'GROUP_CHAT_CREATE', name: 'OpenTeam', mode: 'independent' }, {}) as { chat: GroupChat }
    chatId = created.chat.id
  }

  return routeMessage({ type: 'GROUP_ROLE_CREATE', chatId, name: message.name }, {})
}

const routeMessage = createMessageRouter([
  { type: 'GROUP_STORE_GET', handler: handleStoreGet },
  ...createChatHandlers({ broadcastStoreUpdated, getChatStatusFromRoles, log, newId, now, runtimeFrames }),
  { type: 'GROUP_SETTINGS_UPDATE', handler: handleSettingsUpdate },
  ...createRoleHandlers({ broadcastStoreUpdated, log, newId, now, runtimeFrames, sendPrompt }),
  ...createMessageHandlers({ broadcastStoreUpdated, log, newId, now, runtimeFrames, sendError, sendPrompt }),
  {
    type: 'TEAM_FRAME_ROLE_READY',
    handler: (message, sender) => readOptionalString(message.chatId) ? handleFrameRoleReady(message, sender) : { ok: false, error: 'TEAM_FRAME_ROLE_READY 缺少 chatId' },
  },
  { type: 'TEAM_ROLE_CONVERSATION_UPDATED', handler: handleConversationUpdated },
  { type: 'TEAM_SEND_ACK', handler: handleSendAck },
  { type: 'TEAM_ROLE_STATUS', handler: handleRoleStatus },
  { type: 'TEAM_ROLE_REPLY', handler: handleRoleReply },
  { type: 'TEAM_ROLE_ERROR', handler: handleRoleError },
  { type: 'TEAM_HOST_READY', handler: handleLegacyHostReady },
  { type: 'TEAM_GET_STATE', handler: handleLegacyHostReady },
  { type: 'TEAM_CREATE_ROLE', handler: handleLegacyCreateRole },
  {
    type: 'TEAM_SEND_MESSAGE',
    handler: async message => {
      const store = await loadStore()
      if (!store.currentChatId) return { ok: false, error: '请先创建群聊' }
      return routeMessage({ type: 'GROUP_MESSAGE_SEND', chatId: store.currentChatId, raw: message.raw }, {})
    },
  },
])

chrome.runtime.onInstalled.addListener(() => {
  log.info('extension-installed')
})

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message?.type === 'OPENTEAM_PING') {
    sendResponse({ ok: true, tabId: sender.tab?.id ?? null })
    return true
  }

  Promise.resolve(routeMessage(message, sender))
    .then(sendResponse)
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      log.error('message-handler:failed', { type: message?.type, error: reason })
      sendError(reason).catch(() => undefined)
      sendResponse({ ok: false, error: reason })
    })

  return true
})

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('team.html'), active: true }).catch(error => {
    log.warn('open-team-page:failed', { error: error instanceof Error ? error.message : String(error) })
  })
})

chrome.tabs.onRemoved.addListener(tabId => {
  forgetHostTab(tabId)
  const removed = runtimeFrames.removeTab(tabId)
  if (removed.length === 0) return

  mutateStore(store => {
    const timestamp = now()
    for (const binding of removed) {
      const role = store.rolesById[binding.roleId]
      if (!role || role.chatId !== binding.chatId || role.status === 'thinking') continue
      role.status = 'loading'
      role.updatedAt = timestamp
    }
  })
    .then(({ store }) => broadcastStoreUpdated(store))
    .catch(error => log.warn('tab-removed:update-failed', { tabId, error: error instanceof Error ? error.message : String(error) }))
})
