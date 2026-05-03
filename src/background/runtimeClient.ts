import type { OpenTeamStore } from '../group/types'

export type RuntimeMessage = { type?: string; [key: string]: unknown }

export interface BroadcastStoreUpdatedOptions {
  excludeTabId?: number
  legacyState?: unknown
}

export const GROUP_PUSH_TYPE = 'OPENTEAM_GROUP_PUSH'
export const LEGACY_PUSH_TYPE = 'OPENTEAM_HOST_PUSH'

const hostTabIds = new Set<number>()

const log = {
  debug(event: string, details?: Record<string, unknown>): void {
    console.debug('[OpenTeam][background]', event, details || {})
  },
}

export function senderTabId(sender: chrome.runtime.MessageSender): number | undefined {
  return sender.tab?.id
}

export function senderFrameId(sender: chrome.runtime.MessageSender): number {
  return sender.frameId ?? 0
}

export function explicitTabId(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

export function messageTabId(message: RuntimeMessage, sender: chrome.runtime.MessageSender): number | undefined {
  return senderTabId(sender) ?? explicitTabId(message.hostTabId)
}

export function rememberHost(sender: chrome.runtime.MessageSender, explicitTabIdValue?: unknown): void {
  const tabId = senderTabId(sender) ?? explicitTabId(explicitTabIdValue)
  if (tabId !== undefined) hostTabIds.add(tabId)
}

export function forgetHostTab(tabId: number): void {
  hostTabIds.delete(tabId)
}

export function listHostTabIds(): number[] {
  return [...hostTabIds]
}

export async function broadcastStoreUpdated(store: OpenTeamStore, options: BroadcastStoreUpdatedOptions = {}): Promise<void> {
  const message = { type: 'GROUP_STORE_UPDATED', store }

  for (const tabId of listHostTabIds()) {
    if (tabId === options.excludeTabId) continue
    try {
      await chrome.tabs.sendMessage(tabId, message)
    } catch (error) {
      forgetHostTab(tabId)
      log.debug('group-store-updated:tab-failed', { tabId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  try {
    await chrome.runtime.sendMessage({ type: GROUP_PUSH_TYPE, payload: message })
  } catch (error) {
    log.debug('group-store-updated:runtime-failed', { error: error instanceof Error ? error.message : String(error) })
  }

  try {
    await chrome.runtime.sendMessage({ type: LEGACY_PUSH_TYPE, payload: { type: 'TEAM_STATE_UPDATED', state: options.legacyState } })
  } catch (error) {
    log.debug('legacy-store-updated:runtime-failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

export async function sendError(message: string): Promise<void> {
  const payload = { type: 'GROUP_DELIVERY_ERROR', message }
  for (const tabId of listHostTabIds()) {
    try {
      await chrome.tabs.sendMessage(tabId, payload)
    } catch {
      forgetHostTab(tabId)
    }
  }

  try {
    await chrome.runtime.sendMessage({ type: GROUP_PUSH_TYPE, payload })
  } catch {
    // no active receiver
  }
}
