import { buildUnsyncedContext } from '../group/contextSync'
import { extractGeminiConversationId, normalizeGeminiConversationUrl } from '../group/conversationUrl'
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
import { loadStore, updateStoreQueued } from '../group/store'
import type { GroupChat, GroupMessage, GroupRole, MessageReference, OpenTeamStore, RoleStatus, RoomMode, RuntimeFrameBinding } from '../group/types'
import { createRuntimeFrameRegistry } from './runtimeFrames'

type RuntimeMessage = { type?: string; [key: string]: unknown }

type SendPromptMessage = {
  type: 'TEAM_SEND_PROMPT'
  chatId: string
  roleId: string
  messageId: string
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

interface StoreMutationResult<T> {
  store: OpenTeamStore
  result: T
}

const GROUP_PUSH_TYPE = 'OPENTEAM_GROUP_PUSH'
const LEGACY_PUSH_TYPE = 'OPENTEAM_HOST_PUSH'
const DEFAULT_GEMINI_URL = 'https://gemini.google.com/'
const STALE_THINKING_MS = 120_000
const runtimeFrames = createRuntimeFrameRegistry()
const hostTabIds = new Set<number>()

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

function senderTabId(sender: chrome.runtime.MessageSender): number | undefined {
  return sender.tab?.id
}

function senderFrameId(sender: chrome.runtime.MessageSender): number {
  return sender.frameId ?? 0
}

function explicitTabId(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function messageTabId(message: RuntimeMessage, sender: chrome.runtime.MessageSender): number | undefined {
  return senderTabId(sender) ?? explicitTabId(message.hostTabId)
}

function rememberHost(sender: chrome.runtime.MessageSender, explicitTabIdValue?: unknown): void {
  const tabId = senderTabId(sender) ?? explicitTabId(explicitTabIdValue)
  if (tabId !== undefined) hostTabIds.add(tabId)
}

async function mutateStore<T>(mutator: (store: OpenTeamStore) => T | Promise<T>): Promise<StoreMutationResult<T>> {
  return updateStoreQueued(async store => {
    const result = await mutator(store)
    return { store, result }
  })
}

async function broadcastStoreUpdated(store: OpenTeamStore, excludeTabId?: number): Promise<void> {
  const message = { type: 'GROUP_STORE_UPDATED', store }

  for (const tabId of [...hostTabIds]) {
    if (tabId === excludeTabId) continue
    try {
      await chrome.tabs.sendMessage(tabId, message)
    } catch (error) {
      hostTabIds.delete(tabId)
      log.debug('group-store-updated:tab-failed', { tabId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  try {
    await chrome.runtime.sendMessage({ type: GROUP_PUSH_TYPE, payload: message })
  } catch (error) {
    log.debug('group-store-updated:runtime-failed', { error: error instanceof Error ? error.message : String(error) })
  }

  try {
    await chrome.runtime.sendMessage({ type: LEGACY_PUSH_TYPE, payload: { type: 'TEAM_STATE_UPDATED', state: toLegacyState(store) } })
  } catch (error) {
    log.debug('legacy-store-updated:runtime-failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

async function sendError(message: string): Promise<void> {
  const payload = { type: 'GROUP_DELIVERY_ERROR', message }
  for (const tabId of [...hostTabIds]) {
    try {
      await chrome.tabs.sendMessage(tabId, payload)
    } catch {
      hostTabIds.delete(tabId)
    }
  }

  try {
    await chrome.runtime.sendMessage({ type: GROUP_PUSH_TYPE, payload })
  } catch {
    // no active receiver
  }
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

function getChatRoles(store: OpenTeamStore, chat: GroupChat): GroupRole[] {
  return chat.roleIds.map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role))
}

function getChatMessages(store: OpenTeamStore, chat: GroupChat): GroupMessage[] {
  return chat.messageIds.map(messageId => store.messagesById[messageId]).filter((message): message is GroupMessage => Boolean(message))
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

function isMeaningfulConversationId(value: string | undefined): value is string {
  return Boolean(value && value !== '__default__')
}

function recoverDeliverableRoleStatus(role: GroupRole, timestamp: number): void {
  if (role.status === 'ready') return

  log.warn('role:auto-recover-status', { roleId: role.id, roleName: role.name, previousStatus: role.status, lastPromptMessageId: role.lastPromptMessageId })
  role.status = 'ready'
  delete role.lastPromptMessageId
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

function requireChat(store: OpenTeamStore, chatId: unknown): GroupChat {
  if (typeof chatId !== 'string') throw new Error('缺少群聊 ID')
  const chat = store.chatsById[chatId]
  if (!chat) throw new Error(`找不到群聊：${chatId}`)
  return chat
}

function requireRole(store: OpenTeamStore, chatId: string, roleId: unknown): GroupRole {
  if (typeof roleId !== 'string') throw new Error('缺少人员 ID')
  const role = store.rolesById[roleId]
  if (!role || role.chatId !== chatId) throw new Error(`找不到人员：${roleId}`)
  return role
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
  const { store, result } = await mutateStore(store => updateGroupRole(store, requireString(message.roleId, '缺少人员 ID'), {
    name: readOptionalString(patch.name),
    description: readOptionalString(patch.description),
    systemPrompt: readOptionalString(patch.systemPrompt),
    avatarColor: readOptionalString(patch.avatarColor),
  }, now()))
  await broadcastStoreUpdated(store)
  return { ok: true, role: result, store }
}

async function handleRoleRecover(message: RuntimeMessage) {
  log.info('role-recover:start', { chatId: message.chatId, roleId: message.roleId, hostTabId: message.hostTabId })
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, message.chatId)
    const role = requireRole(store, chat.id, message.roleId)
    role.status = 'loading'
    role.updatedAt = now()
    chat.status = 'initializing'
    chat.updatedAt = role.updatedAt
    return { role, iframeSrc: normalizeGeminiConversationUrl(role.geminiConversationUrl) ?? DEFAULT_GEMINI_URL }
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
    role.status = 'thinking'
    role.lastPromptMessageId = messageId
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
      role.updatedAt = timestamp

      return {
        roleId,
        tabId: binding.tabId,
        frameId: binding.frameId,
        message: { type: 'TEAM_SEND_PROMPT', chatId: chat.id, roleId, messageId: userMessage.id, content, includesPersona },
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

async function markDeliveryError(chatId: string, roleId: string, messageId: string, reason: string): Promise<void> {
  log.warn('delivery:error', { chatId, roleId, messageId, reason })
  const { store } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const role = requireRole(store, chat.id, roleId)
    role.status = 'error'
    role.updatedAt = now()
    if (role.lastPromptMessageId === messageId) delete role.lastPromptMessageId

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
    return role
  })

  log.info('frame-ready:store-updated', { chatId, roleId, roleName: result.name, status: result.status, binding: runtimeFrames.getByRole(chatId, roleId) })
  await broadcastStoreUpdated(store)
  return { ok: true, role: result, store }
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
  const promptMessageId = readOptionalString(message.messageId)
  const timestamp = now()
  log.info('role-reply:received', { ...identity, promptMessageId, contentLength: content.length, senderUrl: sender.url })

  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, identity.chatId)
    const role = requireRole(store, chat.id, identity.roleId)
    updateConversation(role, readOptionalString(message.conversationUrl), readOptionalString(message.conversationId))

    const reply: GroupMessage = {
      id: newId('msg'),
      chatId: chat.id,
      seq: chat.nextMessageSeq,
      type: 'assistant',
      content,
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
    chat.status = getChatStatusFromRoles(store, chat)
    chat.updatedAt = timestamp
    return reply
  })

  log.info('role-reply:stored', { chatId: result.chatId, roleId: result.roleId, replyMessageId: result.id })
  await broadcastStoreUpdated(store)
  return { ok: true, message: result, store }
}

async function handleRoleError(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  const identity = readIdentity(message, sender)
  const reason = readOptionalString(message.reason) ?? readOptionalString(message.error) ?? '人员执行失败'
  const promptMessageId = readOptionalString(message.messageId)
  log.warn('role-error:received', { ...identity, promptMessageId, reason, senderUrl: sender.url, tabId: messageTabId(message, sender), frameId: senderFrameId(sender) })

  const { store } = await mutateStore(store => {
    const chat = requireChat(store, identity.chatId)
    const role = requireRole(store, chat.id, identity.roleId)
    role.status = 'error'
    role.updatedAt = now()
    if (!promptMessageId || role.lastPromptMessageId === promptMessageId) delete role.lastPromptMessageId

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
  const safeUrl = normalizeGeminiConversationUrl(conversationUrl)
  const conversationIdFromUrl = extractGeminiConversationId(safeUrl)
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

  return { roomId: chat?.id ?? 'group-empty', hostTabId: [...hostTabIds][0] ?? -1, roles, messages }
}

function legacyStatus(status: GroupRole['status']): string {
  if (status === 'pending' || status === 'loading') return 'opening'
  if (status === 'ready') return 'idle'
  if (status === 'thinking') return 'generating'
  return 'error'
}

function readGroupRoleBatchItem(value: unknown): Parameters<typeof createGroupRolesBatch>[2][number] {
  if (!isRecord(value)) throw new Error('添加人员项无效')

  if (value.source === 'library') {
    return {
      source: 'library',
      roleTemplateId: requireString(value.roleTemplateId ?? value.templateId, '缺少人员库 ID'),
      avatarColor: readOptionalString(value.avatarColor),
    }
  }

  if (value.source === 'temporary') {
    return {
      source: 'temporary',
      name: requireString(value.name, '人员名称不能为空'),
      description: readOptionalString(value.description),
      systemPrompt: requireString(value.systemPrompt, '人设不能为空'),
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

chrome.runtime.onInstalled.addListener(() => {
  log.info('extension-installed')
})

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message?.type === 'OPENTEAM_PING') {
    sendResponse({ ok: true, tabId: sender.tab?.id ?? null })
    return true
  }

  const run = async () => {
    switch (message?.type) {
      case 'GROUP_STORE_GET':
        return handleStoreGet(message, sender)
      case 'GROUP_CHAT_CREATE':
        return handleChatCreate(message)
      case 'GROUP_CHAT_DUPLICATE':
        return handleChatDuplicate(message)
      case 'GROUP_CHAT_SWITCH':
        return handleChatSwitch(message, sender)
      case 'GROUP_CHAT_UPDATE':
        return handleChatUpdate(message)
      case 'GROUP_CHAT_DELETE':
        return handleChatDelete(message)
      case 'GROUP_CHAT_MARK_READ':
        return handleChatMarkRead(message)
      case 'ROLE_TEMPLATE_CREATE':
        return handleRoleTemplateCreate(message)
      case 'ROLE_TEMPLATE_UPDATE':
        return handleRoleTemplateUpdate(message)
      case 'ROLE_TEMPLATE_DELETE':
        return handleRoleTemplateDelete(message)
      case 'GROUP_ROLE_CREATE':
        return handleRoleCreate(message)
      case 'GROUP_ROLES_CREATE_BATCH':
        return handleRolesCreateBatch(message)
      case 'GROUP_ROLE_UPDATE':
        return handleRoleUpdate(message)
      case 'GROUP_ROLE_DELETE':
        return mutateStore(store => deleteGroupRole(store, requireString(message.roleId, '缺少人员 ID'), now())).then(async result => {
          await broadcastStoreUpdated(result.store)
          return { ok: true, store: result.store }
        })
      case 'GROUP_ROLE_RECOVER':
        return handleRoleRecover(message)
      case 'GROUP_ROLE_REINITIALIZE':
        return handleRoleReinitialize(message)
      case 'GROUP_MESSAGE_SEND':
        return handleMessageSend(message)
      case 'TEAM_FRAME_ROLE_READY':
        return readOptionalString(message.chatId) ? handleFrameRoleReady(message, sender) : { ok: false, error: 'TEAM_FRAME_ROLE_READY 缺少 chatId' }
      case 'TEAM_ROLE_CONVERSATION_UPDATED':
        return handleConversationUpdated(message, sender)
      case 'TEAM_SEND_ACK':
        return handleSendAck(message, sender)
      case 'TEAM_ROLE_STATUS':
        return handleRoleStatus(message, sender)
      case 'TEAM_ROLE_REPLY':
        return handleRoleReply(message, sender)
      case 'TEAM_ROLE_ERROR':
        return handleRoleError(message, sender)
      case 'TEAM_HOST_READY':
      case 'TEAM_GET_STATE':
        return handleLegacyHostReady(message, sender)
      case 'TEAM_CREATE_ROLE':
        return handleLegacyCreateRole(message)
      case 'TEAM_SEND_MESSAGE': {
        const store = await loadStore()
        if (!store.currentChatId) return { ok: false, error: '请先创建群聊' }
        return handleMessageSend({ type: 'GROUP_MESSAGE_SEND', chatId: store.currentChatId, raw: message.raw })
      }
      default:
        return { ok: false, error: 'Unknown OpenTeam message' }
    }
  }

  run()
    .then(sendResponse)
    .catch(error => {
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
  hostTabIds.delete(tabId)
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
