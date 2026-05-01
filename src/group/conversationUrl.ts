const GEMINI_ORIGIN = 'https://gemini.google.com'
const GEMINI_HOME_URL = `${GEMINI_ORIGIN}/`
const GEMINI_APP_PREFIX = '/app/'

export function isSafeGeminiUrl(value: string | undefined): value is string {
  if (!value || !value.startsWith(GEMINI_HOME_URL)) return false

  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'gemini.google.com'
  } catch {
    return false
  }
}

export function getSafeGeminiUrl(value: string | undefined): string {
  return isSafeGeminiUrl(value) ? value : GEMINI_HOME_URL
}

export function getSafeGeminiIframeSrc(value: string | undefined): string {
  return getSafeGeminiUrl(value)
}

export function extractGeminiConversationId(value: string | undefined): string | undefined {
  if (!isSafeGeminiUrl(value)) return undefined

  const url = new URL(value)
  if (!url.pathname.startsWith(GEMINI_APP_PREFIX)) return undefined

  const conversationId = url.pathname.slice(GEMINI_APP_PREFIX.length).split('/')[0]
  return conversationId ? decodeURIComponent(conversationId) : undefined
}

export function normalizeGeminiConversationUrl(value: string | undefined): string | undefined {
  return isSafeGeminiUrl(value) ? new URL(value).href : undefined
}
