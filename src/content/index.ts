type FillMethod = 'execCommand'

interface SiteConfig {
  editor: string
  sendButton: string
  fillMethod: FillMethod
  responseSelector: string
}

interface TeamSendPromptMessage {
  type: 'TEAM_SEND_PROMPT'
  messageId?: string
  content: string
  autoSend?: boolean
}

const OPEN_TEAM_LOADED_KEY = '__OPENTEAM_LOADED__'
const RESPONSE_DEBOUNCE_MS = 800
const RESPONSE_MAX_WAIT_MS = 3000

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

function getSiteConfig(): SiteConfig {
  return {
    editor: 'div.ql-editor[contenteditable="true"]',
    sendButton: 'button.send-button[aria-label*="发送"], button.send-button[aria-label*="Send"]',
    fillMethod: 'execCommand',
    responseSelector: 'model-response, .model-response-text, message-content',
  }
}

function getConversationId(): string {
  const match = location.pathname.match(/\/chat\/([^/?#]+)/)
  return match ? match[1] : '__default__'
}

function hashStr(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0
  }
  return hash >>> 0
}

function querySelectorFirst(selectors: string): HTMLElement | null {
  for (const selector of selectors.split(',').map(item => item.trim())) {
    const element = document.querySelector(selector) as HTMLElement | null
    if (element) return element
  }

  return null
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
    if (element.matches('message-content, model-response, .model-response-text')) {
      return element
    }

    element = element.parentElement
  }

  return null
}

function observeResponseContainers(onStableText: (text: string, element: Element) => void): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  const pendingContainers = new Set<Element>()

  function flush(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }

    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer)
      maxWaitTimer = null
    }

    const containers = [...pendingContainers]
    pendingContainers.clear()

    requestAnimationFrame(() => {
      for (const container of containers) {
        const text = extractCleanText(container)
        if (text) onStableText(text, container)
      }
    })
  }

  function schedule(container: Element): void {
    pendingContainers.add(container)

    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(flush, RESPONSE_MAX_WAIT_MS)
    }

    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flush, RESPONSE_DEBOUNCE_MS)
  }

  function inspectNode(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const container = findResponseContainer((node as Text).parentElement)
      if (container) schedule(container)
      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return

    const element = node as Element
    const container = findResponseContainer(element)
    if (container) {
      schedule(container)
      return
    }

    element.querySelectorAll(getSiteConfig().responseSelector).forEach(schedule)
  }

  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        inspectNode(mutation.target)
        continue
      }

      mutation.addedNodes.forEach(inspectNode)
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true })

  requestAnimationFrame(() => {
    document.querySelectorAll(getSiteConfig().responseSelector).forEach(schedule)
  })
}

async function fillAndSend(content: string, autoSend = true): Promise<void> {
  const config = getSiteConfig()
  const editor = querySelectorFirst(config.editor)
  if (!editor) throw new Error('Gemini editor not found')

  editor.focus()

  if (config.fillMethod === 'execCommand') {
    document.execCommand('insertText', false, content)
  }

  if (!autoSend) return

  const sendButton = querySelectorFirst(config.sendButton)
  if (!sendButton) throw new Error('Gemini send button not found')

  sendButton.click()
}

function registerMessageHandlers(): void {
  chrome.runtime.onMessage.addListener((message: TeamSendPromptMessage, _sender, sendResponse) => {
    if (message?.type !== 'TEAM_SEND_PROMPT') return false

    fillAndSend(message.content, message.autoSend !== false)
      .then(() => sendResponse({ ok: true, messageId: message.messageId }))
      .catch(error => {
        const reason = error instanceof Error ? error.message : String(error)
        sendResponse({ ok: false, messageId: message.messageId, error: reason })
      })

    return true
  })
}

function startOpenTeam(): void {
  registerMessageHandlers()

  let lastReplyHash = ''
  observeResponseContainers(text => {
    const nextHash = String(hashStr(`${getConversationId()}:${text}`))
    if (nextHash === lastReplyHash) return

    lastReplyHash = nextHash
    console.debug('[OpenTeam] stable Gemini response observed', {
      conversationId: getConversationId(),
      textLength: text.length,
    })
  })
}

function bootWhenReady(): void {
  if (document.body) {
    startOpenTeam()
    return
  }

  document.addEventListener('DOMContentLoaded', startOpenTeam, { once: true })
}

if (!(window as unknown as Record<string, boolean>)[OPEN_TEAM_LOADED_KEY]) {
  ;(window as unknown as Record<string, boolean>)[OPEN_TEAM_LOADED_KEY] = true
  bootWhenReady()
}
