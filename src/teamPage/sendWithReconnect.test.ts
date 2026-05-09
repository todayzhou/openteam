import { describe, expect, it, vi } from 'vitest'
import type { GroupChat, GroupRole } from '../group/types'
import { runCommandWithReconnect } from './sendWithReconnect'

const chat: GroupChat = {
  id: 'chat-1',
  name: '群聊',
  mode: 'independent',
  roleIds: ['role-1', 'role-2'],
  messageIds: [],
  nextMessageSeq: 1,
  status: 'ready',
  createdAt: 1,
  updatedAt: 1,
}

function role(id: string, status: GroupRole['status']): GroupRole {
  return { id, chatId: chat.id, name: id, status, contextCursor: 0, createdAt: 1, updatedAt: 1 }
}

describe('runCommandWithReconnect', () => {
  it('reuses the composer retry path when a command reports unavailable roles', async () => {
    const roles = [role('role-1', 'ready'), role('role-2', 'ready')]
    const reconnectRolesForSend = vi.fn(async () => undefined)
    const runCommand = vi.fn()
      .mockRejectedValueOnce(new Error('以下人员不可用，请等待或恢复：role-1'))
      .mockResolvedValueOnce(undefined)

    await runCommandWithReconnect({ reconnectRolesForSend, runCommand }, { chat, roles, type: 'GROUP_MESSAGE_SEND', payload: { chatId: chat.id, raw: '@role-1 hi' } })

    expect(reconnectRolesForSend).toHaveBeenCalledWith(chat, roles)
    expect(runCommand).toHaveBeenCalledTimes(2)
  })

  it('can preconnect every target role before orchestration commands', async () => {
    const roles = [role('role-1', 'ready'), role('role-2', 'thinking')]
    const reconnectRolesForSend = vi.fn(async () => undefined)
    const runCommand = vi.fn(async () => undefined)

    await runCommandWithReconnect({ reconnectRolesForSend, runCommand }, {
      chat,
      roles,
      type: 'GROUP_ORCHESTRATION_RUN',
      payload: { chatId: chat.id, flowId: 'flow-1', task: 'task' },
      preconnectAll: true,
    })

    expect(reconnectRolesForSend).toHaveBeenCalledWith(chat, roles)
    expect(runCommand.mock.invocationCallOrder[0]).toBeGreaterThan(reconnectRolesForSend.mock.invocationCallOrder[0])
  })
})
