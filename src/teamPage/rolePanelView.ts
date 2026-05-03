import type { ChatSite, GroupRole, OpenTeamStore, RoleStatus } from '../group/types'
import type { TeamPageState } from './appState'

interface RolePanelIframeHost {
  recoverRole(role: GroupRole): void
}

export interface RolePanelViewDependencies {
  state: TeamPageState
  getStore(): OpenTeamStore
  rolePanelEl: HTMLElement
  roleSummaryEl: HTMLElement
  roleListEl: HTMLElement
  iframeHost: RolePanelIframeHost
  getCurrentChat(): unknown
  getCurrentRoles(): GroupRole[]
  emptyCard(title: string, body: string): HTMLElement
  roleToneClass(seed: string | undefined): string
  roleAvatarLabel(name: string | undefined): string
  insertMention(role: GroupRole): void
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
}

export interface RolePanelView {
  renderRolePanel(): void
}

export function createRolePanelView(deps: RolePanelViewDependencies): RolePanelView {
  function renderRolePanel(): void {
    const roles = deps.getCurrentRoles()
    const store = deps.getStore()
    const selectedRole = deps.state.selectedRoleId ? store.rolesById[deps.state.selectedRoleId] : undefined
    deps.rolePanelEl.classList.toggle('open', deps.state.peopleDrawerOpen)
    deps.roleSummaryEl.textContent = `${roles.length} 人员${selectedRole ? ` · 当前：${selectedRole.name}` : ''}`
    deps.roleListEl.replaceChildren()

    if (!deps.getCurrentChat()) {
      deps.roleListEl.append(deps.emptyCard('未选择群聊', '选择群聊后可添加、查看、恢复和唤醒人员。'))
    } else if (roles.length === 0) {
      deps.roleListEl.append(deps.emptyCard('暂无人员', '点击添加人员，可从人员库批量加入或临时添加。'))
    } else {
      for (const role of roles) deps.roleListEl.append(roleCard(role))
    }
  }

  function roleCard(role: GroupRole): HTMLElement {
    const card = document.createElement('section')
    card.className = `role-card${role.id === deps.state.selectedRoleId ? ' active' : ''}`
    card.addEventListener('click', () => {
      deps.state.selectedRoleId = role.id
      deps.state.roleSiteMenuRoleId = undefined
      renderRolePanel()
    })

    const avatar = document.createElement('div')
    avatar.className = `role-avatar ${deps.roleToneClass(role.name)}`
    avatar.textContent = deps.roleAvatarLabel(role.name)
    wireMentionShortcut(avatar, role)

    const main = document.createElement('div')
    main.className = 'role-card-main'

    const row = document.createElement('div')
    row.className = 'role-row'
    const name = document.createElement('div')
    name.className = 'role-name'
    name.textContent = role.name
    wireMentionShortcut(name, role)
    row.append(name, roleSiteBadge(role.chatSite), statusPill(role.status, roleStatusLabel(role.status)))

    const description = document.createElement('div')
    description.className = 'role-description'
    description.textContent = role.description || '未填写人员描述'

    const meta = document.createElement('div')
    meta.className = 'chat-row tiny role-meta'
    meta.append(roleSiteControl(role), textNode(`cursor ${role.contextCursor}`), textNode(role.geminiConversationUrl ? '已有会话' : '未绑定会话'))
    main.append(row, description, meta)

    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'role-more'
    more.setAttribute('aria-label', `切换 ${role.name} 的站点`)
    more.textContent = '···'
    more.addEventListener('click', event => {
      event.stopPropagation()
      deps.state.roleSiteMenuRoleId = deps.state.roleSiteMenuRoleId === role.id ? undefined : role.id
      renderRolePanel()
    })
    card.append(avatar, main, more)

    if (role.status === 'error') {
      const error = document.createElement('div')
      error.className = 'reference-box'
      error.textContent = '人员异常。若目标站点未登录，请打开登录页后点击恢复人员。'
      main.append(error)
    }
    return card
  }

  function roleSiteControl(role: GroupRole): HTMLElement {
    const control = document.createElement('div')
    control.className = 'role-site-control'
    const sitePill = document.createElement('button')
    sitePill.type = 'button'
    sitePill.className = `site-pill site-pill-${role.chatSite ?? 'gemini'}`
    sitePill.setAttribute('aria-expanded', String(deps.state.roleSiteMenuRoleId === role.id))
    sitePill.textContent = siteLabel(role.chatSite)
    sitePill.addEventListener('click', event => {
      event.stopPropagation()
      deps.state.roleSiteMenuRoleId = deps.state.roleSiteMenuRoleId === role.id ? undefined : role.id
      renderRolePanel()
    })
    control.append(sitePill)
    if (deps.state.roleSiteMenuRoleId === role.id) control.append(roleSiteMenu(role))
    return control
  }

  function roleSiteMenu(role: GroupRole): HTMLElement {
    const menu = document.createElement('div')
    menu.className = 'role-site-menu'
    menu.addEventListener('click', event => event.stopPropagation())
    for (const site of ['gemini', 'chatgpt', 'claude'] as const) {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = `role-site-option${role.chatSite === site ? ' active' : ''}`
      option.textContent = role.chatSite === site ? `✓ ${siteLabel(site)}` : siteLabel(site)
      option.addEventListener('click', () => {
        deps.state.roleSiteMenuRoleId = undefined
        if (role.chatSite === site) {
          renderRolePanel()
          return
        }
        switchRoleSite(role, site).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
      })
      menu.append(option)
    }
    return menu
  }

  async function switchRoleSite(role: GroupRole, chatSite: ChatSite): Promise<void> {
    if (role.chatSite === chatSite) return
    await deps.runCommand('GROUP_ROLE_UPDATE', { roleId: role.id, patch: { chatSite } })
    const updatedRole = deps.getStore().rolesById[role.id]
    if (!updatedRole) return
    deps.iframeHost.recoverRole(updatedRole)
    await deps.runCommand('GROUP_ROLE_RECOVER', { chatId: updatedRole.chatId, roleId: updatedRole.id })
  }

  return { renderRolePanel }

  function wireMentionShortcut(element: HTMLElement, role: GroupRole): void {
    element.classList.add('mention-shortcut')
    element.title = `@${role.name}`
    element.addEventListener('click', event => {
      event.stopPropagation()
      deps.insertMention(role)
    })
    element.addEventListener('contextmenu', event => {
      event.preventDefault()
      event.stopPropagation()
      deps.insertMention(role)
    })
  }
}

function siteLabel(site: ChatSite | undefined): string {
  if (site === 'chatgpt') return 'ChatGPT'
  if (site === 'claude') return 'Claude'
  return 'Gemini'
}

function roleSiteBadge(site: ChatSite | undefined): HTMLElement {
  const badge = document.createElement('span')
  badge.className = `role-site-badge site-pill-${site ?? 'gemini'}`
  badge.textContent = siteLabel(site)
  return badge
}

function statusPill(status: string, label: string): HTMLElement {
  const pill = document.createElement('span')
  pill.className = `status-pill status-${status}`
  pill.textContent = label
  return pill
}

function roleStatusLabel(status: RoleStatus): string {
  const labels: Record<RoleStatus, string> = {
    pending: '待唤醒',
    loading: '加载中',
    ready: '就绪',
    thinking: '回复中',
    error: '异常',
  }
  return labels[status]
}

function textNode(content: string): Text {
  return document.createTextNode(content)
}
