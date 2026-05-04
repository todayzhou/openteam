// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

describe('team page dom refs', () => {
  it('collects required team page elements and fails clearly when a selector is missing', async () => {
    document.body.innerHTML = `
      <main id="app"><div id="iframe-host"></div></main>
      <button id="toggle-window-size"></button>
      <button id="toggle-fullscreen"></button>
      <section id="store-summary"></section>
      <section id="chat-list"></section>
      <h1 id="chat-title"></h1>
      <p id="chat-subtitle"></p>
      <div id="chat-status"></div>
      <section id="messages"></section>
      <div id="role-summary"></div>
      <section id="role-list"></section>
      <select id="role-template-select"></select>
      <section id="template-list"></section>
      <div id="target-preview"></div>
      <div id="busy-preview"></div>
      <form id="composer"></form>
      <button id="send-message"></button>
      <textarea id="message-input"></textarea>
      <div id="reference-draft"></div>
      <div id="mention-panel"></div>
      <div id="error"></div>
      <input id="new-chat-name" />
      <form id="create-chat-form"></form>
      <button id="quick-create-chat"></button>
      <input id="template-name" />
      <textarea id="template-description"></textarea>
      <textarea id="template-prompt"></textarea>
      <div id="template-form-title"></div>
      <button id="settings-button"></button>
      <div id="settings-menu"></div>
      <button id="open-people-library"></button>
      <button id="close-people-library"></button>
      <div id="people-library-modal"></div>
      <div id="person-template-modal"></div>
      <div id="add-person-modal"></div>
      <div id="temporary-person-modal"></div>
      <aside id="notes-panel"></aside>
      <div id="notes-drag-handle"></div>
      <button id="toggle-notes-panel"></button>
      <button id="close-notes-panel"></button>
      <button id="global-note-tab"></button>
      <button id="chat-note-tab"></button>
      <div id="notes-editor"></div>
      <button id="note-bold"></button>
      <button id="note-italic"></button>
      <button id="note-strike"></button>
      <button id="note-bullet-list"></button>
      <button id="note-ordered-list"></button>
      <button id="note-undo"></button>
      <button id="note-redo"></button>
      <div id="people-library-summary"></div>
      <div id="people-library-list"></div>
      <div id="people-library-pagination"></div>
      <div id="add-library-people-list"></div>
      <button id="new-template"></button>
      <button id="close-person-template"></button>
      <button id="close-add-person"></button>
      <button id="open-temporary-person"></button>
      <button id="close-temporary-person"></button>
      <form id="add-role-form"></form>
      <form id="add-library-people-form"></form>
      <form id="add-temporary-person-form"></form>
      <form id="people-library-form"></form>
      <input id="template-site-gemini" />
      <input id="template-site-chatgpt" />
      <input id="template-site-claude" />
      <input id="template-site-deepseek" />
      <input id="template-site-qwen" />
      <input id="template-site-kimi" />
      <div id="template-chatgpt-gpts-field"></div>
      <input id="template-chatgpt-gpts-url" />
      <input id="temporary-person-name" />
      <textarea id="temporary-person-description"></textarea>
      <textarea id="temporary-person-prompt"></textarea>
      <button id="toggle-people-drawer"></button>
      <aside class="role-panel"></aside>
      <button id="window-launcher"></button>
    `

    const { createTeamPageDomRefs, requireElement } = await import('./domRefs')
    const refs = createTeamPageDomRefs()

    expect(refs.appShellEl.id).toBe('app')
    expect(refs.toggleFullscreenEl.id).toBe('toggle-fullscreen')
    expect(refs.messageInputEl.tagName).toBe('TEXTAREA')
    expect(refs.rolePanelEl.className).toBe('role-panel')
    expect(() => requireElement('#missing')).toThrow('Missing element: #missing')
  })
})
