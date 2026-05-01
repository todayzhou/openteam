import type { OpenTeamSettings, OpenTeamStore } from './types'

export const STORE_KEY = 'openteam.groupStore'
export const CURRENT_STORE_VERSION = 1

const DEFAULT_SETTINGS: OpenTeamSettings = {
  defaultMode: 'independent',
  maxContextChars: 6000,
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
  }
}

export async function loadStore(): Promise<OpenTeamStore> {
  const result = await chrome.storage.local.get(STORE_KEY)
  return normalizeStore(result[STORE_KEY])
}

export async function saveStore(store: OpenTeamStore): Promise<void> {
  await chrome.storage.local.set({ [STORE_KEY]: normalizeStore(store) })
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
  }

  if (typeof raw.currentChatId === 'string') {
    normalized.currentChatId = raw.currentChatId
  }

  return normalized
}

function normalizeSettings(raw: unknown): OpenTeamSettings {
  if (!isRecord(raw)) {
    return { ...DEFAULT_SETTINGS }
  }

  return {
    defaultMode: raw.defaultMode === 'collaborative' ? 'collaborative' : DEFAULT_SETTINGS.defaultMode,
    maxContextChars: typeof raw.maxContextChars === 'number' ? raw.maxContextChars : DEFAULT_SETTINGS.maxContextChars,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
