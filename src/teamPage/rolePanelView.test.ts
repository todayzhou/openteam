import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('team page role panel view boundary', () => {
  it('keeps role panel rendering and role site switching outside the entrypoint', () => {
    const entrySource = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')
    const viewSource = readFileSync(resolve(process.cwd(), 'src/teamPage/rolePanelView.ts'), 'utf8')

    expect(viewSource).toContain('function renderRolePanel(): void')
    expect(viewSource).toContain('function roleCard(role: GroupRole): HTMLElement')
    expect(viewSource).toContain('function roleSiteControl(role: GroupRole): HTMLElement')
    expect(viewSource).toContain('function roleSiteMenu(role: GroupRole): HTMLElement')
    expect(viewSource).toContain('function roleActionMenu(role: GroupRole): HTMLElement')
    expect(viewSource).toContain('function kickRoleFromChat(role: GroupRole): Promise<void>')
    expect(viewSource).toContain('function switchRoleSite(role: GroupRole, modelKey: string): Promise<void>')
    expect(viewSource).toContain('deps.state.roleActionMenuRoleId')
    expect(viewSource).toContain("kick.textContent = '删除成员'")
    expect(viewSource).toContain("ready: '在线'")
    expect(viewSource).not.toContain("ready: '就绪'")
    expect(viewSource).toContain('function roleContextProgress(role: GroupRole): HTMLElement')
    expect(viewSource).toContain("`已读 ${role.contextCursor} 条`")
    expect(viewSource).toContain("'连接 API'")
    expect(viewSource).toContain("'网页已连接'")
    expect(viewSource).not.toContain("'API 模型'")
    expect(viewSource).not.toContain('cursor ${role.contextCursor}')
    expect(viewSource).not.toContain("'已有会话'")
    expect(viewSource).not.toContain("'未绑定会话'")
    expect(viewSource).toContain("deps.runCommand('GROUP_ROLE_DELETE'")
    expect(roleSiteMenuSource(viewSource)).not.toContain('GROUP_ROLE_DELETE')
    expect(roleSiteMenuSource(viewSource)).not.toContain('删除成员')
    expect(entrySource).not.toContain('function renderRolePanel(): void')
    expect(entrySource).not.toContain('function roleCard(role: GroupRole): HTMLElement')
    expect(entrySource).not.toContain('function roleSiteControl(role: GroupRole): HTMLElement')
    expect(entrySource).not.toContain('function roleSiteMenu(role: GroupRole): HTMLElement')
    expect(entrySource).not.toContain('function roleActionMenu(role: GroupRole): HTMLElement')
    expect(entrySource).not.toContain('function kickRoleFromChat(role: GroupRole): Promise<void>')
    expect(entrySource).not.toContain('function switchRoleSite(role: GroupRole, chatSite: ChatSite): Promise<void>')
  })
})

function roleSiteMenuSource(source: string): string {
  const match = source.match(/function roleSiteMenu\(role: GroupRole\): HTMLElement \{(?<body>[\s\S]*?)\n  function roleActionMenu/)
  return match?.groups?.body ?? ''
}
