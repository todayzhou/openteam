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
      resyncMessageReply: vi.fn(async () => undefined),
      retryRoleReply: vi.fn(async () => undefined),
      stopRoleReply: vi.fn(async () => undefined),
      runCommand,
      render: vi.fn(),
      showError: vi.fn(),
      showSuccess: vi.fn(),
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
      resyncMessageReply: vi.fn(async () => undefined),
      retryRoleReply: vi.fn(async () => undefined),
      stopRoleReply: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => undefined),
      render: vi.fn(),
      showError: vi.fn(),
      showSuccess: vi.fn(),
      log: { warn: vi.fn() },
    }).renderMessages()

    expect(messagesEl.querySelector('.markdown-body strong')?.textContent).toBe('重点')
  })

  it('requests a full reply resync for the current assistant message without retrying the prompt', async () => {
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
      content: '不完整回复',
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
    const resyncMessageReply = vi.fn(async () => undefined)
    const showSuccess = vi.fn()
    const log = { warn: vi.fn() }

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
      resyncMessageReply,
      retryRoleReply: vi.fn(async () => undefined),
      stopRoleReply: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => undefined),
      render: vi.fn(),
      showError: vi.fn(),
      showSuccess,
      log,
    }).renderMessages()

    messagesEl.querySelector<HTMLButtonElement>('button[aria-label="重新同步完整回复"]')?.click()

    expect(resyncMessageReply).toHaveBeenCalledWith(message)
    await resyncMessageReply.mock.results[0]?.value
    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(showSuccess).toHaveBeenCalledWith('执行成功了')
    expect(log.warn).toHaveBeenCalledWith('ui:message-resync:click', {
      chatId: chat.id,
      roleId: role.id,
      messageId: message.id,
      contentLength: message.content.length,
    })
  })

  it('preserves message scroll once after a reply resync render', () => {
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
      content: '同步后的完整回复',
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
    const state = createTeamPageState()
    state.preserveNextMessageScroll = true
    const messagesEl = document.createElement('section')
    messagesEl.scrollTop = 120
    Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, value: 960 })

    createMessagesView({
      state,
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
      resyncMessageReply: vi.fn(async () => undefined),
      retryRoleReply: vi.fn(async () => undefined),
      stopRoleReply: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => undefined),
      render: vi.fn(),
      showError: vi.fn(),
      showSuccess: vi.fn(),
      log: { warn: vi.fn() },
    }).renderMessages()

    expect(messagesEl.scrollTop).toBe(120)
    expect(state.preserveNextMessageScroll).toBe(true)
  })

  it('preserves message scroll across push and command renders during reply resync', async () => {
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
      content: '不完整回复',
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
    const state = createTeamPageState()
    const messagesEl = document.createElement('section')
    Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, value: 960 })
    let finishResync: (() => void) | undefined
    const resyncMessageReply = vi.fn(() => new Promise<void>(resolve => {
      finishResync = resolve
    }))

    const view = createMessagesView({
      state,
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
      resyncMessageReply,
      retryRoleReply: vi.fn(async () => undefined),
      stopRoleReply: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => undefined),
      render: vi.fn(),
      showError: vi.fn(),
      showSuccess: vi.fn(),
      log: { warn: vi.fn() },
    })

    view.renderMessages()
    messagesEl.scrollTop = 120
    messagesEl.querySelector<HTMLButtonElement>('button[aria-label="重新同步完整回复"]')?.click()

    view.renderMessages()
    expect(messagesEl.scrollTop).toBe(120)
    expect(state.preserveNextMessageScroll).toBe(true)

    view.renderMessages()
    expect(messagesEl.scrollTop).toBe(120)

    finishResync?.()
    await resyncMessageReply.mock.results[0]?.value
    await new Promise(resolve => window.setTimeout(resolve, 0))

    expect(state.preserveNextMessageScroll).toBe(false)
  })

  it('keeps the current reading position when new replies render away from the bottom', () => {
    const now = Date.now()
    const chat: GroupChat = {
      id: 'chat-1',
      name: '群聊',
      mode: 'independent',
      roleIds: ['role-1'],
      messageIds: ['msg-1', 'msg-2'],
      nextMessageSeq: 3,
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
    const messages: GroupMessage[] = [
      {
        id: 'msg-1',
        chatId: chat.id,
        seq: 1,
        type: 'user',
        content: '请分析这个方案',
        createdAt: now,
        status: 'sent',
      },
      {
        id: 'msg-2',
        chatId: chat.id,
        seq: 2,
        type: 'assistant',
        content: '后续人员的新回复',
        roleId: role.id,
        roleName: role.name,
        createdAt: now + 1,
        status: 'received',
      },
    ]
    const store: OpenTeamStore = {
      ...createDefaultStore(),
      currentChatId: chat.id,
      chatOrder: [chat.id],
      chatsById: { [chat.id]: chat },
      rolesById: { [role.id]: role },
      messagesById: Object.fromEntries(messages.map(message => [message.id, message])),
    }
    const messagesEl = document.createElement('section')
    messagesEl.scrollTop = 120
    Object.defineProperty(messagesEl, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, value: 1000 })

    createMessagesView({
      state: createTeamPageState(),
      getStore: () => store,
      messagesEl,
      getCurrentChat: () => chat,
      getCurrentRoles: () => [role],
      getCurrentMessages: () => messages,
      emptyCard: () => document.createElement('div'),
      openAddPersonDialog: vi.fn(),
      roleToneClass: () => 'role-tone-1',
      roleAvatarLabel: () => '工',
      messageTitle: message => message.roleName ?? 'AI 人员',
      focusRoleFrame: vi.fn(),
      insertMention: vi.fn(),
      setReference: vi.fn(),
      resyncMessageReply: vi.fn(async () => undefined),
      retryRoleReply: vi.fn(async () => undefined),
      stopRoleReply: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => undefined),
      render: vi.fn(),
      showError: vi.fn(),
      showSuccess: vi.fn(),
      log: { warn: vi.fn() },
    }).renderMessages()

    expect(messagesEl.scrollTop).toBe(120)
  })

  it('continues following new replies when the reader is already near the bottom', () => {
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
      content: '最新回复',
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
    messagesEl.scrollTop = 680
    Object.defineProperty(messagesEl, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, value: 1000 })

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
      resyncMessageReply: vi.fn(async () => undefined),
      retryRoleReply: vi.fn(async () => undefined),
      stopRoleReply: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => undefined),
      render: vi.fn(),
      showError: vi.fn(),
      showSuccess: vi.fn(),
      log: { warn: vi.fn() },
    }).renderMessages()

    expect(messagesEl.scrollTop).toBe(1000)
  })

  it('renders saved message highlights without changing the message text', () => {
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
      content: '这里有一段重点内容',
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
      messageHighlightsById: {
        [message.id]: [
          {
            id: 'highlight-1',
            messageId: message.id,
            text: '重点',
            startOffset: 5,
            endOffset: 7,
            createdAt: now,
          },
        ],
      },
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
      resyncMessageReply: vi.fn(async () => undefined),
      retryRoleReply: vi.fn(async () => undefined),
      stopRoleReply: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => undefined),
      render: vi.fn(),
      showError: vi.fn(),
      showSuccess: vi.fn(),
      log: { warn: vi.fn() },
    }).renderMessages()

    expect(messagesEl.textContent).toContain(message.content)
    expect(messagesEl.querySelector('.message-highlight')?.textContent).toBe('重点')
  })

  it('offers selected message text actions that can highlight and add to notes', async () => {
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
      content: '这里有一段重点内容',
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
    document.body.append(messagesEl)
    const runCommand = vi.fn(async () => undefined)
    const insertTextIntoActiveNote = vi.fn()

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
      insertTextIntoActiveNote,
      resyncMessageReply: vi.fn(async () => undefined),
      retryRoleReply: vi.fn(async () => undefined),
      stopRoleReply: vi.fn(async () => undefined),
      runCommand,
      render: vi.fn(),
      showError: vi.fn(),
      showSuccess: vi.fn(),
      log: { warn: vi.fn() },
    }).renderMessages()

    const bodyText = messagesEl.querySelector('.message-body')?.firstChild?.firstChild
    expect(bodyText?.textContent).toContain('重点')
    const range = document.createRange()
    range.setStart(bodyText as Text, 5)
    range.setEnd(bodyText as Text, 7)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)

    messagesEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('button[aria-label="高亮并加入笔记"]')?.click()
    await Promise.resolve()

    expect(insertTextIntoActiveNote).toHaveBeenCalledWith('重点')
    expect(runCommand).toHaveBeenCalledWith('GROUP_MESSAGE_HIGHLIGHT_CREATE', {
      chatId: chat.id,
      messageId: message.id,
      text: '重点',
      startOffset: 5,
      endOffset: 7,
    })
  })
})
