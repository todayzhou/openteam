import type { GroupChat, GroupMessage, GroupRole, OpenTeamSettings, OpenTeamStore, OpenTeamViewState, RoleTemplate } from './types'

export const STORE_KEY = 'openteam.groupStore'
export const META_STORE_KEY = 'openteam.meta.v2'
export const CHAT_KEY_PREFIX = 'openteam.chat.'
export const MESSAGE_CHUNK_KEY_PREFIX = 'openteam.messages.'
export const CURRENT_STORE_VERSION = 2
export const MESSAGE_CHUNK_SIZE = 100

interface OpenTeamMetaStore {
  version: number
  currentChatId?: string
  chatOrder: string[]
  roleTemplateOrder: string[]
  roleTemplatesById: Record<string, RoleTemplate>
  settings: OpenTeamSettings
  viewState?: OpenTeamViewState
}

interface ChatDocument {
  version: number
  chat: GroupChat
  rolesById: Record<string, GroupRole>
  messageChunkIds: string[]
  messageCount: number
}

interface MessageChunk {
  version: number
  chatId: string
  chunkId: string
  fromSeq: number
  toSeq: number
  messages: GroupMessage[]
}

const DEFAULT_SETTINGS: OpenTeamSettings = {
  defaultMode: 'independent',
  maxContextChars: 6000,
  defaultChatSite: 'gemini',
}

let storeQueue: Promise<void> = Promise.resolve()

export function createDefaultStore(): OpenTeamStore {
  return {
    version: CURRENT_STORE_VERSION,
    chatOrder: [],
    chatsById: {},
    rolesById: {},
    messagesById: {},
    roleTemplateOrder: [],
    roleTemplatesById: {},
    settings: { ...DEFAULT_SETTINGS },
    viewState: {
      chatReadSeqById: {},
      chatHasNewMessageById: {},
    },
  }
}

export async function loadStore(): Promise<OpenTeamStore> {
  const metaResult = await chrome.storage.local.get(META_STORE_KEY)
  if (metaResult[META_STORE_KEY]) {
    return loadV2Store(metaResult[META_STORE_KEY])
  }

  const legacyResult = await chrome.storage.local.get(STORE_KEY)
  const legacyStore = normalizeStore(legacyResult[STORE_KEY])
  if (legacyResult[STORE_KEY]) {
    await saveStore(legacyStore)
  }
  return legacyStore
}

export async function saveStore(store: OpenTeamStore): Promise<void> {
  const normalized = normalizeStore(store)
  const items = buildStorageItems(normalized)
  await chrome.storage.local.set(items)
  await removeStaleStorageKeys(Object.keys(items))
}

export async function updateStore<T>(mutator: (draft: OpenTeamStore) => T | Promise<T>): Promise<T> {
  const store = await loadStore()
  const result = await mutator(store)
  await saveStore(store)
  return result
}

