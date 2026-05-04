import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupChat, GroupRole, OpenTeamStore, RuntimeFrameBinding } from '../group/types'

function createStoreWithReadyRole(): OpenTeamStore {
  const store = createDefaultStore()
  const chat: GroupChat = {
    id: 'chat-1',
    name: '架构评审',
    mode: 'independent',
    roleIds: ['role-1'],
    messageIds: [],
    nextMessageSeq: 1,
    status: 'ready',
    createdAt: 0,
    updatedAt: 0,
  }
  const role: GroupRole = {
    id: 'role-1',
    chatId: chat.id,
    name: '工程师',
    systemPrompt: '从工程角度分析问题',
    status: 'ready',
    contextCursor: 0,
    createdAt: 0,
    updatedAt: 0,
  }
  store.currentChatId = chat.id
  store.chatOrder = [chat.id]
  store.chatsById[chat.id] = chat
  store.rolesById[role.id] = role
  return store
}

describe('background message handlers', () => {
  it('exposes group message route and sends prompts through injected delivery', async () => {
    vi.resetModules()
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createStoreWithReadyRole()
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const { MESSAGE_ROUTE_TYPES, createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const broadcastStoreUpdated = vi.fn()
    const sendPrompt = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
    })

    expect(MESSAGE_ROUTE_TYPES).toEqual([
      'GROUP_ROLE_RETRY_REPLY',
      'GROUP_ROLE_STOP_REPLY',
      'GROUP_NOTE_SAVE',
      'GROUP_MESSAGE_HIGHLIGHT_CREATE',
      'GROUP_MESSAGE_RESYNC_REPLY',
      'GROUP_MESSAGE_SEND',
      'TEAM_FRAME_ROLE_READY',
      'TEAM_ROLE_CONVERSATION_UPDATED',
      'TEAM_SEND_ACK',
      'TEAM_ROLE_STATUS',
      'TEAM_ROLE_REPLY',
      'TEAM_ROLE_REPLY_RESYNC',
      'TEAM_ROLE_ERROR',
    ])
    expect(routes.map(route => route.type)).toEqual(MESSAGE_ROUTE_TYPES)

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '帮我评审一下' }, {})

    expect(response).toMatchObject({
      ok: true,
      message: {
        id: 'msg-1',
        chatId: 'chat-1',
        content: '帮我评审一下',
        targetRoleIds: ['role-1'],
        deliveryStatus: { 'role-1': 'pending' },
      },
      deliveries: [{ roleId: 'role-1' }],
    })
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      roleId: 'role-1',
      tabId: 101,
      frameId: 7,
      message: expect.objectContaining({
        type: 'TEAM_SEND_PROMPT',
        chatId: 'chat-1',
        roleId: 'role-1',
        messageId: 'msg-1',
        replyAttemptId: 'attempt-1',
        includesPersona: true,
        content: expect.stringContaining('帮我评审一下'),
      }),
    }))
    expect(draftStore?.rolesById['role-1']).toMatchObject({
      status: 'thinking',
      lastPromptMessageId: 'msg-1',
      replyAttemptId: 'attempt-1',
    })
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(expect.objectContaining({
      messagesById: expect.objectContaining({ 'msg-1': expect.any(Object) }),
    }))
  })
})
