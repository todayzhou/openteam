// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { GroupChat, RoomMode } from '../group/types'
import { createTeamPageState } from './appState'
import { createChatHeaderView } from './chatHeaderView'

describe('chat header view', () => {
  it('only shows orchestration for collaborative chats', () => {
    const harness = createHarness('collaborative')

    harness.view.renderChatHeader()

    expect(harness.openOrchestrationEl.hidden).toBe(false)

    harness.chat.mode = 'independent'
    harness.view.renderChatHeader()

    expect(harness.openOrchestrationEl.hidden).toBe(true)
  })
})

function createHarness(mode: RoomMode) {
  const chat: GroupChat = {
    id: 'chat-1',
    name: '群聊',
    mode,
    roleIds: [],
    messageIds: [],
    nextMessageSeq: 1,
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  }
  const chatTitleEl = document.createElement('h2')
  const chatSubtitleEl = document.createElement('p')
  const chatStatusEl = document.createElement('span')
  const togglePeopleDrawerEl = document.createElement('button')
  const openOrchestrationEl = document.createElement('button')
  const view = createChatHeaderView({
    state: createTeamPageState(),
    chatTitleEl,
    chatSubtitleEl,
    chatStatusEl,
    togglePeopleDrawerEl,
    openOrchestrationEl,
    getCurrentChat: () => chat,
    getCurrentRoles: () => [],
    getCurrentMessages: () => [],
  })
  return { chat, openOrchestrationEl, view }
}
