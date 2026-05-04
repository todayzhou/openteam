import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type { GroupChat, OpenTeamStore, RichNoteDocument } from '../group/types'
import type { TeamPageState } from './appState'

export type NoteScope = 'global' | 'chat'

export interface NoteEditorAdapter {
  setContent(content: RichNoteDocument): void
  getJSON(): RichNoteDocument
  insertText(text: string): void
  focus(): void
  destroy(): void
  runCommand(command: NoteToolbarCommand): void
}

export type NoteToolbarCommand = 'bold' | 'italic' | 'strike' | 'bulletList' | 'orderedList' | 'undo' | 'redo'

export type NoteEditorFactory = (options: { element: HTMLElement; content: RichNoteDocument; onUpdate(): void }) => NoteEditorAdapter

export interface NotesViewDependencies {
  state: TeamPageState
  notesPanelEl: HTMLElement
  notesDragHandleEl: HTMLElement
  toggleNotesPanelEl: HTMLButtonElement
  closeNotesPanelEl: HTMLButtonElement
  globalNoteTabEl: HTMLButtonElement
  chatNoteTabEl: HTMLButtonElement
  notesEditorEl: HTMLElement
  noteToolbarButtons: Record<NoteToolbarCommand, HTMLButtonElement>
  createEditor?: NoteEditorFactory
  getStore(): OpenTeamStore
  getCurrentChat(): GroupChat | undefined
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
}

export interface NotesView {
  renderNotes(): void
  registerNotesEvents(): void
  insertTextIntoActiveNote(text: string): void
  destroy(): void
}

const EMPTY_NOTE: RichNoteDocument = { type: 'doc', content: [{ type: 'paragraph' }] }
const FLOATING_PANEL_MARGIN = 12

