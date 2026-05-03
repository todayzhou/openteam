import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasTopLevelStaticImport } from '../vite.config'

describe('extension security configuration', () => {
  it('scopes host permissions to supported AI chat sites', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'public/manifest.json'), 'utf8')) as {
      host_permissions?: string[]
    }

    expect(manifest.host_permissions).toEqual([
      'https://gemini.google.com/*',
      'https://*.gemini.google.com/*',
      'https://chatgpt.com/*',
      'https://*.chatgpt.com/*',
      'https://chat.openai.com/*',
      'https://claude.ai/*',
      'https://chat.deepseek.com/*',
    ])
    expect(manifest.host_permissions).not.toContain('<all_urls>')
  })

  it('limits iframe header overrides to supported AI chat subframes', () => {
    const rules = JSON.parse(readFileSync(resolve(process.cwd(), 'public/rules.json'), 'utf8')) as Array<{
      condition?: {
        urlFilter?: string
        resourceTypes?: string[]
      }
    }>

    expect(rules).toHaveLength(5)
    expect(rules.map(rule => rule.condition?.urlFilter)).toEqual([
      '||gemini.google.com/',
      '||chatgpt.com/',
      '||chat.openai.com/',
      '||claude.ai/',
      '||chat.deepseek.com/',
    ])

    for (const rule of rules) {
      expect(rule.condition?.resourceTypes).toEqual(['sub_frame'])
      expect(rule.condition?.urlFilter).not.toBe('*://*/*')
      expect(rule.condition?.resourceTypes).not.toContain('main_frame')
    }
  })

  it('detects compact static imports in content script output', () => {
    expect(hasTopLevelStaticImport('import{c as createLogger}from"./assets/logger.js";')).toBe(true)
    expect(hasTopLevelStaticImport('(() => { console.log("bundled") })();')).toBe(false)
  })
})
