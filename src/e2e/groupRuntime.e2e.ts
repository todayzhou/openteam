import { describe, expect, it, vi } from 'vitest'
import type { GroupChat, OpenTeamStore } from '../group/types'

type RuntimeMessage = { type: string; [key: string]: unknown }
type MessageSender = chrome.runtime.MessageSender

interface BackgroundE2eHarness {
  tabsSendMessage: ReturnType<typeof vi.fn>
  getStore(): Promise<OpenTeamStore>
  invoke(message: RuntimeMessage, sender?: MessageSender): Promise<unknown>
}

async function setupBackgroundE2e(): Promise<BackgroundE2eHarness> {
  vi.resetModules()
  const { STORE_KEY, createDefaultStore, loadStore } = await import('../group/store')
  const stored: Record<string, unknown> = {
    [STORE_KEY]: createDefaultStore(),
  }
  const listeners: Array<(message: RuntimeMessage, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean> = []
  const tabsSendMessage = vi.fn().mockResolvedValue({ ok: true })

  vi.stubGlobal('chrome', {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn(listener => listeners.push(listener)) },
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      getURL: vi.fn((path: string) => `chrome-extension://openteam-test/${path}`),
    },
    storage: {
      local: {
        get: vi.fn(async (key?: string | string[] | null) => {
          if (key === null || typeof key === 'undefined') return structuredClone(stored)
          if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, structuredClone(stored[item])]))
          return { [key]: structuredClone(stored[key]) }
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(stored, structuredClone(items))
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]
        }),
      },
    },
    tabs: {
      sendMessage: tabsSendMessage,
      create: vi.fn().mockResolvedValue({}),
      onRemoved: { addListener: vi.fn() },
    },
    action: {
      onClicked: { addListener: vi.fn() },
    },
  })

  await import('../background/index')
  expect(listeners).toHaveLength(1)

  return {
    tabsSendMessage,
    getStore: loadStore,
    invoke: (message, sender = { tab: { id: 900 } as chrome.tabs.Tab, frameId: 0, url: 'https://gemini.google.com/app/test' }) =>
      new Promise(resolve => listeners[0](message, sender, resolve)),
  }
}

