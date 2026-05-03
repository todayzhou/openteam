import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

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
})
