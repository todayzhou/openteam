const GEMINI_ORIGIN = 'https://gemini.google.com'
const GEMINI_HOME_URL = `${GEMINI_ORIGIN}/`
const GEMINI_APP_PREFIX = '/app/'

export interface GeminiConversationLocation {
  conversationId?: string
  conversationUrl?: string
}

export function getGeminiConversationLocation(href: string): GeminiConversationLocation {
  const url = parseSafeGeminiUrl(href)
  if (!url) return {}

  return {
    conversationId: extractConversationId(url),
    conversationUrl: url.href,
  }
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
