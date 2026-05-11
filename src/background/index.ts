import { loadStore } from '../group/store'
import type { GroupChat, OpenTeamStore } from '../group/types'
import { createChatHandlers } from './chatHandlers'
import { createMessageHandlers } from './messageHandlers'
import {
  broadcastStoreUpdated as broadcastRuntimeStoreUpdated,
  forgetHostTab,
  rememberHost,
  requestRoleRecovery,
  sendError,
  type RuntimeMessage,
} from './runtimeClient'
import { createMessageRouter } from './messageRouter'
import { createExternalModelHandlers } from './externalModelHandlers'
import { createExternalModelClient } from './externalModelClient'
import { createPromptSender } from './promptDelivery'
import { createRoleHandlers } from './roleHandlers'
import { createOrchestrationHandlers, type OrchestrationAutoStreamMessage } from './orchestrationHandlers'
import { createRuntimeFrameRegistry } from './runtimeFrames'
import { createSitePromptDeliveryLimiter } from './sitePromptDeliveryLimiter'
import { getChatRoles, mutateStore } from './storeAccess'
import { createLogger } from '../shared/logger'
import type { BackgroundToRoleMessage } from '../group/runtimeProtocol'

const runtimeFrames = createRuntimeFrameRegistry()
const log = createLogger('background')

const sendPrompt = createPromptSender({ log })
const promptDeliveryLimiter = createSitePromptDeliveryLimiter({ log })
const externalModelClient = createExternalModelClient()

function sendRoleMessage(tabId: number, frameId: number, message: BackgroundToRoleMessage): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message, { frameId })
}

function now(): number {
  return Date.now()
}

function newId(prefix: string): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  return `${prefix}-${cryptoApi?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

async function broadcastStoreUpdated(store: OpenTeamStore, excludeTabId?: number): Promise<void> {
  await broadcastRuntimeStoreUpdated(store, { excludeTabId })
}

async function broadcastAutoGenerateStream(message: OrchestrationAutoStreamMessage): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message)
  } catch (error) {
    log.debug('auto-orchestration-stream:runtime-failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

function getChatStatusFromRoles(store: OpenTeamStore, chat: GroupChat): GroupChat['status'] {
  const roles = getChatRoles(store, chat)
  if (roles.length === 0) return 'draft'
  if (roles.some(role => role.status === 'thinking' || role.status === 'loading')) return 'running'
  if (roles.some(role => role.status === 'error')) return 'error'
  return 'ready'
}

async function handleStoreGet(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  rememberHost(sender, message.hostTabId)
  const store = await loadStore()
  return { ok: true, store, bindings: runtimeFrames.list() }
}

async function handleSettingsUpdate(message: RuntimeMessage) {
  const { store } = await mutateStore(store => {
    const defaultChatSite = readOptionalString(message.defaultChatSite)
    if (defaultChatSite === 'chatgpt' || defaultChatSite === 'gemini' || defaultChatSite === 'claude' || defaultChatSite === 'deepseek') {
      store.settings.defaultChatSite = defaultChatSite
    }
  })
  await broadcastStoreUpdated(store)
  return { ok: true, store }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

const routeMessage = createMessageRouter([
  { type: 'GROUP_STORE_GET', handler: handleStoreGet },
  ...createChatHandlers({ broadcastStoreUpdated, getChatStatusFromRoles, log, newId, now, runtimeFrames }),
  { type: 'GROUP_SETTINGS_UPDATE', handler: handleSettingsUpdate },
  ...createExternalModelHandlers({ broadcastStoreUpdated, externalModelClient, newId, now }),
  ...createRoleHandlers({ broadcastStoreUpdated, externalModelClient, log, newId, now, runtimeFrames, sendPrompt }),
  ...createOrchestrationHandlers({ broadcastStoreUpdated, broadcastAutoGenerateStream, externalModelClient, getChatStatusFromRoles, log, newId, now, promptDeliveryLimiter, requestRoleRecovery, runtimeFrames, sendPrompt }),
  ...createMessageHandlers({ broadcastStoreUpdated, externalModelClient, getChatStatusFromRoles, log, newId, now, promptDeliveryLimiter, requestRoleRecovery, runtimeFrames, sendError, sendPrompt, sendRoleMessage }),
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
