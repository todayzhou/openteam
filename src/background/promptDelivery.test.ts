import { describe, expect, it, vi } from 'vitest'

describe('background prompt delivery', () => {
  it('sends a prompt to the target frame and reports failed content responses', async () => {
    vi.resetModules()
    const tabsSendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: '输入框不可用' })
    vi.stubGlobal('chrome', { tabs: { sendMessage: tabsSendMessage } })

    const { createPromptSender } = await import('./promptDelivery')
    const log = { info: vi.fn(), warn: vi.fn() }
    const sendPrompt = createPromptSender({ log })
    const delivery = {
      roleId: 'role-1',
      tabId: 101,
      frameId: 7,
      message: {
        type: 'TEAM_SEND_PROMPT' as const,
        chatId: 'chat-1',
        roleId: 'role-1',
        messageId: 'msg-1',
        content: '请分析',
        includesPersona: true,
      },
    }

    await expect(sendPrompt(delivery)).resolves.toBeUndefined()
    await expect(sendPrompt(delivery)).rejects.toThrow('输入框不可用')

    expect(tabsSendMessage).toHaveBeenCalledWith(101, delivery.message, { frameId: 7 })
    expect(log.info).toHaveBeenCalledWith('prompt:send:start', expect.objectContaining({
      chatId: 'chat-1',
      roleId: 'role-1',
      messageId: 'msg-1',
      includesPersona: true,
    }))
    expect(log.warn).toHaveBeenCalledWith('prompt:send:failed', expect.objectContaining({
      chatId: 'chat-1',
      roleId: 'role-1',
      messageId: 'msg-1',
      error: '输入框不可用',
    }))
  })

  it('retries prompt delivery through a shared helper using the latest frame binding', async () => {
    const { sendPromptDeliveryWithRetry } = await import('./promptDeliveryRetry')
    const sendPrompt = vi.fn()
      .mockRejectedValueOnce(new Error('输入框繁忙'))
      .mockResolvedValueOnce(undefined)
    const delivery = {
      roleId: 'role-1',
      tabId: 101,
      frameId: 1,
      message: {
        type: 'TEAM_SEND_PROMPT' as const,
        chatId: 'chat-1',
        roleId: 'role-1',
        messageId: 'msg-1',
        content: '请分析',
      },
    }
    const getLatestBinding = vi.fn()
      .mockReturnValueOnce({ ready: true, tabId: 101, frameId: 1 })
      .mockReturnValueOnce({ ready: true, tabId: 202, frameId: 2 })
    const markDeliveryError = vi.fn(async () => undefined)

    await expect(sendPromptDeliveryWithRetry({
      log: { warn: vi.fn() },
      sendPrompt,
      getLatestBinding,
      isDeliveryStillActive: vi.fn(async () => true),
      markDeliveryError,
      waitForRetry: vi.fn(async () => undefined),
    }, {
      chatId: 'chat-1',
      messageId: 'msg-1',
      delivery,
      retryDelaysMs: [0],
    })).resolves.toBe(true)

    expect(sendPrompt).toHaveBeenNthCalledWith(1, expect.objectContaining({ tabId: 101, frameId: 1 }))
    expect(sendPrompt).toHaveBeenNthCalledWith(2, expect.objectContaining({ tabId: 202, frameId: 2 }))
    expect(markDeliveryError).not.toHaveBeenCalled()
  })
})
