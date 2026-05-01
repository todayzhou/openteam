export type TeamRoleStatus =
  | 'opening'
  | 'online'
  | 'sending'
  | 'generating'
  | 'idle'
  | 'offline'
  | 'error'

export interface TeamRole {
  id: string
  name: string
  tabId: number
  frameId?: number
  conversationId: string
  status: TeamRoleStatus
  createdAt: number
  lastMessageAt?: number
  lastError?: string
}

export interface TeamMessage {
  id: string
  roomId: string
  roleId?: string
  roleName?: string
  from: 'user' | 'role' | 'system'
  target: 'role' | 'all' | 'none'
  targetRoleName?: string
  content: string
  createdAt: number
  status?: 'pending' | 'sent' | 'received' | 'error'
}

export interface TeamRoomState {
  roomId: string
  hostTabId: number
  roles: TeamRole[]
  messages: TeamMessage[]
}

export interface TeamDelivery {
  roleId: string
  tabId: number
  frameId?: number
  content: string
}

export interface TeamSendResult {
  ok: true
  messageId: string
  deliveries: TeamDelivery[]
}

export interface TeamErrorResult {
  ok: false
  message: TeamMessage
  error: string
}

export type TeamSendMessageResult = TeamSendResult | TeamErrorResult

export type ParsedTeamMention =
  | {
      ok: true
      target: 'role'
      content: string
      roleId: string
      targetRoleName: string
    }
  | {
      ok: true
      target: 'all' | 'none'
      content: string
    }
  | {
      ok: false
      error: string
    }

export type HostToBackgroundMessage =
  | { type: 'TEAM_CONTENT_READY'; conversationId: string }
  | { type: 'TEAM_HOST_READY'; hostTabId?: number }
  | { type: 'TEAM_GET_STATE' }
  | { type: 'TEAM_CREATE_ROLE'; name: string; container?: 'tab' | 'iframe'; hostTabId?: number }
  | { type: 'TEAM_REMOVE_ROLE'; roleId: string }
  | { type: 'TEAM_SEND_MESSAGE'; raw: string }

export type BackgroundToHostMessage =
  | { type: 'TEAM_STATE_UPDATED'; state: TeamRoomState }
  | { type: 'TEAM_ROLE_REPLY'; message: TeamMessage }
  | { type: 'TEAM_ERROR'; message: string }

export type BackgroundToRoleMessage =
  | { type: 'TEAM_ASSIGN_ROLE'; chatId?: string; roleId: string; roleName: string; roomId: string }
  | { type: 'TEAM_SEND_PROMPT'; chatId?: string; roleId?: string; messageId: string; content: string; autoSend?: boolean }

export type RoleToBackgroundMessage =
  | { type: 'TEAM_ROLE_READY'; conversationId: string }
  | { type: 'TEAM_FRAME_ROLE_READY'; chatId?: string; roleId: string; hostTabId?: number; conversationId: string; conversationUrl?: string }
  | { type: 'TEAM_ROLE_CONVERSATION_UPDATED'; chatId: string; roleId: string; conversationId?: string; conversationUrl?: string }
  | { type: 'TEAM_SEND_ACK'; chatId: string; roleId: string; messageId: string }
  | { type: 'TEAM_ROLE_ERROR'; chatId: string; roleId: string; messageId?: string; reason: string }
  | { type: 'TEAM_ROLE_STATUS'; status: TeamRoleStatus; error?: string }
  | { type: 'TEAM_ROLE_REPLY'; chatId?: string; roleId?: string; messageId?: string; content: string; conversationId?: string; conversationUrl?: string }
