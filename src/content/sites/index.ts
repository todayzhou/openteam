import { createGeminiAdapter } from './gemini'
import type { ChatSiteAdapter } from './types'

export function getActiveChatSiteAdapter(): ChatSiteAdapter {
  return createGeminiAdapter()
}
