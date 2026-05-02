// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createGeminiAdapter } from './gemini'

describe('Gemini site adapter', () => {
  it('extracts Gemini conversation ids and normalized safe urls', () => {
    const adapter = createGeminiAdapter({ href: 'https://gemini.google.com/app/abc-123?hl=en' })

    expect(adapter.getConversationSnapshot()).toEqual({
      conversationId: 'abc-123',
      conversationUrl: 'https://gemini.google.com/app/abc-123?hl=en',
    })
  })

  it('does not report non-Gemini urls', () => {
    const adapter = createGeminiAdapter({ href: 'https://example.com/app/abc-123' })

    expect(adapter.getConversationSnapshot()).toEqual({
      conversationId: undefined,
      conversationUrl: undefined,
    })
  })

  it('writes prompt text into Gemini contenteditable editors', async () => {
    document.body.innerHTML = '<rich-textarea><div contenteditable="true"><p><br></p></div></rich-textarea>'
    const editor = document.querySelector<HTMLElement>('[contenteditable="true"]')!
    const inputListener = vi.fn()
    editor.addEventListener('input', inputListener)

    await createGeminiAdapter().fillAndSend('你好', false)

    expect(editor.textContent).toBe('你好')
    expect(editor.querySelector('hello')).toBeNull()
    expect(inputListener).toHaveBeenCalledTimes(1)
  })

  it('waits for a clickable send button before clicking', async () => {
    document.body.innerHTML = `
      <rich-textarea><div contenteditable="true"></div></rich-textarea>
      <button class="send-button" aria-label="Send" disabled>Send</button>
    `
    const button = document.querySelector<HTMLButtonElement>('button')!
    const clickListener = vi.fn()
    button.addEventListener('click', clickListener)
    window.setTimeout(() => {
      button.disabled = false
    }, 20)

    await createGeminiAdapter({ inputTimeoutMs: 250 }).fillAndSend('hello', true)

    expect(clickListener).toHaveBeenCalledTimes(1)
  })

  it('reads assistant replies from deepest Gemini response containers', () => {
    document.body.innerHTML = `
      <model-response>
        <message-content>第一段 <button>copy</button><span aria-hidden="true">hidden</span><p>第二段</p></message-content>
      </model-response>
    `

    expect(createGeminiAdapter().getAllAssistantReplies()).toEqual(['第一段\n第二段'])
  })
})
