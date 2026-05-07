// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupChat, GroupRole } from '../group/types'
import { createTeamPageState } from './appState'
import { createComposerView, type ComposerViewDependencies } from './composerView'

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

describe('team page composer targeting', () => {
  it('offers an all-members mention option when the mention panel opens', () => {
    const { view, deps } = createComposerHarness()
    deps.messageInputEl.value = '@'

    view.renderComposerState()

    const options = [...deps.mentionPanelEl.querySelectorAll<HTMLButtonElement>('.mention-option')]
    expect(deps.mentionPanelEl.hidden).toBe(false)
    expect(options.map(option => option.querySelector('.mention-name')?.textContent)).toEqual(['所有人', '工程师'])
    expect(options.map(option => option.querySelector('.mention-site-badge')?.textContent)).toEqual(['全员', 'Gemini'])

    options[0].click()

    expect(deps.messageInputEl.value).toBe('@所有人 ')
    deps.messageInputEl.value = '@所有人 请一起看'
    view.renderComposerState()
    expect(deps.targetPreviewEl.textContent).toBe('将发送给：工程师（Gemini）')
  })

  it('previews no-mention messages as chat records without requiring ready roles', () => {
    const { view, deps } = createComposerHarness({ roleStatus: 'thinking' })
    deps.messageInputEl.value = '先记录这个背景'

    view.renderComposerState()

    expect(deps.targetPreviewEl.textContent).toBe('将作为群消息记录，不触发 AI')
    expect(deps.sendButtonEl.disabled).toBe(false)
  })

  it('submits no-mention messages without reconnecting or blocking on thinking roles', async () => {
    const { view, deps, runCommand, reconnectRolesForSend, showError } = createComposerHarness({ roleStatus: 'thinking' })
    deps.messageInputEl.value = '先记录这个背景'

    await view.submitComposerMessage()

    expect(showError).not.toHaveBeenCalled()
    expect(reconnectRolesForSend).not.toHaveBeenCalled()
    expect(runCommand).toHaveBeenCalledWith('GROUP_MESSAGE_SEND', {
      chatId: 'chat-1',
      raw: '先记录这个背景',
      reference: undefined,
    })
  })
})

function createComposerHarness(options: { roleStatus?: GroupRole['status'] } = {}) {
  const store = createDefaultStore()
  const chat: GroupChat = {
    id: 'chat-1',
    name: '讨论',
    mode: 'independent',
    roleIds: ['role-1'],
    messageIds: [],
    nextMessageSeq: 1,
    status: 'ready',
    createdAt: 0,
    updatedAt: 0,
  }
  const role: GroupRole = {
    id: 'role-1',
    chatId: chat.id,
    name: '工程师',
    systemPrompt: '从工程角度分析',
    status: options.roleStatus ?? 'ready',
    contextCursor: 0,
    createdAt: 0,
    updatedAt: 0,
  }
  store.currentChatId = chat.id
  store.chatOrder = [chat.id]
  store.chatsById[chat.id] = chat
  store.rolesById[role.id] = role

  const state = createTeamPageState()
  state.store = store
  const runCommand = vi.fn(async () => undefined)
  const reconnectRolesForSend = vi.fn(async () => undefined)
  const showError = vi.fn()
  const deps: ComposerViewDependencies = {
    state,
    composerFormEl: document.createElement('form'),
    targetPreviewEl: document.createElement('div'),
    busyPreviewEl: document.createElement('div'),
    sendButtonEl: document.createElement('button'),
    messageInputEl: document.createElement('textarea'),
    referenceDraftEl: document.createElement('div'),
    mentionPanelEl: document.createElement('div'),
    getStore: () => store,
    getCurrentChat: () => chat,
    getCurrentRoles: () => [role],
    roleToneClass: () => 'tone-test',
    roleAvatarLabel: () => '工',
    reconnectRolesForSend,
    runCommand,
    showError,
  }

  return {
    view: createComposerView(deps),
    deps,
    runCommand,
    reconnectRolesForSend,
    showError,
  }
}
