import type { ChatSite, MessageReference, OpenTeamStore, RoleTemplate } from '../group/types'
import { createDefaultStore } from '../group/store'

export type CachedMessageNode = { signature: string; node: HTMLElement; streamingSignature?: string }
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
  roleActionMenuRoleId?: string
  addPersonSiteMenuId?: string
  notesPanelOpen: boolean
  activeNoteScope: 'global' | 'chat'
  peopleLibraryPage: number
  peopleLibraryTemplateType: 'builtin' | 'custom'
  peopleLibrarySearchQuery: string
  previewTemplateId?: string
  addPersonTemplateType: 'builtin' | 'custom'
  addPersonSearchQuery: string
  pendingSwitchAnimationFrame?: number
  thinkingTimeoutTimers: number[]
  loggedThinkingTimeoutRoleIds: Set<string>
  messageNodeCache: Map<string, CachedMessageNode>
  preserveNextMessageScroll: boolean
  reconnectingRoleKeys: Set<string>
  roleReadyWaiters: Set<RoleReadyWaiter>
  temporaryPersonDrafts: TemporaryPersonDraft[]
  addPersonSiteByKey: Map<string, Set<string>>
  addPersonSelectedKeys: Set<string>
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
    addPersonSiteByKey: new Map<string, Set<string>>(),
    addPersonSelectedKeys: new Set<string>(),
    peopleLibraryPage: 0,
    peopleLibraryTemplateType: 'custom',
    peopleLibrarySearchQuery: '',
    addPersonTemplateType: 'custom',
    addPersonSearchQuery: '',
    notesPanelOpen: false,
    activeNoteScope: 'chat',
  }
}
