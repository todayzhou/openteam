// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore } from '../group/types'
import { createDefaultStore } from '../group/store'
import { createTeamPageState } from './appState'
import { THINKING_TIMEOUT_MS } from './chatExperience'
import { createMessagesView } from './messagesView'

describe('team page messages view boundary', () => {
  it('keeps message rendering and message actions outside the team page entrypoint', () => {
    const entrySource = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')
    const viewSource = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')

    expect(viewSource).toContain('function renderMessages(): void')
    expect(viewSource).toContain('function renderMessageNode(message: GroupMessage')
    expect(viewSource).toContain('function renderMarkdownMessageBody(body: HTMLElement, content: string)')
    expect(viewSource).toContain("createMessageIconButton('跳转到原始窗口'")
    expect(viewSource).toContain('showCopyFeedback(button)')
    expect(viewSource).toContain('function scheduleThinkingTimeouts(): void')
    expect(entrySource).not.toContain('function renderMessages(): void')
    expect(entrySource).not.toContain('function renderMessageNode(message: GroupMessage')
    expect(entrySource).not.toContain('function renderMarkdownMessageBody(body: HTMLElement, content: string)')
    expect(entrySource).not.toContain('function scheduleThinkingTimeouts(): void')
  })

  it('does not mark a role as failed from the UI when a thinking bubble expires', () => {
    const now = Date.now()
    const chat: GroupChat = {
      id: 'chat-1',
      name: '群聊',
      mode: 'independent',
      roleIds: ['role-1'],
      messageIds: [],
      nextMessageSeq: 1,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    }
    const role: GroupRole = {
      id: 'role-1',
      chatId: chat.id,
      name: '工程师',
      status: 'thinking',
      contextCursor: 0,
      lastPromptMessageId: 'msg-1',
      createdAt: now,
      updatedAt: now - THINKING_TIMEOUT_MS,
    }
    const store: OpenTeamStore = {
      ...createDefaultStore(),
      currentChatId: chat.id,
      chatOrder: [chat.id],
      chatsById: { [chat.id]: chat },
      rolesById: { [role.id]: role },
    }
    const runCommand = vi.fn(async () => undefined)

    createMessagesView({
      state: createTeamPageState(),
      getStore: () => store,
      messagesEl: document.createElement('section'),
      getCurrentChat: () => chat,
      getCurrentRoles: () => [role],
      getCurrentMessages: () => [],
      emptyCard: () => document.createElement('div'),
      openAddPersonDialog: vi.fn(),
      roleToneClass: () => 'role-tone-1',
      roleAvatarLabel: () => '工',
      messageTitle: message => message.roleName ?? 'AI 人员',
      focusRoleFrame: vi.fn(),
      insertMention: vi.fn(),
      setReference: vi.fn(),
      retryRoleReply: vi.fn(async () => undefined),
      stopRoleReply: vi.fn(async () => undefined),
      runCommand,
      render: vi.fn(),
      showError: vi.fn(),
      log: { warn: vi.fn() },
    }).renderMessages()

    expect(runCommand).not.toHaveBeenCalled()
  })

  it('renders assistant markdown even when older replies do not have a content format flag', () => {
    const now = Date.now()
    const chat: GroupChat = {
      id: 'chat-1',
      name: '群聊',
      mode: 'independent',
      roleIds: ['role-1'],
      messageIds: ['msg-1'],
      nextMessageSeq: 2,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    }
    const role: GroupRole = {
      id: 'role-1',
      chatId: chat.id,
      name: '工程师',
      status: 'ready',
      contextCursor: 0,
      createdAt: now,
      updatedAt: now,
    }
    const message: GroupMessage = {
      id: 'msg-1',
      chatId: chat.id,
      seq: 1,
      type: 'assistant',
      content: '这是 **重点** 内容',
      roleId: role.id,
      roleName: role.name,
      createdAt: now,
      status: 'received',
    }
    const store: OpenTeamStore = {
      ...createDefaultStore(),
      currentChatId: chat.id,
      chatOrder: [chat.id],
      chatsById: { [chat.id]: chat },
      rolesById: { [role.id]: role },
      messagesById: { [message.id]: message },
    }
    const messagesEl = document.createElement('section')

    createMessagesView({
      state: createTeamPageState(),
      getStore: () => store,
      messagesEl,
      getCurrentChat: () => chat,
      getCurrentRoles: () => [role],
      getCurrentMessages: () => [message],
      emptyCard: () => document.createElement('div'),
      openAddPersonDialog: vi.fn(),
      roleToneClass: () => 'role-tone-1',
      roleAvatarLabel: () => '工',
      messageTitle: message => message.roleName ?? 'AI 人员',
      focusRoleFrame: vi.fn(),
      insertMention: vi.fn(),
      setReference: vi.fn(),
      retryRoleReply: vi.fn(async () => undefined),
      stopRoleReply: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => undefined),
      render: vi.fn(),
      showError: vi.fn(),
      log: { warn: vi.fn() },
    }).renderMessages()

    expect(messagesEl.querySelector('.markdown-body strong')?.textContent).toBe('重点')
  })
})
