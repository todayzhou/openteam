import { buildUnsyncedContext } from '../group/contextSync'
import { extractSupportedConversationId, getDefaultChatSiteUrl, normalizeSupportedChatConversationUrl } from '../group/conversationUrl'
import { parseGroupMentions } from '../group/mentionParser'
import { buildPrompt, buildReinitPrompt } from '../group/promptBuilder'
import {
  createGroupRole,
  createGroupRolesBatch,
  createRoleTemplate,
  deleteGroupRole,
  deleteRoleTemplate,
  getRoleTemplateUsage,
  updateGroupRole,
  updateRoleTemplate,
} from '../group/roleTemplates'
import { loadStore } from '../group/store'
import type { ChatSite, GroupChat, GroupMessage, GroupRole, MessageReference, OpenTeamStore, RoleStatus, RoomMode, RuntimeFrameBinding } from '../group/types'
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
import { createRuntimeFrameRegistry } from './runtimeFrames'
import { getChatMessages, getChatRoles, mutateStore, requireChat, requireRole } from './storeAccess'

type SendPromptMessage = {
  type: 'TEAM_SEND_PROMPT'
  chatId: string
  roleId: string
  messageId: string
  replyAttemptId?: string
  content: string
  autoSend?: boolean
  includesPersona?: boolean
}

interface PromptDelivery {
  roleId: string
  tabId: number
  frameId: number
  message: SendPromptMessage
}

const STALE_THINKING_MS = 120_000
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

