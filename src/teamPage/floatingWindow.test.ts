import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('team page floating window boundary', () => {
  it('keeps drag and minimize controls outside the entrypoint', () => {
    const entrySource = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')
    const viewSource = readFileSync(resolve(process.cwd(), 'src/teamPage/floatingWindow.ts'), 'utf8')

    expect(viewSource).toContain('function ensureShellPositioned(): DOMRect')
    expect(viewSource).toContain('function moveShellTo(left: number, top: number): void')
    expect(viewSource).toContain('function clampShellPosition(): void')
    expect(viewSource).toContain('function setWindowMinimized(minimized: boolean): void')
    expect(viewSource).toContain('function registerFloatingWindowControls(): void')
    expect(entrySource).not.toContain('function ensureShellPositioned(): DOMRect')
    expect(entrySource).not.toContain('function moveShellTo(left: number, top: number): void')
    expect(entrySource).not.toContain('function clampShellPosition(): void')
    expect(entrySource).not.toContain('function registerFloatingWindowControls(): void')
  })
})
