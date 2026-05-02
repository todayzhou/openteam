import type { ChatSiteAdapter, ConversationSnapshot } from './types'
import { keepDeepestResponseContainers } from '../responseContainers'

const GEMINI_ORIGIN = 'https://gemini.google.com'
const GEMINI_HOME_URL = `${GEMINI_ORIGIN}/`
const GEMINI_APP_PREFIX = '/app/'
const DEFAULT_INPUT_TIMEOUT_MS = 9000

const GEMINI_SELECTORS = {
  editor: 'div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"]',
  sendButton:
    'button.send-button[aria-label*="发送"], button.send-button[aria-label*="Send"], button[aria-label*="Send message"], button[aria-label*="发送消息"]',
  response: 'model-response, .model-response-text, message-content',
}

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'BR',
  'LI',
  'TR',
  'PRE',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
])

const SKIP_TAGS = new Set([
  'MAT-ICON',
  'SCRIPT',
  'STYLE',
  'BUTTON',
  'MS-THOUGHT-CHUNK',
  'MAT-EXPANSION-PANEL-HEADER',
])

interface GeminiAdapterOptions {
  href?: string
  inputTimeoutMs?: number
}

export function createGeminiAdapter(options: GeminiAdapterOptions = {}): ChatSiteAdapter {
  const inputTimeoutMs = options.inputTimeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS

  function currentHref(): string {
    return options.href ?? location.href
  }

  function getConversationSnapshot(): ConversationSnapshot {
    return getGeminiConversationLocation(currentHref())
  }

  function getConversationId(): string {
    return getConversationSnapshot().conversationId || '__default__'
  }

  function getResponseContainers(): Element[] {
    return [...document.querySelectorAll(GEMINI_SELECTORS.response)]
  }

  function getAllAssistantReplies(): string[] {
    return keepDeepestResponseContainers(getResponseContainers()).map(container => extractCleanText(container)).filter(Boolean)
  }

  async function fillAndSend(content: string, autoSend = true): Promise<void> {
    const editor = await waitForElement(GEMINI_SELECTORS.editor, inputTimeoutMs)

    setContentEditableText(editor, content)
    if (readEditorText(editor) !== content.trim()) {
      throw new Error('Gemini editor did not accept the prompt text')
    }

    if (!autoSend) return

    const sendButton = await waitForClickableButton(GEMINI_SELECTORS.sendButton, inputTimeoutMs)
    sendButton.click()
  }

  return {
    id: 'gemini',
    getConversationSnapshot,
    getConversationId,
    getResponseContainers,
    getAllAssistantReplies,
    readResponseText: extractCleanText,
    findResponseContainer,
    isGenerating: isGeminiGenerating,
    fillAndSend,
    collectPromptDiagnostics,
  }
}

export function getGeminiConversationLocation(href: string): ConversationSnapshot {
  const url = parseSafeGeminiUrl(href)
  if (!url) return {}

  return {
    conversationId: extractConversationId(url),
    conversationUrl: url.href,
  }
}

export function setContentEditableText(editor: HTMLElement, content: string): void {
  editor.focus()
  editor.replaceChildren()

  const block = document.createElement('p')
  block.textContent = content
  editor.append(block)

  editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: content }))
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }))
  editor.dispatchEvent(new Event('change', { bubbles: true }))
}

export function isClickableButton(element: HTMLElement): boolean {
  if (!(element instanceof HTMLButtonElement)) return true
  return !element.disabled && element.getAttribute('aria-disabled') !== 'true'
}

function parseSafeGeminiUrl(value: string | undefined): URL | undefined {
  if (!value || !value.startsWith(GEMINI_HOME_URL)) return undefined

  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'gemini.google.com' ? url : undefined
  } catch {
    return undefined
  }
}

function extractConversationId(url: URL): string | undefined {
  if (!url.pathname.startsWith(GEMINI_APP_PREFIX)) return undefined

  const conversationId = url.pathname.slice(GEMINI_APP_PREFIX.length).split('/')[0]
  return conversationId ? decodeURIComponent(conversationId) : undefined
}

function querySelectorFirst(selectors: string): HTMLElement | null {
  for (const selector of selectors.split(',').map(item => item.trim())) {
    const element = document.querySelector(selector) as HTMLElement | null
    if (element) return element
  }

  return null
}

function describeElement(element: Element): Record<string, unknown> {
  const htmlElement = element as HTMLElement
  return {
    tagName: element.tagName,
    id: htmlElement.id || undefined,
    className: typeof htmlElement.className === 'string' ? htmlElement.className.slice(0, 120) : undefined,
    role: element.getAttribute('role') || undefined,
    ariaLabel: element.getAttribute('aria-label') || undefined,
    ariaDisabled: element.getAttribute('aria-disabled') || undefined,
    disabled: element instanceof HTMLButtonElement ? element.disabled : undefined,
    contentEditable: htmlElement.contentEditable || undefined,
  }
}

function collectPromptDiagnostics(): Record<string, unknown> {
  return {
    href: location.href,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    title: document.title,
    editorMatches: [...document.querySelectorAll(GEMINI_SELECTORS.editor)].slice(0, 5).map(describeElement),
    sendButtonMatches: [...document.querySelectorAll(GEMINI_SELECTORS.sendButton)].slice(0, 5).map(describeElement),
    visibleButtonSamples: [...document.querySelectorAll('button')].slice(0, 12).map(describeElement),
  }
}

function waitForElement(selectors: string, timeoutMs: number): Promise<HTMLElement> {
  const immediate = querySelectorFirst(selectors)
  if (immediate) return Promise.resolve(immediate)

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const element = querySelectorFirst(selectors)
      if (element) {
        window.clearInterval(timer)
        resolve(element)
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timer)
        reject(new Error(`Element not found: ${selectors}`))
      }
    }, 250)
  })
}

function waitForClickableButton(selectors: string, timeoutMs: number): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const button = querySelectorFirst(selectors)
      if (button && isClickableButton(button)) {
        window.clearInterval(timer)
        resolve(button)
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timer)
        reject(new Error('Gemini 发送按钮暂不可用，请稍后重试'))
      }
    }, 250)
  })
}

function extractCleanText(node: Node): string {
  const buffer: string[] = []

  function visit(current: Node): void {
    if (current.nodeType === Node.TEXT_NODE) {
      buffer.push(current.textContent || '')
      return
    }

    if (current.nodeType !== Node.ELEMENT_NODE) return

    const element = current as Element
    if (element.getAttribute('aria-hidden') === 'true') return
    if (SKIP_TAGS.has(element.tagName)) return
    if (BLOCK_TAGS.has(element.tagName)) buffer.push('\n')

    for (const child of element.childNodes) {
      visit(child)
    }
  }

  visit(node)

  return buffer
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function findResponseContainer(element: Element | null): Element | null {
  while (element) {
    if (element.matches(GEMINI_SELECTORS.response)) return element

    element = element.parentElement
  }

  return null
}

function isGeminiGenerating(): boolean {
  return [...document.querySelectorAll('button')].some(button => {
    const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return /stop|stopping|停止|中止/.test(label) && isClickableButton(button as HTMLElement)
  })
}

function readEditorText(editor: HTMLElement): string {
  return (editor.innerText || editor.textContent || '').trim()
}