async function sendPrompt(delivery: PromptDelivery): Promise<void> {
  log.info('prompt:send:start', {
    chatId: delivery.message.chatId,
    roleId: delivery.roleId,
    messageId: delivery.message.messageId,
    tabId: delivery.tabId,
    frameId: delivery.frameId,
    contentLength: delivery.message.content.length,
    includesPersona: delivery.message.includesPersona ?? false,
  })

  try {
    const response = await chrome.tabs.sendMessage(delivery.tabId, delivery.message, { frameId: delivery.frameId })
    if (isRecord(response) && response.ok === false) {
      throw new Error(readOptionalString(response.error) ?? readOptionalString(response.message) ?? 'Gemini prompt delivery failed')
    }
    log.info('prompt:send:response', {
      chatId: delivery.message.chatId,
      roleId: delivery.roleId,
      messageId: delivery.message.messageId,
      tabId: delivery.tabId,
      frameId: delivery.frameId,
      response,
    })
  } catch (error) {
    log.warn('prompt:send:failed', {
      chatId: delivery.message.chatId,
      roleId: delivery.roleId,
      messageId: delivery.message.messageId,
      tabId: delivery.tabId,
      frameId: delivery.frameId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
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

function isStaleThinkingRole(role: GroupRole, timestamp: number): boolean {
  return role.status === 'thinking' && timestamp - role.updatedAt >= STALE_THINKING_MS
}

function isRoleDeliverable(role: GroupRole, binding: RuntimeFrameBinding | undefined, timestamp: number): boolean {
  if (!binding?.ready) return false
  return role.status === 'ready' || role.status === 'error' || role.status === 'loading' || role.status === 'pending' || isStaleThinkingRole(role, timestamp)
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

function resolveRetryUserMessage(store: OpenTeamStore, chat: GroupChat, role: GroupRole, requestedMessageId: string | undefined): GroupMessage | undefined {
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

function isMeaningfulConversationId(value: string | undefined): value is string {
  return Boolean(value && value !== '__default__')
}

function recoverDeliverableRoleStatus(role: GroupRole, timestamp: number): void {
  if (role.status === 'ready') return

  log.warn('role:auto-recover-status', { roleId: role.id, roleName: role.name, previousStatus: role.status, lastPromptMessageId: role.lastPromptMessageId })
  role.status = 'ready'
  delete role.lastPromptMessageId
  delete role.replyAttemptId
  role.updatedAt = timestamp
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

function readRoomMode(value: unknown, fallback: RoomMode): RoomMode {
  return value === 'collaborative' || value === 'independent' ? value : fallback
}

function markChatRead(store: OpenTeamStore, chat: GroupChat): void {
  store.viewState ??= { chatReadSeqById: {}, chatHasNewMessageById: {} }
  store.viewState.chatReadSeqById ??= {}
  store.viewState.chatHasNewMessageById ??= {}
  store.viewState.chatReadSeqById[chat.id] = chat.nextMessageSeq - 1
  delete store.viewState.chatHasNewMessageById[chat.id]
}

function markChatHasNewMessage(store: OpenTeamStore, chat: GroupChat): void {
  if (store.currentChatId === chat.id) return
  store.viewState ??= { chatReadSeqById: {}, chatHasNewMessageById: {} }
  store.viewState.chatHasNewMessageById ??= {}
  store.viewState.chatHasNewMessageById[chat.id] = true
}

function createChat(store: OpenTeamStore, message: RuntimeMessage, timestamp: number): GroupChat {
  const name = typeof message.name === 'string' && message.name.trim() ? message.name.trim() : '新群聊'
  const description = readOptionalString(message.description)
  const chat: GroupChat = {
    id: newId('chat'),
    name,
    ...(description ? { description } : {}),
    mode: readRoomMode(message.mode, store.settings.defaultMode),
    roleIds: [],
    messageIds: [],
    nextMessageSeq: 1,
    status: 'initializing',
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  store.chatsById[chat.id] = chat
  store.chatOrder.unshift(chat.id)
  store.currentChatId = chat.id

  const roles = Array.isArray(message.roles) ? message.roles : []
  for (const input of roles) {
    if (!isRecord(input)) continue
    createGroupRole(store, {
      chatId: chat.id,
      templateId: readOptionalString(input.roleTemplateId) ?? readOptionalString(input.templateId),
      name: readOptionalString(input.name),
      description: readOptionalString(input.description),
      systemPrompt: readOptionalString(input.systemPrompt),
    }, newId('role'), timestamp)
  }

  chat.status = chat.roleIds.length > 0 ? 'initializing' : 'draft'
  return chat
}

function duplicatedChatName(store: OpenTeamStore, sourceName: string): string {
  const baseName = `${sourceName} 副本`
  const existingNames = new Set(store.chatOrder.map(chatId => store.chatsById[chatId]?.name).filter(Boolean))
  if (!existingNames.has(baseName)) return baseName

  let index = 2
  while (existingNames.has(`${baseName} ${index}`)) index += 1
  return `${baseName} ${index}`
}

function duplicateChat(store: OpenTeamStore, sourceChatId: unknown, timestamp: number): { chat: GroupChat; roles: GroupRole[] } {
  const sourceChat = requireChat(store, sourceChatId)
  const chat: GroupChat = {
    id: newId('chat'),
    name: duplicatedChatName(store, sourceChat.name),
    ...(sourceChat.description ? { description: sourceChat.description } : {}),
    mode: sourceChat.mode,
    roleIds: [],
    messageIds: [],
    nextMessageSeq: 1,
    status: sourceChat.roleIds.length > 0 ? 'initializing' : 'draft',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const roles: GroupRole[] = []

  store.chatsById[chat.id] = chat
  store.chatOrder.unshift(chat.id)
  store.currentChatId = chat.id

  for (const sourceRoleId of sourceChat.roleIds) {
    const sourceRole = store.rolesById[sourceRoleId]
    if (!sourceRole) continue
    const role: GroupRole = {
      id: newId('role'),
      chatId: chat.id,
      ...(sourceRole.templateId ? { templateId: sourceRole.templateId } : {}),
      name: sourceRole.name,
      ...(sourceRole.description ? { description: sourceRole.description } : {}),
      ...(sourceRole.systemPrompt ? { systemPrompt: sourceRole.systemPrompt } : {}),
      ...(sourceRole.avatarColor ? { avatarColor: sourceRole.avatarColor } : {}),
      status: 'pending',
      contextCursor: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    store.rolesById[role.id] = role
    chat.roleIds.push(role.id)
    roles.push(role)
  }

  return { chat, roles }
}

async function handleStoreGet(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  rememberHost(sender, message.hostTabId)
  const store = await loadStore()
  return { ok: true, store, state: toLegacyState(store), bindings: runtimeFrames.list() }
}

async function handleChatCreate(message: RuntimeMessage) {
  const { store, result } = await mutateStore(store => createChat(store, message, now()))
  await broadcastStoreUpdated(store)
  return { ok: true, chat: result, store }
}

async function handleChatDuplicate(message: RuntimeMessage) {
  const { store, result } = await mutateStore(store => duplicateChat(store, message.chatId, now()))
  log.info('chat-duplicate:stored', { sourceChatId: message.chatId, chatId: result.chat.id, roleCount: result.roles.length })
  await broadcastStoreUpdated(store)
  return { ok: true, chat: result.chat, roles: result.roles, store }
}

async function handleChatSwitch(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  const { store } = await mutateStore(store => {
    const chat = requireChat(store, message.chatId)
    store.currentChatId = chat.id
    markChatRead(store, chat)
    chat.updatedAt = now()
  })
  await broadcastStoreUpdated(store, messageTabId(message, sender))
  return { ok: true, store }
}

async function handleChatUpdate(message: RuntimeMessage) {
  const patch = isRecord(message.patch) ? message.patch : message
  const timestamp = now()
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, message.chatId)
    const patchKeys: string[] = []

    if (patch.name !== undefined) {
      const name = requireString(patch.name, '群聊名称不能为空')
      chat.name = name
      patchKeys.push('name')
    }

    if (patch.description !== undefined) {
      const description = readOptionalString(patch.description)
      if (description) {
        chat.description = description
      } else {
        delete chat.description
      }
      patchKeys.push('description')
    }

    chat.updatedAt = timestamp
    return { chat, patchKeys }
  })
  log.info('chat-update:stored', { chatId: result.chat.id, patchKeys: result.patchKeys })
  await broadcastStoreUpdated(store)
  return { ok: true, chat: result.chat, store }
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

async function handleChatDelete(message: RuntimeMessage) {
  const chatId = requireString(message.chatId, '缺少群聊 ID')
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const roleIds = [...chat.roleIds]
    const messageIds = [...chat.messageIds]

    for (const roleId of roleIds) {
      delete store.rolesById[roleId]
      runtimeFrames.removeRole(chat.id, roleId)
    }
    for (const messageId of messageIds) delete store.messagesById[messageId]

    store.chatOrder = store.chatOrder.filter(id => id !== chat.id)
    delete store.chatsById[chat.id]
    if (store.currentChatId === chat.id) store.currentChatId = store.chatOrder[0]
    if (store.viewState?.chatReadSeqById) delete store.viewState.chatReadSeqById[chat.id]
    if (store.viewState?.chatHasNewMessageById) delete store.viewState.chatHasNewMessageById[chat.id]

    return { chatId: chat.id, roleIds, messageIds }
  })
  log.info('chat-delete:stored', { chatId: result.chatId, roleCount: result.roleIds.length, messageCount: result.messageIds.length })
  await broadcastStoreUpdated(store)
  return { ok: true, chatId: result.chatId, store }
}

async function handleChatClearMessages(message: RuntimeMessage) {
  const chatId = requireString(message.chatId, '缺少群聊 ID')
  const timestamp = now()
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const roleIds = [...chat.roleIds]
    const messageIds = [...chat.messageIds]

    for (const messageId of messageIds) delete store.messagesById[messageId]
    chat.messageIds = []
    chat.nextMessageSeq = 1
    chat.updatedAt = timestamp

    for (const roleId of roleIds) {
      const role = store.rolesById[roleId]
      if (!role) continue
      runtimeFrames.removeRole(chat.id, role.id)
      role.status = 'loading'
      role.contextCursor = 0
      role.updatedAt = timestamp
      delete role.geminiConversationId
      delete role.geminiConversationUrl
      delete role.lastPromptMessageId
      delete role.replyAttemptId
    }

    chat.status = roleIds.length > 0 ? 'initializing' : 'draft'
    markChatRead(store, chat)
    return { chatId: chat.id, roleIds, messageIds }
  })
  log.info('chat-clear-messages:stored', { chatId: result.chatId, roleCount: result.roleIds.length, messageCount: result.messageIds.length })
  await broadcastStoreUpdated(store)
  return { ok: true, chatId: result.chatId, store }
}

async function handleChatClose(message: RuntimeMessage) {
  const chatId = requireString(message.chatId, '缺少群聊 ID')
  const timestamp = now()
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const roleIds = [...chat.roleIds]

    for (const roleId of roleIds) {
      const role = store.rolesById[roleId]
      if (!role) continue
      runtimeFrames.removeRole(chat.id, role.id)
      if (role.status !== 'thinking') role.status = 'loading'
      role.updatedAt = timestamp
    }
    chat.status = getChatStatusFromRoles(store, chat)
    chat.updatedAt = timestamp
    return { chatId: chat.id, roleIds }
  })
  log.info('chat-close:stored', { chatId: result.chatId, roleCount: result.roleIds.length })
  await broadcastStoreUpdated(store)
  return { ok: true, chatId: result.chatId, store }
}

async function handleChatMarkRead(message: RuntimeMessage) {
  const { store } = await mutateStore(store => {
    const chat = requireChat(store, message.chatId)
    markChatRead(store, chat)
  })
  await broadcastStoreUpdated(store)
  return { ok: true, store }
}

async function handleRoleTemplateCreate(message: RuntimeMessage) {
  const { store, result } = await mutateStore(store => createRoleTemplate(store, {
    name: requireString(message.name, '人员名称不能为空'),
    description: readOptionalString(message.description),
    systemPrompt: readOptionalString(message.systemPrompt),
    defaultChatSite: readChatSite(message.defaultChatSite),
  }, newId('template'), now()))
  log.info('role-template:create', { templateId: result.id, nameLength: result.name.length, personaLength: result.systemPrompt.length })
  await broadcastStoreUpdated(store)
  return { ok: true, template: result, store }
}

async function handleRoleTemplateUpdate(message: RuntimeMessage) {
  const patch = isRecord(message.patch) ? message.patch : message
  const { store, result } = await mutateStore(store => updateRoleTemplate(store, requireString(message.templateId, '缺少模板 ID'), {
    name: requireString(patch.name, '人员名称不能为空'),
    description: readOptionalString(patch.description),
    systemPrompt: readOptionalString(patch.systemPrompt),
    defaultChatSite: readChatSite(patch.defaultChatSite),
  }, now()))
  log.info('role-template:update', { templateId: result.id, patchKeys: ['name', 'description', 'systemPrompt'], personaLength: result.systemPrompt.length })
  await broadcastStoreUpdated(store)
  return { ok: true, template: result, store }
}

async function handleRoleTemplateDelete(message: RuntimeMessage) {
  const templateId = requireString(message.templateId, '缺少模板 ID')
  const { store } = await mutateStore(store => {
    const usage = getRoleTemplateUsage(store, templateId)
    if (usage.usedByChatIds.length > 0) {
      log.warn('role-template:delete-denied', { templateId, usedByChatCount: usage.usedByChatIds.length })
    }
    deleteRoleTemplate(store, templateId)
  })
  log.warn('role-template:delete', { templateId })
  await broadcastStoreUpdated(store)
  return { ok: true, store }
}

async function handleRoleCreate(message: RuntimeMessage) {
  const timestamp = now()
  const chatId = requireString(message.chatId, '缺少群聊 ID')
  const templateId = readOptionalString(message.roleTemplateId) ?? readOptionalString(message.templateId)
  const { store, result } = await mutateStore(store => createGroupRole(store, {
    chatId,
    templateId,
    chatSite:
      message.chatSite === 'chatgpt'
        ? 'chatgpt'
        : message.chatSite === 'claude'
          ? 'claude'
          : message.chatSite === 'gemini'
            ? 'gemini'
            : undefined,
    name: readOptionalString(message.name),
    description: readOptionalString(message.description),
    systemPrompt: readOptionalString(message.systemPrompt),
    avatarColor: readOptionalString(message.avatarColor),
  }, newId('role'), timestamp))
  log.info('role-create:stored', { chatId, roleId: result.id, source: templateId ? 'library' : 'temporary' })
  await broadcastStoreUpdated(store)
  return { ok: true, role: result, store }
}

async function handleRolesCreateBatch(message: RuntimeMessage) {
  const chatId = requireString(message.chatId, '缺少群聊 ID')
  const rawItems = Array.isArray(message.items) ? message.items : []
  log.info('role-create-batch:start', { chatId, itemCount: rawItems.length, source: getRawBatchSource(rawItems) })

  try {
    const items = rawItems.map(readGroupRoleBatchItem)
    const timestamp = now()
    const { store, result } = await mutateStore(store => createGroupRolesBatch(store, chatId, items, () => newId('role'), timestamp))
    log.info('role-create-batch:stored', {
      chatId,
      roleIds: result.map(role => role.id),
      templateIds: result.map(role => role.templateId).filter(Boolean),
      itemCount: result.length,
      source: getBatchSource(items),
    })
    await broadcastStoreUpdated(store)
    return { ok: true, roles: result, store }
  } catch (error) {
    log.warn('role-create-batch:failed', { chatId, itemCount: rawItems.length, source: getRawBatchSource(rawItems), error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

async function handleRoleUpdate(message: RuntimeMessage) {
  const patch = isRecord(message.patch) ? message.patch : message
  const roleId = requireString(message.roleId, '缺少人员 ID')
  const { store, result } = await mutateStore(store => {
    const role = store.rolesById[roleId]
    const previousChatSite = role?.chatSite
    const updatedRole = updateGroupRole(store, roleId, {
      name: readOptionalString(patch.name),
      description: readOptionalString(patch.description),
      systemPrompt: readOptionalString(patch.systemPrompt),
      avatarColor: readOptionalString(patch.avatarColor),
      chatSite:
        patch.chatSite === 'chatgpt'
          ? 'chatgpt'
          : patch.chatSite === 'claude'
            ? 'claude'
            : patch.chatSite === 'gemini'
              ? 'gemini'
              : undefined,
    }, now())
    const siteChanged = previousChatSite !== updatedRole.chatSite
    if (siteChanged) runtimeFrames.removeRole(updatedRole.chatId, updatedRole.id)
    return { role: updatedRole, siteChanged }
  })
  await broadcastStoreUpdated(store)
  return { ok: true, role: result.role, siteChanged: result.siteChanged, store }
}

async function handleRoleRecover(message: RuntimeMessage) {
  log.info('role-recover:start', { chatId: message.chatId, roleId: message.roleId, hostTabId: message.hostTabId })
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, message.chatId)
    const role = requireRole(store, chat.id, message.roleId)
    const wasThinking = role.status === 'thinking'
    role.status = 'loading'
    if (wasThinking && role.lastPromptMessageId) role.replyAttemptId = newId('attempt')
    role.updatedAt = now()
    chat.status = 'initializing'
    chat.updatedAt = role.updatedAt
    return { role, iframeSrc: normalizeSupportedChatConversationUrl(role.geminiConversationUrl) ?? getDefaultChatSiteUrl(role.chatSite ?? store.settings.defaultChatSite) }
  })
  log.info('role-recover:ready', { roleId: result.role.id, roleName: result.role.name, iframeSrc: result.iframeSrc, status: result.role.status })
  await broadcastStoreUpdated(store)
  return { ok: true, ...result, store }
}

async function handleRoleReinitialize(message: RuntimeMessage) {
  const chatId = requireString(message.chatId, '缺少群聊 ID')
  const roleId = requireString(message.roleId, '缺少人员 ID')
  const binding = runtimeFrames.getByRole(chatId, roleId)
  log.info('role-reinitialize:start', { chatId, roleId, binding })
  if (!binding?.ready) throw new Error('人员 iframe 尚未就绪，请先恢复人员')

  const timestamp = now()
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const role = requireRole(store, chat.id, roleId)
    const roles = getChatRoles(store, chat)
    if (role.status !== 'ready') throw new Error(`人员不可用：${role.name}`)

    const messageId = newId('init')
    const replyAttemptId = newId('attempt')
    role.status = 'thinking'
    role.lastPromptMessageId = messageId
    role.replyAttemptId = replyAttemptId
    role.updatedAt = timestamp
    chat.status = 'running'
    chat.updatedAt = timestamp

    return {
      delivery: {
        roleId,
        tabId: binding.tabId,
        frameId: binding.frameId,
        message: {
          type: 'TEAM_SEND_PROMPT' as const,
          chatId,
          roleId,
          messageId,
          replyAttemptId,
          content: buildReinitPrompt(chat, role, roles),
          includesPersona: true,
        },
      },
    }
  })

  log.info('role-reinitialize:deliver', {
    chatId,
    roleId,
    messageId: result.delivery.message.messageId,
    tabId: result.delivery.tabId,
    frameId: result.delivery.frameId,
    contentLength: result.delivery.message.content.length,
  })
  await broadcastStoreUpdated(store)
  await sendPrompt(result.delivery)
  return { ok: true, store, messageId: result.delivery.message.messageId }
}

async function handleMessageSend(message: RuntimeMessage) {
  const chatId = requireString(message.chatId, '缺少群聊 ID')
  const raw = requireString(message.raw, '消息内容不能为空')
  const timestamp = now()
  log.info('message-send:start', { chatId, rawLength: raw.length })

  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const roles = getChatRoles(store, chat)
    const parsed = parseGroupMentions(raw, roles)
    if (!parsed.ok) throw new Error(parsed.error)
    if (parsed.targetRoleIds.length === 0) throw new Error('当前群聊没有可投递人员')
    log.debug('message-send:parsed-targets', { chatId: chat.id, targetRoleIds: parsed.targetRoleIds })

    const targetRoles = parsed.targetRoleIds.map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role))
    const unavailable = targetRoles.filter(role => !isRoleDeliverable(role, runtimeFrames.getByRole(chat.id, role.id), timestamp))

    if (unavailable.length > 0) {
      log.warn('message-send:unavailable-targets', {
        chatId: chat.id,
        targets: unavailable.map(role => ({
          id: role.id,
          name: role.name,
          status: role.status,
          updatedAt: role.updatedAt,
          staleThinking: isStaleThinkingRole(role, timestamp),
          binding: runtimeFrames.getByRole(chat.id, role.id),
        })),
      })
      throw new Error(`以下人员不可用，请等待或恢复：${unavailable.map(role => role.name).join('、')}`)
    }

    for (const role of targetRoles) recoverDeliverableRoleStatus(role, timestamp)

    const reference = resolveReference(store, chat, message.reference ?? (Array.isArray(message.references) ? message.references[0] : undefined))
    const userMessage: GroupMessage = {
      id: newId('msg'),
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
    log.info('message-send:stored', { chatId: chat.id, messageId: userMessage.id, targetCount: parsed.targetRoleIds.length })
    chat.status = 'running'
    chat.updatedAt = timestamp

    const messages = getChatMessages(store, chat)
    const deliveries: PromptDelivery[] = parsed.targetRoleIds.map(roleId => {
      const role = requireRole(store, chat.id, roleId)
      const binding = runtimeFrames.getByRole(chat.id, role.id)!
      const unsyncedContext = buildUnsyncedContext(chat, role, messages, userMessage, store.settings.maxContextChars)
      const roleHistoryCount = countLocalRoleHistory(messages, role, userMessage.id)
      const includesPersona = shouldIncludePersonaForPrompt(roleHistoryCount)
      const content = buildPrompt({ chat, role, userMessage, roles, unsyncedContext, reference, includePersona: includesPersona })
      const replyAttemptId = newId('attempt')
      if (!includesPersona) {
        log.debug('prompt:persona-skipped', {
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

  log.info('message-send:deliveries-ready', {
    chatId,
    messageId: result.message.id,
    deliveries: result.deliveries.map(delivery => ({ roleId: delivery.roleId, tabId: delivery.tabId, frameId: delivery.frameId, contentLength: delivery.message.content.length })),
  })
  await broadcastStoreUpdated(store)

  for (const delivery of result.deliveries) {
    try {
      await sendPrompt(delivery)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await markDeliveryError(chatId, delivery.roleId, result.message.id, reason)
    }
  }

  return { ok: true, message: result.message, deliveries: result.deliveries.map(delivery => ({ roleId: delivery.roleId })), store }
}

async function handleRoleRetryReply(message: RuntimeMessage) {
  const chatId = requireString(message.chatId, '缺少群聊 ID')
  const roleId = requireString(message.roleId, '缺少人员 ID')
  const timestamp = now()
  const binding = runtimeFrames.getByRole(chatId, roleId)
  if (!binding?.ready) throw new Error('人员 iframe 尚未就绪，请先恢复人员')

  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const role = requireRole(store, chat.id, roleId)
    const requestedMessageId = readOptionalString(message.messageId)
    const userMessage = resolveRetryUserMessage(store, chat, role, requestedMessageId)
    if (!userMessage) throw new Error(requestedMessageId ? '该消息没有发送给这个人员' : '找不到可重试的用户消息')

    const roles = getChatRoles(store, chat)
    const messages = getChatMessages(store, chat)
    const reference = userMessage.references?.[0]
    const unsyncedContext = buildUnsyncedContext(chat, role, messages, userMessage, store.settings.maxContextChars)
    const roleHistoryCount = countLocalRoleHistory(messages, role, userMessage.id)
    const includesPersona = shouldIncludePersonaForPrompt(roleHistoryCount)
    const content = buildPrompt({ chat, role, userMessage, roles, unsyncedContext, reference, includePersona: includesPersona })
    const replyAttemptId = newId('attempt')

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

  log.info('role-retry-reply:deliver', {
    chatId,
    roleId,
    messageId: result.delivery.message.messageId,
    replyAttemptId: result.delivery.message.replyAttemptId,
    tabId: result.delivery.tabId,
    frameId: result.delivery.frameId,
  })
  await broadcastStoreUpdated(store)
  try {
    await sendPrompt(result.delivery)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await markDeliveryError(chatId, roleId, result.delivery.message.messageId, reason)
  }
  return { ok: true, store, messageId: result.delivery.message.messageId }
}

async function markDeliveryError(chatId: string, roleId: string, messageId: string, reason: string): Promise<void> {
  log.warn('delivery:error', { chatId, roleId, messageId, reason })
  const { store } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const role = requireRole(store, chat.id, roleId)
    role.status = 'error'
    role.updatedAt = now()
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
  await broadcastStoreUpdated(store)
  await sendError(reason)
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

function resolveReference(store: OpenTeamStore, chat: GroupChat, raw: unknown): MessageReference | undefined {
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

function readGroupRoleBatchItem(value: unknown): Parameters<typeof createGroupRolesBatch>[2][number] {
  if (!isRecord(value)) throw new Error('添加人员项无效')
  const chatSite =
    value.chatSite === 'chatgpt'
      ? 'chatgpt'
      : value.chatSite === 'claude'
        ? 'claude'
        : value.chatSite === 'gemini'
          ? 'gemini'
          : undefined

  if (value.source === 'library') {
    return {
      source: 'library',
      roleTemplateId: requireString(value.roleTemplateId ?? value.templateId, '缺少人员库 ID'),
      chatSite,
      avatarColor: readOptionalString(value.avatarColor),
    }
  }

  if (value.source === 'temporary') {
    return {
      source: 'temporary',
      name: requireString(value.name, '人员名称不能为空'),
      description: readOptionalString(value.description),
      systemPrompt: requireString(value.systemPrompt, '人设不能为空'),
      chatSite,
      avatarColor: readOptionalString(value.avatarColor),
    }
  }

  throw new Error('添加人员来源无效')
}

function getBatchSource(items: Parameters<typeof createGroupRolesBatch>[2]): 'library' | 'temporary' | 'mixed' {
  const sources = new Set(items.map(item => item.source))
  if (sources.size === 1) return items[0]?.source ?? 'mixed'
  return 'mixed'
}

function getRawBatchSource(items: unknown[]): 'library' | 'temporary' | 'mixed' {
  const sources = new Set(items.map(item => (isRecord(item) && (item.source === 'library' || item.source === 'temporary')) ? item.source : 'mixed'))
  if (sources.size === 1) return sources.values().next().value as 'library' | 'temporary' | 'mixed'
  return 'mixed'
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

function requireString(value: unknown, error: string): string {
  const result = readOptionalString(value)
  if (!result) throw new Error(error)
  return result
}

function readChatSite(value: unknown): ChatSite | undefined {
  return value === 'chatgpt' || value === 'claude' || value === 'gemini' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    const created = await handleChatCreate({ type: 'GROUP_CHAT_CREATE', name: 'OpenTeam', mode: 'independent' })
    chatId = created.chat.id
  }

  return handleRoleCreate({ type: 'GROUP_ROLE_CREATE', chatId, name: message.name })
}

const routeMessage = createMessageRouter([
  { type: 'GROUP_STORE_GET', handler: handleStoreGet },
  { type: 'GROUP_CHAT_CREATE', handler: handleChatCreate },
  { type: 'GROUP_CHAT_DUPLICATE', handler: handleChatDuplicate },
  { type: 'GROUP_CHAT_SWITCH', handler: handleChatSwitch },
  { type: 'GROUP_CHAT_UPDATE', handler: handleChatUpdate },
  { type: 'GROUP_SETTINGS_UPDATE', handler: handleSettingsUpdate },
  { type: 'GROUP_CHAT_DELETE', handler: handleChatDelete },
  { type: 'GROUP_CHAT_CLEAR_MESSAGES', handler: handleChatClearMessages },
  { type: 'GROUP_CHAT_CLOSE', handler: handleChatClose },
  { type: 'GROUP_CHAT_MARK_READ', handler: handleChatMarkRead },
  { type: 'ROLE_TEMPLATE_CREATE', handler: handleRoleTemplateCreate },
  { type: 'ROLE_TEMPLATE_UPDATE', handler: handleRoleTemplateUpdate },
  { type: 'ROLE_TEMPLATE_DELETE', handler: handleRoleTemplateDelete },
  { type: 'GROUP_ROLE_CREATE', handler: handleRoleCreate },
  { type: 'GROUP_ROLES_CREATE_BATCH', handler: handleRolesCreateBatch },
  { type: 'GROUP_ROLE_UPDATE', handler: handleRoleUpdate },
  {
    type: 'GROUP_ROLE_DELETE',
    handler: async message => {
      const result = await mutateStore(store => deleteGroupRole(store, requireString(message.roleId, '缺少人员 ID'), now()))
      await broadcastStoreUpdated(result.store)
      return { ok: true, store: result.store }
    },
  },
  { type: 'GROUP_ROLE_RECOVER', handler: handleRoleRecover },
  { type: 'GROUP_ROLE_REINITIALIZE', handler: handleRoleReinitialize },
  { type: 'GROUP_ROLE_RETRY_REPLY', handler: handleRoleRetryReply },
  { type: 'GROUP_MESSAGE_SEND', handler: handleMessageSend },
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
      return handleMessageSend({ type: 'GROUP_MESSAGE_SEND', chatId: store.currentChatId, raw: message.raw })
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