describe('OpenTeam extension E2E runtime flow', () => {
  it('runs the group happy path and marks background replies as unread activity', async () => {
    const harness = await setupBackgroundE2e()
    const chat = await createChat(harness, 'P5 主链路')
    const role = await createRole(harness, chat.id, '工程师')
    await readyFrame(harness, chat.id, role.id)

    const backgroundChat = await createChat(harness, '后台群聊')
    expect(backgroundChat.id).not.toBe(chat.id)

    const sent = await harness.invoke({ type: 'GROUP_MESSAGE_SEND', chatId: chat.id, raw: '@工程师 检查一下主链路' }) as { ok: boolean; message: { id: string } }
    expect(sent.ok).toBe(true)
    expect(harness.tabsSendMessage).toHaveBeenCalledWith(
      101,
      expect.objectContaining({
        type: 'TEAM_SEND_PROMPT',
        chatId: chat.id,
        roleId: role.id,
        messageId: sent.message.id,
        content: expect.stringContaining('检查一下主链路'),
      }),
      { frameId: 7 },
    )

    await harness.invoke({ type: 'TEAM_SEND_ACK', chatId: chat.id, roleId: role.id, messageId: sent.message.id })
    const reply = await harness.invoke({
      type: 'TEAM_ROLE_REPLY',
      chatId: chat.id,
      roleId: role.id,
      messageId: sent.message.id,
      content: '主链路回复已入库',
    }) as { ok: boolean }

    expect(reply.ok).toBe(true)
    const store = await harness.getStore()
    const messages = store.chatsById[chat.id].messageIds.map(messageId => store.messagesById[messageId])
    expect(messages.map(message => message.type)).toEqual(['user', 'assistant'])
    expect(messages[0]).toMatchObject({ status: 'received', deliveryStatus: { [role.id]: 'received' } })
    expect(messages[1]).toMatchObject({ type: 'assistant', roleId: role.id, content: '主链路回复已入库' })
    expect(store.currentChatId).toBe(backgroundChat.id)
    expect(store.viewState?.chatHasNewMessageById?.[chat.id]).toBe(true)
  })

  it('recovers a failed role frame and retries the pending prompt with a new attempt', async () => {
    const harness = await setupBackgroundE2e()
    const chat = await createChat(harness, 'P5 恢复链路')
    const role = await createRole(harness, chat.id, '产品经理')
    await readyFrame(harness, chat.id, role.id)

    const sent = await harness.invoke({ type: 'GROUP_MESSAGE_SEND', chatId: chat.id, raw: '@产品经理 请给一个风险判断' }) as { ok: boolean; message: { id: string } }
    expect(sent.ok).toBe(true)
    const firstPrompt = harness.tabsSendMessage.mock.calls.find(call => call[1]?.messageId === sent.message.id)?.[1]
    expect(firstPrompt?.replyAttemptId).toBeTruthy()

    const failed = await harness.invoke({
      type: 'TEAM_ROLE_ERROR',
      chatId: chat.id,
      roleId: role.id,
      messageId: sent.message.id,
      replyAttemptId: firstPrompt.replyAttemptId,
      reason: '人员回复超时',
    }) as { ok: boolean }
    expect(failed.ok).toBe(true)

    const recovered = await harness.invoke({ type: 'GROUP_ROLE_RECOVER', chatId: chat.id, roleId: role.id, hostTabId: 900 }) as { ok: boolean; iframeSrc: string }
    expect(recovered.ok).toBe(true)
    expect(recovered.iframeSrc).toBe('https://chat.deepseek.com/')
    await readyFrame(harness, chat.id, role.id)

    const retried = await harness.invoke({ type: 'GROUP_ROLE_RETRY_REPLY', chatId: chat.id, roleId: role.id, messageId: sent.message.id }) as { ok: boolean; messageId: string }
    expect(retried.ok).toBe(true)
    expect(retried.messageId).toBe(sent.message.id)

    const retryPrompt = harness.tabsSendMessage.mock.calls[harness.tabsSendMessage.mock.calls.length - 1][1]
    expect(retryPrompt).toMatchObject({ type: 'TEAM_SEND_PROMPT', chatId: chat.id, roleId: role.id, messageId: sent.message.id })
    expect(retryPrompt.replyAttemptId).toBeTruthy()
    expect(retryPrompt.replyAttemptId).not.toBe(firstPrompt.replyAttemptId)

    const store = await harness.getStore()
    expect(store.rolesById[role.id]).toMatchObject({
      status: 'thinking',
      lastPromptMessageId: sent.message.id,
      replyAttemptId: retryPrompt.replyAttemptId,
    })
    expect(store.messagesById[sent.message.id].deliveryStatus?.[role.id]).toBe('pending')
  })
})

async function createChat(harness: BackgroundE2eHarness, name: string): Promise<GroupChat> {
  const created = await harness.invoke({ type: 'GROUP_CHAT_CREATE', name, mode: 'independent' }) as { ok: boolean; chat: GroupChat }
  expect(created.ok).toBe(true)
  return created.chat
}

async function createRole(harness: BackgroundE2eHarness, chatId: string, name: string) {
  const created = await harness.invoke({
    type: 'GROUP_ROLE_CREATE',
    chatId,
    name,
    systemPrompt: `你是${name}`,
  }) as { ok: boolean; role: { id: string; name: string } }
  expect(created.ok).toBe(true)
  return created.role
}

async function readyFrame(harness: BackgroundE2eHarness, chatId: string, roleId: string): Promise<void> {
  const ready = await harness.invoke(
    { type: 'TEAM_FRAME_ROLE_READY', chatId, roleId, hostTabId: 900, conversationId: '__default__', conversationUrl: 'https://gemini.google.com/' },
    { tab: { id: 101 } as chrome.tabs.Tab, frameId: 7, url: 'https://gemini.google.com/' },
  ) as { ok: boolean }
  expect(ready.ok).toBe(true)
}
