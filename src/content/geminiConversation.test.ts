import { describe, expect, it } from 'vitest'
import { getGeminiConversationLocation } from './geminiConversation'

describe('gemini conversation location', () => {
  it('extracts Gemini app conversation ids and normalized safe urls', () => {
    expect(getGeminiConversationLocation('https://gemini.google.com/app/abc-123?hl=en')).toEqual({
      conversationId: 'abc-123',
      conversationUrl: 'https://gemini.google.com/app/abc-123?hl=en',
    })
  })

  it('does not report non-Gemini urls', () => {
    expect(getGeminiConversationLocation('https://example.com/app/abc-123')).toEqual({
      conversationId: undefined,
      conversationUrl: undefined,
    })
  })
})
