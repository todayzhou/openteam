import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupMessage, GroupRole, OpenTeamStore } from '../group/types'
import { createControlActionExecutor, readTaskResult } from './controlHandlers'
import type { RuntimeMessage } from './runtimeClient'

describe('background control handlers', () => {
  it('routes create-and-post through existing chat, role, and message runtime commands', async () => {
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    const routeRuntimeMessage = vi.fn(async (message: RuntimeMessage) => {
      if (message.type === 'GROUP_CHAT_CREATE') {
        const chat = {
          id: 'chat-1',
          name: String(message.name),
          mode: 'independent',
          roleIds: [],
          messageIds: [],
          nextMessageSeq: 1,
          status: 'draft',
          createdAt: 1,
          updatedAt: 1,
        } satisfies OpenTeamStore['chatsById'][string]
        store.chatsById[chat.id] = chat
        store.chatOrder = [chat.id]
        store.currentChatId = chat.id
        return { ok: true, chat, store }
      }
      if (message.type === 'GROUP_ROLES_CREATE_BATCH') {
        const roles: GroupRole[] = [
          makeRole('chat-1', 'role-eng', '工程师'),
          makeRole('chat-1', 'role-pm', '产品经理'),
        ]
        store.chatsById['chat-1'].roleIds = roles.map(role => role.id)
        store.rolesById = Object.fromEntries(roles.map(role => [role.id, role]))
        return { ok: true, roles, store }
      }
      if (message.type === 'GROUP_CHAT_SWITCH') {
        store.currentChatId = String(message.chatId)
        return { ok: true, store }
      }
      if (message.type === 'GROUP_MESSAGE_SEND') {
        const userMessage: GroupMessage = {
          id: 'msg-task',
          chatId: 'chat-1',
          seq: 1,
          type: 'user',
          content: '请评估这个方案',
          targetRoleIds: ['role-eng', 'role-pm'],
          mentionsAll: true,
          createdAt: 2,
          status: 'pending',
          deliveryStatus: { 'role-eng': 'pending', 'role-pm': 'pending' },
        }
        store.messagesById[userMessage.id] = userMessage
        store.chatsById['chat-1'].messageIds = [userMessage.id]
        return { ok: true, message: userMessage, store }
      }
      throw new Error(`unexpected route ${message.type}`)
    })
    const executor = createControlActionExecutor({
      loadStore: async () => store,
      routeRuntimeMessage,
      runtimeFrames: { list: () => [] },
      openTeamPage: vi.fn(),
      waitFor: async () => undefined,
      now: () => 10,
    })

    const result = await executor({
      id: 'cmd-1',
      action: 'run.createAndPost',
      payload: {
        chat: { name: '方案评审', mode: 'independent' },
        roles: [
          { source: 'temporary', name: '工程师', systemPrompt: '从工程角度评估' },
          { source: 'temporary', name: '产品经理', systemPrompt: '从产品角度评估' },
        ],
        task: { target: 'all', content: '请评估这个方案' },
        options: { waitForReplies: false },
      },
    })

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({
      chat: { id: 'chat-1', name: '方案评审' },
      roles: [{ id: 'role-eng' }, { id: 'role-pm' }],
      taskMessage: { id: 'msg-task', status: 'pending' },
    })
    expect(routeRuntimeMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'GROUP_CHAT_CREATE',
      name: '方案评审',
      mode: 'independent',
    }))
    expect(routeRuntimeMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'GROUP_ROLES_CREATE_BATCH',
      chatId: 'chat-1',
      items: expect.arrayContaining([
        expect.objectContaining({ source: 'temporary', name: '工程师', systemPrompt: '从工程角度评估' }),
      ]),
    }))
    expect(routeRuntimeMessage).toHaveBeenNthCalledWith(3, expect.objectContaining({
      type: 'GROUP_CHAT_SWITCH',
      chatId: 'chat-1',
    }))
    expect(routeRuntimeMessage).toHaveBeenNthCalledWith(4, expect.objectContaining({
      type: 'GROUP_MESSAGE_SEND',
      chatId: 'chat-1',
      raw: '@所有人 请评估这个方案',
    }))
  })

  it('reads replies belonging to a task message without leaking later turns', () => {
    const store = createDefaultStore()
    store.chatsById['chat-1'] = {
      id: 'chat-1',
      name: '评审群',
      mode: 'independent',
      roleIds: ['role-eng', 'role-pm'],
      messageIds: ['msg-task', 'msg-eng', 'msg-pm', 'msg-next', 'msg-later'],
      nextMessageSeq: 6,
      status: 'ready',
      createdAt: 1,
      updatedAt: 5,
    }
    store.rolesById['role-eng'] = makeRole('chat-1', 'role-eng', '工程师')
    store.rolesById['role-pm'] = makeRole('chat-1', 'role-pm', '产品经理')
    store.messagesById['msg-task'] = {
      id: 'msg-task',
      chatId: 'chat-1',
      seq: 1,
      type: 'user',
      content: '请评估这个方案',
      targetRoleIds: ['role-eng', 'role-pm'],
      createdAt: 1,
      status: 'received',
      deliveryStatus: { 'role-eng': 'received', 'role-pm': 'received' },
    }
    store.messagesById['msg-eng'] = makeReply('msg-eng', 'role-eng', '工程师', '工程可行', 2, 'msg-task')
    store.messagesById['msg-pm'] = makeReply('msg-pm', 'role-pm', '产品经理', '产品可行', 3, 'msg-task')
    store.messagesById['msg-next'] = {
      id: 'msg-next',
      chatId: 'chat-1',
      seq: 4,
      type: 'user',
      content: '继续追问',
      targetRoleIds: ['role-eng'],
      createdAt: 4,
      status: 'pending',
    }
    store.messagesById['msg-later'] = makeReply('msg-later', 'role-eng', '工程师', '后续回复', 5, 'msg-next')

    expect(readTaskResult(store, 'chat-1', 'msg-task')).toMatchObject({
      messageId: 'msg-task',
      status: 'received',
      replies: [
        { messageId: 'msg-eng', roleId: 'role-eng', content: '工程可行' },
        { messageId: 'msg-pm', roleId: 'role-pm', content: '产品可行' },
      ],
    })
  })
})

function makeRole(chatId: string, id: string, name: string): GroupRole {
  return {
    id,
    chatId,
    name,
    systemPrompt: `${name}人设`,
    status: 'ready',
    contextCursor: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeReply(id: string, roleId: string, roleName: string, content: string, seq: number, sourceMessageId: string): GroupMessage {
  return {
    id,
    chatId: 'chat-1',
    seq,
    type: 'assistant',
    content,
    roleId,
    roleName,
    sourceMessageId,
    createdAt: seq,
    status: 'received',
  }
}
