import type { JSONContent } from '@tiptap/core'
import type { MessageHighlightColor } from './highlightColors'

export type RoomMode = 'independent' | 'collaborative'
export type ChatSite = 'gemini' | 'chatgpt' | 'claude' | 'deepseek' | 'kimi' | 'qwen'

export type ChatStatus = 'draft' | 'initializing' | 'ready' | 'running' | 'error'

export type RoleStatus = 'pending' | 'loading' | 'ready' | 'thinking' | 'stopped' | 'error'

export type DeliveryStatus = 'pending' | 'sent' | 'received' | 'error'

export type RoleTemplateType = 'builtin' | 'custom'

export interface OpenTeamStore {
  version: number
  currentChatId?: string
  chatOrder: string[]
  chatsById: Record<string, GroupChat>
  rolesById: Record<string, GroupRole>
  messagesById: Record<string, GroupMessage>
  roleTemplateOrder: string[]
  roleTemplatesById: Record<string, RoleTemplate>
  globalNote?: RichNoteDocument
  chatNotesById?: Record<string, RichNoteDocument>
  messageHighlightsById?: Record<string, MessageHighlight[]>
  settings: OpenTeamSettings
  viewState?: OpenTeamViewState
}

export interface OpenTeamViewState {
  chatReadSeqById?: Record<string, number>
  chatHasNewMessageById?: Record<string, boolean>
}

export interface OpenTeamSettings {
  defaultMode: RoomMode
  maxContextChars: number
  defaultChatSite: ChatSite
}

export interface GroupChat {
  id: string
  name: string
  description?: string
  mode: RoomMode
  roleIds: string[]
  messageIds: string[]
  nextMessageSeq: number
  status: ChatStatus
  createdAt: number
  updatedAt: number
}

export interface RoleTemplate {
  id: string
  type: RoleTemplateType
  name: string
  description?: string
  defaultChatSite?: ChatSite
  chatGptGptsUrl?: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}

export interface GroupRole {
  id: string
  chatId: string
  templateId?: string
  chatSite?: ChatSite
  name: string
  description?: string
  systemPrompt?: string
  avatarColor?: string
  status: RoleStatus
  contextCursor: number
  geminiConversationId?: string
  geminiConversationUrl?: string
  chatGptGptsUrl?: string
  lastPromptMessageId?: string
  replyAttemptId?: string
  lastReplyAt?: number
  createdAt: number
  updatedAt: number
}

export interface GroupMessage {
  id: string
  chatId: string
  seq: number
  type: 'user' | 'assistant' | 'system'
  content: string
  contentFormat?: 'markdown'
  roleId?: string
  roleName?: string
  targetRoleIds?: string[]
  mentionedRoleIds?: string[]
  references?: MessageReference[]
  createdAt: number
  status: DeliveryStatus
  deliveryStatus?: Record<string, DeliveryStatus>
}

export interface MessageReference {
  messageId: string
  roleId?: string
  roleName?: string
  contentSnapshot: string
}

export type RichNoteDocument = JSONContent

export interface MessageHighlight {
  id: string
  messageId: string
  text: string
  startOffset: number
  endOffset: number
  color?: MessageHighlightColor
  createdAt: number
}

export interface RuntimeFrameBinding {
  chatId: string
  roleId: string
  tabId: number
  frameId: number
  ready: boolean
  lastSeenAt: number
}

export type RuntimeFrameBindingKey = `${string}:${string}`

export type RuntimeFrameAddressKey = `${number}:${number}`
