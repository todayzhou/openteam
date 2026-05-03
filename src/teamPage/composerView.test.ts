import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('team page composer view boundary', () => {
  it('keeps composer rendering, references, mentions, and send flow outside the entrypoint', () => {
    const entrySource = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')
    const viewSource = readFileSync(resolve(process.cwd(), 'src/teamPage/composerView.ts'), 'utf8')

    expect(viewSource).toContain('function renderComposerState(): void')
    expect(viewSource).toContain('function renderReferenceDraft(): void')
    expect(viewSource).toContain('function renderMentionPanel(): void')
    expect(viewSource).toContain('function submitComposerMessage(): Promise<void>')
    expect(viewSource).toContain('function setReference(message: GroupMessage): void')
    expect(viewSource).toContain('function shouldShowMentionPanel(value: string): boolean')
    expect(viewSource).toContain('function insertMention(role: GroupRole): void')
    expect(viewSource).toContain('function registerComposerEvents(): void')
    expect(entrySource).not.toContain('function renderComposerState(): void')
    expect(entrySource).not.toContain('function renderReferenceDraft(): void')
    expect(entrySource).not.toContain('function renderMentionPanel(): void')
    expect(entrySource).not.toContain('function submitComposerMessage(): Promise<void>')
    expect(entrySource).not.toContain('function setReference(message: GroupMessage): void')
    expect(entrySource).not.toContain('function shouldShowMentionPanel(value: string): boolean')
    expect(entrySource).not.toContain('function insertMention(role: GroupRole): void')
  })
})
