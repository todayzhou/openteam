// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { RoleToBackgroundMessage } from '../group/runtimeProtocol'
import { createReplyObserver } from './replyObserver'
import type { RoleSession } from './roleSession'
import type { ChatSiteAdapter } from './sites/types'

describe('createReplyObserver', () => {
  it('uses timeout compensation to report a visible reply instead of marking the role as failed', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<message-content id="old">旧回复</message-content>'

    const sentMessages: RoleToBackgroundMessage[] = []
    const roleSession = createFakeRoleSession()
    const adapter = createFakeAdapter({ isGenerating: () => false })
    const reportRoleError = vi.fn()
    const observer = createReplyObserver({
      siteAdapter: adapter,
      roleSession,
      log: createFakeLog(),
      sendRuntimeMessage: async message => {
        sentMessages.push(message)
        return { ok: true } as never
      },
      reportRoleError,
    })

    observer.capturePromptReplyBaseline('msg-1')
    roleSession.startPrompt('msg-1', 'attempt-1')
    document.body.insertAdjacentHTML('beforeend', '<message-content id="new">新的回复</message-content>')
    observer.startReplyPolling('msg-1', 'attempt-1')

    await vi.advanceTimersByTimeAsync(120_000)

    expect(sentMessages).toContainEqual({
      type: 'TEAM_ROLE_REPLY',
      chatId: 'chat-1',
      roleId: 'role-1',
      messageId: 'msg-1',
      replyAttemptId: 'attempt-1',
      content: '新的回复',
      contentFormat: undefined,
      conversationId: 'conv-1',
      conversationUrl: 'https://gemini.google.com/app/conv-1',
    })
    expect(sentMessages).not.toContainEqual(expect.objectContaining({ type: 'TEAM_ROLE_STATUS', status: 'error' }))
    expect(reportRoleError).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('keeps polling a very short stable reply so a longer continuation can be collected', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<message-content id="new">好的。</message-content>'

    const sentMessages: RoleToBackgroundMessage[] = []
    const roleSession = createFakeRoleSession()
    const adapter = createFakeAdapter({ isGenerating: () => false })
    const observer = createReplyObserver({
      siteAdapter: adapter,
      roleSession,
      log: createFakeLog(),
      sendRuntimeMessage: async message => {
        sentMessages.push(message)
        return { ok: true } as never
      },
      reportRoleError: vi.fn(),
    })

    roleSession.startPrompt('msg-1', 'attempt-1')
    observer.startReplyPolling('msg-1', 'attempt-1')

    await vi.advanceTimersByTimeAsync(4_000)

    expect(sentMessages).not.toContainEqual(expect.objectContaining({ type: 'TEAM_ROLE_REPLY' }))

    document.querySelector('message-content')!.textContent = '好的。这里是完整回复：短回复只是开头，后面还会继续补充关键判断、风险和下一步建议，应该等这一整段内容稳定后再上报。'

    await vi.advanceTimersByTimeAsync(4_000)

    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'TEAM_ROLE_REPLY',
      content: '好的。这里是完整回复：短回复只是开头，后面还会继续补充关键判断、风险和下一步建议，应该等这一整段内容稳定后再上报。',
    }))

    vi.useRealTimers()
  })

  it('does not report stable partial text while the page is still generating', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<message-content id="new">先输出的一段内容，后面还会继续补充。</message-content>'

    const sentMessages: RoleToBackgroundMessage[] = []
    const roleSession = createFakeRoleSession()
    const adapter = createFakeAdapter({ isGenerating: () => true })
    const observer = createReplyObserver({
      siteAdapter: adapter,
      roleSession,
      log: createFakeLog(),
      sendRuntimeMessage: async message => {
        sentMessages.push(message)
        return { ok: true } as never
      },
      reportRoleError: vi.fn(),
    })

    roleSession.startPrompt('msg-1', 'attempt-1')
    observer.startReplyPolling('msg-1', 'attempt-1')

    await vi.advanceTimersByTimeAsync(20_000)

    expect(sentMessages).not.toContainEqual(expect.objectContaining({ type: 'TEAM_ROLE_REPLY' }))

    vi.useRealTimers()
  })

  it('does not use timeout compensation while the page is still generating', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<message-content id="new">先输出的一段内容，仍在思考后续。</message-content>'

    const sentMessages: RoleToBackgroundMessage[] = []
    const roleSession = createFakeRoleSession()
    const reportRoleError = vi.fn()
    const adapter = createFakeAdapter({ isGenerating: () => true })
    const observer = createReplyObserver({
      siteAdapter: adapter,
      roleSession,
      log: createFakeLog(),
      sendRuntimeMessage: async message => {
        sentMessages.push(message)
        return { ok: true } as never
      },
      reportRoleError,
    })

    roleSession.startPrompt('msg-1', 'attempt-1')
    observer.startReplyPolling('msg-1', 'attempt-1')

    await vi.advanceTimersByTimeAsync(120_000)

    expect(sentMessages).not.toContainEqual(expect.objectContaining({ type: 'TEAM_ROLE_REPLY' }))
    expect(sentMessages).toContainEqual(expect.objectContaining({ type: 'TEAM_ROLE_STATUS', status: 'error' }))
    expect(reportRoleError).toHaveBeenCalled()

    vi.useRealTimers()
  })
})

function createFakeRoleSession(): RoleSession {
  let activeMessageId: string | undefined
  let activeReplyAttemptId: string | undefined

  return {
    getAssignedRole: () => ({ chatId: 'chat-1', roleId: 'role-1', roleName: '工程师' }),
    getActivePrompt: () => (activeMessageId ? { messageId: activeMessageId, replyAttemptId: activeReplyAttemptId } : undefined),
    getActiveMessageId: () => activeMessageId,
    getActiveReplyAttemptId: () => activeReplyAttemptId,
    getAssignedChatId: () => 'chat-1',
    assignRole: vi.fn(),
    startPrompt(messageId, replyAttemptId): void {
      activeMessageId = messageId
      activeReplyAttemptId = replyAttemptId
    },
    clearActivePrompt(messageId): string | undefined {
      if (messageId && activeMessageId !== messageId) return activeReplyAttemptId
      const replyAttemptId = activeReplyAttemptId
      activeMessageId = undefined
      activeReplyAttemptId = undefined
      return replyAttemptId
    },
  }
}

function createFakeAdapter(overrides: Partial<ChatSiteAdapter> = {}): ChatSiteAdapter {
  return {
    id: 'gemini',
    getConversationSnapshot: () => ({ conversationId: 'conv-1', conversationUrl: 'https://gemini.google.com/app/conv-1' }),
    getConversationId: () => 'conv-1',
    getResponseContainers: () => [...document.querySelectorAll('message-content')],
    getAllAssistantReplies: () => [...document.querySelectorAll('message-content')].map(element => element.textContent ?? '').filter(Boolean),
    readResponseText: node => node.textContent ?? '',
    findResponseContainer: element => element?.closest('message-content') ?? null,
    isGenerating: () => true,
    stopGenerating: vi.fn(async () => true),
    fillAndSend: vi.fn(),
    collectPromptDiagnostics: () => ({}),
    ...overrides,
  }
}

function createFakeLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}
