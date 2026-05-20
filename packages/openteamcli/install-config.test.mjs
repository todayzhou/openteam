import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = import.meta.dirname
const root = resolve(packageRoot, '../..')

describe('openteamcli install configuration', () => {
  it('keeps the extension project private and delegates publish metadata to the CLI package', () => {
    const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

    expect(rootPkg.private).toBe(true)
    expect(rootPkg.bin).toBeUndefined()
    expect(rootPkg.files).toBeUndefined()
    expect(rootPkg.scripts.openteamcli).toBe('node packages/openteamcli/openteamcli.mjs')
  })

  it('exposes openteamcli from a lightweight publishable package', () => {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))

    expect(pkg).toMatchObject({
      name: '@openteam/cli',
      version: expect.any(String),
      type: 'module',
      private: false,
      bin: {
        openteamcli: 'openteamcli.mjs',
      },
      engines: {
        node: '>=18',
      },
      publishConfig: {
        access: 'public',
      },
    })
    expect(pkg.files).toEqual(expect.arrayContaining([
      'openteamcli.mjs',
      'openteam-daemon.mjs',
      'skills',
    ]))
  })

  it('documents the installed openteamcli command in the skill', () => {
    const skill = readFileSync(resolve(packageRoot, 'skills/openteam-control/SKILL.md'), 'utf8')

    expect(skill).toContain('openteamcli daemon start')
    expect(skill).toContain('openteamcli doctor')
    expect(skill).not.toContain('npm run openteamcli --')
  })
})
