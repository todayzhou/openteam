export type RoomMode = 'independent' | 'collaborative'

export type ChatStatus = 'draft' | 'initializing' | 'ready' | 'running' | 'error'

export type RoleStatus = 'pending' | 'loading' | 'ready' | 'thinking' | 'error'

export type DeliveryStatus = 'pending' | 'sent' | 'received' | 'error'

export interface OpenTeamStore {
  version: number
  currentChatId?: string
  chatOrder: string[]
  chatsById: Record<string, GroupChat>
  rolesById: Record<string, GroupRole>
  messagesById: Record<string, GroupMessage>
  roleTemplateOrder: string[]
  roleTemplatesById: Record<string, RoleTemplate>
  settings: OpenTeamSettings
}

export interface OpenTeamSettings {
  defaultMode: RoomMode
  maxContextChars: number
}

export interface GroupChat {
  id: string
  name: string
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
  name: string
  description?: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}

export interface GroupRole {
  id: string
  chatId: string
  templateId?: string
  name: string
  description?: string
  systemPrompt?: string
  status: RoleStatus
  contextCursor: number
  geminiConversationId?: string
  geminiConversationUrl?: string
  lastPromptMessageId?: string
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
  roleId?: string
  roleName?: string
  targetRoleIds?: string[]
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