export function updateStoreQueued<T>(mutator: (draft: OpenTeamStore) => T | Promise<T>): Promise<T> {
  const run = async () => updateStore(mutator)
  const next = storeQueue.then(run, run)
  storeQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function normalizeStore(raw: unknown): OpenTeamStore {
  if (!isRecord(raw)) {
    return createDefaultStore()
  }

  const defaults = createDefaultStore()
  const version = typeof raw.version === 'number' ? raw.version : defaults.version
  const normalized: OpenTeamStore = {
    version: Math.max(version, CURRENT_STORE_VERSION),
    chatOrder: readStringArray(raw.chatOrder, defaults.chatOrder),
    chatsById: readRecord(raw.chatsById),
    rolesById: readRecord(raw.rolesById),
    messagesById: readRecord(raw.messagesById),
    roleTemplateOrder: readStringArray(raw.roleTemplateOrder, defaults.roleTemplateOrder),
    roleTemplatesById: readRecord(raw.roleTemplatesById),
    settings: normalizeSettings(raw.settings),
    viewState: normalizeViewState(raw.viewState),
  }

  if (typeof raw.currentChatId === 'string') {
    normalized.currentChatId = raw.currentChatId
  }

  return normalized
}

async function loadV2Store(rawMeta: unknown): Promise<OpenTeamStore> {
  const meta = normalizeMetaStore(rawMeta)
  const chatKeys = meta.chatOrder.map(chatStorageKey)
  const chatResult = await chrome.storage.local.get(chatKeys)
  const chatDocuments = chatKeys
    .map(key => normalizeChatDocument(chatResult[key]))
    .filter((document): document is ChatDocument => Boolean(document))

  const chunkKeys = chatDocuments.flatMap(document => document.messageChunkIds.map(chunkId => messageChunkStorageKey(document.chat.id, chunkId)))
  const chunkResult = chunkKeys.length > 0 ? await chrome.storage.local.get(chunkKeys) : {}

  const store = createDefaultStore()
  store.currentChatId = meta.currentChatId
  store.chatOrder = chatDocuments.map(document => document.chat.id)
  store.roleTemplateOrder = [...meta.roleTemplateOrder]
  store.roleTemplatesById = { ...meta.roleTemplatesById }
  store.settings = normalizeSettings(meta.settings)
  store.viewState = normalizeViewState(meta.viewState)

  for (const document of chatDocuments) {
    store.chatsById[document.chat.id] = { ...document.chat, messageIds: [] }
    store.rolesById = { ...store.rolesById, ...document.rolesById }

    for (const chunkId of document.messageChunkIds) {
      const chunk = normalizeMessageChunk(chunkResult[messageChunkStorageKey(document.chat.id, chunkId)])
      if (!chunk || chunk.chatId !== document.chat.id) continue

      for (const message of chunk.messages) {
        store.messagesById[message.id] = message
        store.chatsById[document.chat.id].messageIds.push(message.id)
      }
    }
  }

  if (store.currentChatId && !store.chatsById[store.currentChatId]) {
    store.currentChatId = store.chatOrder[0]
  }

  return normalizeStore(store)
}

function buildStorageItems(store: OpenTeamStore): Record<string, unknown> {
  const chatIds = uniqueStrings([...store.chatOrder, ...Object.keys(store.chatsById)])
  const meta: OpenTeamMetaStore = {
    version: CURRENT_STORE_VERSION,
    currentChatId: store.currentChatId,
    chatOrder: chatIds,
    roleTemplateOrder: [...store.roleTemplateOrder],
    roleTemplatesById: { ...store.roleTemplatesById },
    settings: normalizeSettings(store.settings),
    viewState: normalizeViewState(store.viewState),
  }
  const items: Record<string, unknown> = { [META_STORE_KEY]: meta }

  for (const chatId of chatIds) {
    const chat = store.chatsById[chatId]
    if (!chat) continue

    const rolesById = collectChatRoles(store, chat)
    const messages = collectChatMessages(store, chat)
    const messageChunkIds: string[] = []

    messages.forEach((_, index) => {
      if (index % MESSAGE_CHUNK_SIZE !== 0) return

      const chunkMessages = messages.slice(index, index + MESSAGE_CHUNK_SIZE)
      const chunkId = chunkIdForIndex(index / MESSAGE_CHUNK_SIZE)
      messageChunkIds.push(chunkId)
      const chunk: MessageChunk = {
        version: CURRENT_STORE_VERSION,
        chatId,
        chunkId,
        fromSeq: chunkMessages[0]?.seq ?? 0,
        toSeq: chunkMessages[chunkMessages.length - 1]?.seq ?? 0,
        messages: chunkMessages,
      }
      items[messageChunkStorageKey(chatId, chunkId)] = chunk
    })

    const chatDocument: ChatDocument = {
      version: CURRENT_STORE_VERSION,
      chat: { ...chat, messageIds: messages.map(message => message.id) },
      rolesById,
      messageChunkIds,
      messageCount: messages.length,
    }
    items[chatStorageKey(chatId)] = chatDocument
  }

  return items
}

async function removeStaleStorageKeys(activeKeys: string[]): Promise<void> {
  const allItems = await chrome.storage.local.get(null)
  const activeKeySet = new Set(activeKeys)
  const staleKeys = Object.keys(allItems).filter(key => (
    key === STORE_KEY
    || key.startsWith(CHAT_KEY_PREFIX)
    || key.startsWith(MESSAGE_CHUNK_KEY_PREFIX)
  ) && !activeKeySet.has(key))

  if (staleKeys.length > 0) {
    await chrome.storage.local.remove(staleKeys)
  }
}

function normalizeMetaStore(raw: unknown): OpenTeamMetaStore {
  const defaults = createDefaultStore()
  if (!isRecord(raw)) {
    return {
      version: CURRENT_STORE_VERSION,
      chatOrder: [],
      roleTemplateOrder: [],
      roleTemplatesById: {},
      settings: defaults.settings,
      viewState: defaults.viewState,
    }
  }

  const meta: OpenTeamMetaStore = {
    version: typeof raw.version === 'number' ? raw.version : CURRENT_STORE_VERSION,
    chatOrder: readStringArray(raw.chatOrder, []),
    roleTemplateOrder: readStringArray(raw.roleTemplateOrder, []),
    roleTemplatesById: readRecord(raw.roleTemplatesById),
    settings: normalizeSettings(raw.settings),
    viewState: normalizeViewState(raw.viewState),
  }

  if (typeof raw.currentChatId === 'string') {
    meta.currentChatId = raw.currentChatId
  }

  return meta
}

function normalizeChatDocument(raw: unknown): ChatDocument | undefined {
  if (!isRecord(raw) || !isRecord(raw.chat) || typeof raw.chat.id !== 'string') {
    return undefined
  }

  return {
    version: typeof raw.version === 'number' ? raw.version : CURRENT_STORE_VERSION,
    chat: raw.chat as unknown as GroupChat,
    rolesById: readRecord(raw.rolesById),
    messageChunkIds: readStringArray(raw.messageChunkIds, []),
    messageCount: typeof raw.messageCount === 'number' ? raw.messageCount : 0,
  }
}

function normalizeMessageChunk(raw: unknown): MessageChunk | undefined {
  if (!isRecord(raw) || typeof raw.chatId !== 'string' || typeof raw.chunkId !== 'string' || !Array.isArray(raw.messages)) {
    return undefined
  }

  return {
    version: typeof raw.version === 'number' ? raw.version : CURRENT_STORE_VERSION,
    chatId: raw.chatId,
    chunkId: raw.chunkId,
    fromSeq: typeof raw.fromSeq === 'number' ? raw.fromSeq : 0,
    toSeq: typeof raw.toSeq === 'number' ? raw.toSeq : 0,
    messages: raw.messages.filter((message): message is GroupMessage => isRecord(message) && typeof message.id === 'string'),
  }
}

function collectChatRoles(store: OpenTeamStore, chat: GroupChat): Record<string, GroupRole> {
  const roleIds = new Set(chat.roleIds)
  return Object.fromEntries(Object.entries(store.rolesById).filter(([roleId, role]) => roleIds.has(roleId) || role.chatId === chat.id))
}

function collectChatMessages(store: OpenTeamStore, chat: GroupChat): GroupMessage[] {
  const messageIds = new Set(chat.messageIds)
  const messagesById = new Map<string, GroupMessage>()

  for (const messageId of chat.messageIds) {
    const message = store.messagesById[messageId]
    if (message) messagesById.set(message.id, message)
  }

  for (const message of Object.values(store.messagesById)) {
    if (message.chatId === chat.id && !messageIds.has(message.id)) {
      messagesById.set(message.id, message)
    }
  }

  return [...messagesById.values()].sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt)
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function chunkIdForIndex(index: number): string {
  return String(index + 1).padStart(6, '0')
}

export function chatStorageKey(chatId: string): string {
  return `${CHAT_KEY_PREFIX}${chatId}`
}

export function messageChunkStorageKey(chatId: string, chunkId: string): string {
  return `${MESSAGE_CHUNK_KEY_PREFIX}${chatId}.${chunkId}`
}

function normalizeSettings(raw: unknown): OpenTeamSettings {
  if (!isRecord(raw)) {
    return { ...DEFAULT_SETTINGS }
  }

  return {
    defaultMode: raw.defaultMode === 'collaborative' ? 'collaborative' : DEFAULT_SETTINGS.defaultMode,
    maxContextChars: typeof raw.maxContextChars === 'number' ? raw.maxContextChars : DEFAULT_SETTINGS.maxContextChars,
    defaultChatSite:
      raw.defaultChatSite === 'chatgpt'
        ? 'chatgpt'
        : raw.defaultChatSite === 'claude'
          ? 'claude'
          : raw.defaultChatSite === 'deepseek'
            ? 'deepseek'
            : DEFAULT_SETTINGS.defaultChatSite,
  }
}

function normalizeViewState(raw: unknown): NonNullable<OpenTeamStore['viewState']> {
  if (!isRecord(raw)) {
    return { chatReadSeqById: {}, chatHasNewMessageById: {} }
  }

  return {
    chatReadSeqById: readNumberRecord(raw.chatReadSeqById),
    chatHasNewMessageById: readBooleanRecord(raw.chatHasNewMessageById),
  }
}

function readStringArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) {
    return [...fallback]
  }

  return raw.filter((item): item is string => typeof item === 'string')
}

function readRecord<T>(raw: unknown): Record<string, T> {
  if (!isRecord(raw)) {
    return {}
  }

  return raw as Record<string, T>
}

function readNumberRecord(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
}

function readBooleanRecord(raw: unknown): Record<string, boolean> {
  if (!isRecord(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
