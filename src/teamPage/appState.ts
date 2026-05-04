import type { ChatSite, MessageReference, OpenTeamStore, RoleTemplate } from '../group/types'
import { createDefaultStore } from '../group/store'

export type CachedMessageNode = { signature: string; node: HTMLElement }
export type TemporaryPersonDraft = Pick<RoleTemplate, 'name' | 'description' | 'systemPrompt'> & { id: string; chatSite: ChatSite }

export interface RoleReadyWaiter {
  chatId: string
  roleIds: Set<string>
  resolve: () => void
  reject: (error: Error) => void
  timeoutId: number
  pollTimeoutId?: number
}

export interface TeamPageState {
  store: OpenTeamStore
  selectedChatId?: string
  selectedRoleId?: string
  selectedTemplateId?: string
  selectedReference?: MessageReference
  hostTabId?: number
  mentionIndex: number
  peopleDrawerOpen: boolean
  chatMenuChatId?: string
  roleSiteMenuRoleId?: string
  addPersonSiteMenuId?: string
  notesPanelOpen: boolean
  activeNoteScope: 'global' | 'chat'
  peopleLibraryPage: number
  pendingSwitchAnimationFrame?: number
  thinkingTimeoutTimers: number[]
  loggedThinkingTimeoutRoleIds: Set<string>
  messageNodeCache: Map<string, CachedMessageNode>
  preserveNextMessageScroll: boolean
  reconnectingRoleKeys: Set<string>
  roleReadyWaiters: Set<RoleReadyWaiter>
  temporaryPersonDrafts: TemporaryPersonDraft[]
  addPersonSiteByKey: Map<string, Set<ChatSite>>
}

export function createTeamPageState(): TeamPageState {
  return {
    store: createDefaultStore(),
    mentionIndex: 0,
    peopleDrawerOpen: false,
    thinkingTimeoutTimers: [],
    loggedThinkingTimeoutRoleIds: new Set<string>(),
    messageNodeCache: new Map<string, CachedMessageNode>(),
    preserveNextMessageScroll: false,
    reconnectingRoleKeys: new Set<string>(),
    roleReadyWaiters: new Set<RoleReadyWaiter>(),
    temporaryPersonDrafts: [],
    addPersonSiteByKey: new Map<string, Set<ChatSite>>(),
    peopleLibraryPage: 0,
    notesPanelOpen: false,
    activeNoteScope: 'chat',
  }
}
