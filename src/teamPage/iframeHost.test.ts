// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIframeHost, FRAME_ASSIGN_MESSAGE, type FrameAssignmentMessage } from './iframeHost'
import type { GroupChat, GroupRole } from '../group/types'

function makeChat(id: string, roleIds: string[]): GroupChat {
  return {
    id,
    name: id,
    mode: 'independent',
    roleIds,
    messageIds: [],
    nextMessageSeq: 1,
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeRole(chatId: string, id: string, geminiConversationUrl?: string): GroupRole {
  return {
    id,
    chatId,
    name: id,
    status: 'pending',
    contextCursor: 0,
    geminiConversationUrl,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('IframeHost', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.replaceChildren()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates iframes for active chat roles and posts chat-scoped role assignment repeatedly', () => {
    const visibleHost = document.createElement('div')
    document.body.append(visibleHost)
    const host = createIframeHost({ visibleHost, assignIntervalMs: 50, hostTabId: 123 })

    host.activateChat(makeChat('chat-1', ['role-1']), [makeRole('chat-1', 'role-1')])

    const iframe = host.getRoleFrame('chat-1', 'role-1')
    expect(iframe).toBeInstanceOf(HTMLIFrameElement)
    expect(iframe?.parentElement).toBe(visibleHost)
    expect(iframe?.dataset.chatId).toBe('chat-1')
    expect(iframe?.dataset.roleId).toBe('role-1')
    expect(iframe?.src).toBe('https://gemini.google.com/')

    const postMessage = vi.spyOn(iframe!.contentWindow!, 'postMessage')
    vi.advanceTimersByTime(120)

    expect(postMessage).toHaveBeenCalled()
    const lastCall = postMessage.mock.calls[postMessage.mock.calls.length - 1]
    const message = lastCall?.[0] as FrameAssignmentMessage
    expect(message).toEqual({ type: FRAME_ASSIGN_MESSAGE, chatId: 'chat-1', roleId: 'role-1', hostTabId: 123 })
    expect(lastCall?.[1]).toBe('https://gemini.google.com')
    expect(host.getChatState('chat-1')[0].assignmentAttempts).toBeGreaterThan(1)
  })

  it('mounts all active chat role iframes in the visible host', () => {
    const visibleHost = document.createElement('div')
    document.body.append(visibleHost)
    const host = createIframeHost({ visibleHost })
    const chat = makeChat('chat-1', ['role-1', 'role-2'])

    host.activateChat(chat, [makeRole('chat-1', 'role-1'), makeRole('chat-1', 'role-2')])

    expect(host.getRoleFrame('chat-1', 'role-1')?.parentElement).toBe(visibleHost)
    expect(host.getRoleFrame('chat-1', 'role-2')?.parentElement).toBe(visibleHost)
    expect(visibleHost.querySelectorAll('iframe')).toHaveLength(2)
  })

  it('does not move active chat iframes through the hidden host on same-chat reactivation', () => {
    const visibleHost = document.createElement('div')
    const hiddenHost = document.createElement('div')
    document.body.append(visibleHost, hiddenHost)
    const appendHidden = vi.spyOn(hiddenHost, 'append')
    const host = createIframeHost({ visibleHost, hiddenHost })
    const chat = makeChat('chat-1', ['role-1'])

    host.activateChat(chat, [makeRole('chat-1', 'role-1')])
    const iframe = host.getRoleFrame('chat-1', 'role-1')
    host.activateChat(chat, [makeRole('chat-1', 'role-1')])

    expect(appendHidden).not.toHaveBeenCalled()
    expect(iframe?.parentElement).toBe(visibleHost)
  })

  it('updates host tab id used in role assignment messages', () => {
    const visibleHost = document.createElement('div')
    document.body.append(visibleHost)
    const host = createIframeHost({ visibleHost, assignIntervalMs: 50 })
    host.setHostTabId(456)
    host.activateChat(makeChat('chat-1', ['role-1']), [makeRole('chat-1', 'role-1')])
    const iframe = host.getRoleFrame('chat-1', 'role-1')!
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage')

    vi.advanceTimersByTime(60)

    const lastCall = postMessage.mock.calls[postMessage.mock.calls.length - 1]
    expect(lastCall?.[0]).toEqual({ type: FRAME_ASSIGN_MESSAGE, chatId: 'chat-1', roleId: 'role-1', hostTabId: 456 })
  })

  it('creates hidden host offscreen without display none so iframes can keep loading', () => {
    const visibleHost = document.createElement('div')
    document.body.append(visibleHost)
    createIframeHost({ visibleHost })

    const hiddenHost = document.querySelector<HTMLElement>('[data-openteam-iframe-hidden-host="true"]')
    expect(hiddenHost).toBeInstanceOf(HTMLElement)
    expect(hiddenHost?.hidden).toBe(false)
    expect(hiddenHost?.style.display).toBe('')
    expect(hiddenHost?.style.position).toBe('fixed')
    expect(hiddenHost?.style.left).toBe('-10000px')
  })

  it('keeps previously activated chat iframes alive in a hidden host when switching chats', () => {
    const visibleHost = document.createElement('div')
    const hiddenHost = document.createElement('div')
    document.body.append(visibleHost, hiddenHost)
    const host = createIframeHost({ visibleHost, hiddenHost })

    host.activateChat(makeChat('chat-1', ['role-1']), [makeRole('chat-1', 'role-1')])
    const chatOneFrame = host.getRoleFrame('chat-1', 'role-1')!
    host.activateChat(makeChat('chat-2', ['role-2']), [makeRole('chat-2', 'role-2')])

    expect(host.isChatActivated('chat-1')).toBe(true)
    expect(host.isChatActive('chat-1')).toBe(false)
    expect(host.isChatActive('chat-2')).toBe(true)
    expect(chatOneFrame.parentElement).toBe(hiddenHost)
    expect(host.getRoleFrame('chat-2', 'role-2')?.parentElement).toBe(visibleHost)
  })

  it('restores missing role iframes from safe Gemini URLs without activating inactive chats', () => {
    const visibleHost = document.createElement('div')
    const hiddenHost = document.createElement('div')
    document.body.append(visibleHost, hiddenHost)
    const host = createIframeHost({ visibleHost, hiddenHost })
    const chat = makeChat('chat-1', ['safe-role', 'unsafe-role'])

    const state = host.restoreChat(chat, [
      makeRole('chat-1', 'safe-role', 'https://gemini.google.com/app/abc'),
      makeRole('chat-1', 'unsafe-role', 'https://example.com/app/abc'),
    ])

    expect(host.isChatActivated('chat-1')).toBe(true)
    expect(host.isChatActive('chat-1')).toBe(false)
    expect(host.getRoleFrame('chat-1', 'safe-role')?.parentElement).toBe(hiddenHost)
    expect(host.getRoleFrame('chat-1', 'safe-role')?.src).toBe('https://gemini.google.com/app/abc')
    expect(host.getRoleFrame('chat-1', 'unsafe-role')?.src).toBe('https://gemini.google.com/')
    expect(state).toHaveLength(2)
  })

  it('recovers a single role by replacing only that role frame', () => {
    const visibleHost = document.createElement('div')
    document.body.append(visibleHost)
    const host = createIframeHost({ visibleHost })
    const chat = makeChat('chat-1', ['role-1', 'role-2'])
    host.activateChat(chat, [makeRole('chat-1', 'role-1'), makeRole('chat-1', 'role-2')])
    const oldRoleOneFrame = host.getRoleFrame('chat-1', 'role-1')
    const roleTwoFrame = host.getRoleFrame('chat-1', 'role-2')

    host.recoverRole(makeRole('chat-1', 'role-1', 'https://gemini.google.com/app/restored'))

    expect(host.getRoleFrame('chat-1', 'role-1')).not.toBe(oldRoleOneFrame)
    expect(host.getRoleFrame('chat-1', 'role-1')?.src).toBe('https://gemini.google.com/app/restored')
    expect(host.getRoleFrame('chat-1', 'role-2')).toBe(roleTwoFrame)
  })

  it('stops assignment loop when a role is marked ready', () => {
    const visibleHost = document.createElement('div')
    document.body.append(visibleHost)
    const host = createIframeHost({ visibleHost, assignIntervalMs: 50 })
    host.activateChat(makeChat('chat-1', ['role-1']), [makeRole('chat-1', 'role-1')])
    const iframe = host.getRoleFrame('chat-1', 'role-1')!
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage')

    vi.advanceTimersByTime(60)
    host.markRoleReady('chat-1', 'role-1')
    const callsAfterReady = postMessage.mock.calls.length
    vi.advanceTimersByTime(150)

    expect(postMessage).toHaveBeenCalled()
    expect(postMessage.mock.calls.length).toBe(callsAfterReady)
    expect(host.getChatState('chat-1')[0].status).toBe('assigned')
  })
})