export function createNotesView(deps: NotesViewDependencies): NotesView {
  const createEditor = deps.createEditor ?? createTiptapNoteEditor
  let editor: NoteEditorAdapter | undefined
  let loadedScope: NoteScope | undefined
  let loadedChatId: string | undefined
  let saveTimer: number | undefined
  let dragStart: { pointerId: number; startX: number; startY: number; startLeft: number; startTop: number } | undefined

  function renderNotes(): void {
    const chat = deps.getCurrentChat()
    if (!chat && deps.state.activeNoteScope === 'chat') deps.state.activeNoteScope = 'global'
    const scope = readAvailableScope(chat)

    deps.notesPanelEl.classList.toggle('open', deps.state.notesPanelOpen)
    deps.toggleNotesPanelEl.setAttribute('aria-expanded', String(deps.state.notesPanelOpen))
    if (deps.state.notesPanelOpen) clampFloatingPanelPosition()
    deps.globalNoteTabEl.classList.toggle('active', scope === 'global')
    deps.chatNoteTabEl.classList.toggle('active', scope === 'chat')
    deps.chatNoteTabEl.disabled = !chat

    ensureEditor()
    const nextChatId = scope === 'chat' ? chat?.id : undefined
    if (loadedScope !== scope || loadedChatId !== nextChatId) {
      loadedScope = scope
      loadedChatId = nextChatId
      editor?.setContent(readNoteContent(scope, nextChatId))
    }
  }

  function registerNotesEvents(): void {
    deps.toggleNotesPanelEl.addEventListener('click', () => {
      deps.state.notesPanelOpen = !deps.state.notesPanelOpen
      renderNotes()
      if (deps.state.notesPanelOpen) editor?.focus()
    })
    deps.closeNotesPanelEl.addEventListener('click', () => {
      deps.state.notesPanelOpen = false
      renderNotes()
    })
    deps.globalNoteTabEl.addEventListener('click', () => {
      deps.state.activeNoteScope = 'global'
      renderNotes()
    })
    deps.chatNoteTabEl.addEventListener('click', () => {
      if (!deps.getCurrentChat()) return
      deps.state.activeNoteScope = 'chat'
      renderNotes()
    })
    for (const [command, button] of Object.entries(deps.noteToolbarButtons) as Array<[NoteToolbarCommand, HTMLButtonElement]>) {
      button.addEventListener('click', () => editor?.runCommand(command))
    }
    deps.notesDragHandleEl.addEventListener('pointerdown', startDragging)
    window.addEventListener('pointermove', moveDraggingPanel)
    window.addEventListener('pointerup', stopDragging)
    window.addEventListener('pointercancel', stopDragging)
    window.addEventListener('resize', clampFloatingPanelPosition)
  }

  function insertTextIntoActiveNote(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    deps.state.notesPanelOpen = true
    renderNotes()
    editor?.insertText(trimmed)
    saveActiveNote()
  }

  function destroy(): void {
    if (saveTimer !== undefined) window.clearTimeout(saveTimer)
    deps.notesDragHandleEl.removeEventListener('pointerdown', startDragging)
    window.removeEventListener('pointermove', moveDraggingPanel)
    window.removeEventListener('pointerup', stopDragging)
    window.removeEventListener('pointercancel', stopDragging)
    window.removeEventListener('resize', clampFloatingPanelPosition)
    editor?.destroy()
  }

  function startDragging(event: PointerEvent): void {
    if (event.button !== 0) return
    const target = event.target as Element | null
    if (target?.closest('button, input, textarea, select, a, [role="button"]')) return

    const rect = deps.notesPanelEl.getBoundingClientRect()
    deps.notesPanelEl.style.left = `${rect.left}px`
    deps.notesPanelEl.style.top = `${rect.top}px`
    deps.notesPanelEl.style.right = 'auto'
    deps.notesPanelEl.style.bottom = 'auto'
    deps.notesPanelEl.classList.add('dragging')
    dragStart = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
    }
    deps.notesDragHandleEl.setPointerCapture?.(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
  }

  function moveDraggingPanel(event: PointerEvent): void {
    if (!dragStart || dragStart.pointerId !== event.pointerId) return
    const nextLeft = dragStart.startLeft + event.clientX - dragStart.startX
    const nextTop = dragStart.startTop + event.clientY - dragStart.startY
    moveFloatingPanelTo(nextLeft, nextTop)
  }

  function stopDragging(event: PointerEvent): void {
    if (!dragStart || dragStart.pointerId !== event.pointerId) return
    dragStart = undefined
    deps.notesPanelEl.classList.remove('dragging')
    if (deps.notesDragHandleEl.hasPointerCapture?.(event.pointerId)) deps.notesDragHandleEl.releasePointerCapture(event.pointerId)
  }

  function clampFloatingPanelPosition(): void {
    if (!deps.notesPanelEl.classList.contains('open')) return
    if (!deps.notesPanelEl.style.left || !deps.notesPanelEl.style.top) return
    const rect = deps.notesPanelEl.getBoundingClientRect()
    moveFloatingPanelTo(rect.left, rect.top)
  }

  function moveFloatingPanelTo(left: number, top: number): void {
    const rect = deps.notesPanelEl.getBoundingClientRect()
    const panelWidth = Math.min(rect.width, window.innerWidth - FLOATING_PANEL_MARGIN * 2)
    const panelHeight = Math.min(rect.height, window.innerHeight - FLOATING_PANEL_MARGIN * 2)
    const maxLeft = Math.max(FLOATING_PANEL_MARGIN, window.innerWidth - panelWidth - FLOATING_PANEL_MARGIN)
    const maxTop = Math.max(FLOATING_PANEL_MARGIN, window.innerHeight - panelHeight - FLOATING_PANEL_MARGIN)
    deps.notesPanelEl.style.left = `${Math.min(Math.max(FLOATING_PANEL_MARGIN, left), maxLeft)}px`
    deps.notesPanelEl.style.top = `${Math.min(Math.max(FLOATING_PANEL_MARGIN, top), maxTop)}px`
    deps.notesPanelEl.style.right = 'auto'
    deps.notesPanelEl.style.bottom = 'auto'
  }

  function ensureEditor(): void {
    if (editor) return
    editor = createEditor({
      element: deps.notesEditorEl,
      content: readNoteContent(readAvailableScope(deps.getCurrentChat()), deps.getCurrentChat()?.id),
      onUpdate: scheduleSaveActiveNote,
    })
  }

  function readAvailableScope(chat: GroupChat | undefined): NoteScope {
    return deps.state.activeNoteScope === 'chat' && chat ? 'chat' : 'global'
  }

  function readNoteContent(scope: NoteScope, chatId: string | undefined): RichNoteDocument {
    const store = deps.getStore()
    if (scope === 'chat' && chatId) return store.chatNotesById?.[chatId] ?? EMPTY_NOTE
    return store.globalNote ?? EMPTY_NOTE
  }

  function scheduleSaveActiveNote(): void {
    if (saveTimer !== undefined) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(saveActiveNote, 250)
  }

  function saveActiveNote(): void {
    if (!editor) return
    if (saveTimer !== undefined) {
      window.clearTimeout(saveTimer)
      saveTimer = undefined
    }
    const scope = loadedScope ?? readAvailableScope(deps.getCurrentChat())
    const chatId = scope === 'chat' ? loadedChatId ?? deps.getCurrentChat()?.id : undefined
    deps.runCommand('GROUP_NOTE_SAVE', {
      scope,
      ...(chatId ? { chatId } : {}),
      content: editor.getJSON(),
    }).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
  }

  return { renderNotes, registerNotesEvents, insertTextIntoActiveNote, destroy }
}

export function createTiptapNoteEditor(options: { element: HTMLElement; content: RichNoteDocument; onUpdate(): void }): NoteEditorAdapter {
  const editor = new Editor({
    element: options.element,
    extensions: [StarterKit],
    content: options.content,
    onUpdate: options.onUpdate,
  })

  return {
    setContent(content) {
      editor.commands.setContent(content, { emitUpdate: false })
    },
    getJSON() {
      return editor.getJSON()
    },
    insertText(text) {
      editor.chain().focus().insertContent(text).run()
    },
    focus() {
      editor.commands.focus()
    },
    destroy() {
      editor.destroy()
    },
    runCommand(command) {
      const chain = editor.chain().focus()
      if (command === 'bold') chain.toggleBold().run()
      if (command === 'italic') chain.toggleItalic().run()
      if (command === 'strike') chain.toggleStrike().run()
      if (command === 'bulletList') chain.toggleBulletList().run()
      if (command === 'orderedList') chain.toggleOrderedList().run()
      if (command === 'undo') chain.undo().run()
      if (command === 'redo') chain.redo().run()
    },
  }
}
