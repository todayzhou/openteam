export interface FloatingWindowDependencies {
  appShellEl: HTMLElement
  floatingDragHandleEl: HTMLElement
  toggleWindowSizeEl: HTMLButtonElement
  windowLauncherEl: HTMLButtonElement
}

export interface FloatingWindowControls {
  registerFloatingWindowControls(): void
  setWindowMinimized(minimized: boolean): void
}

export function createFloatingWindowControls(deps: FloatingWindowDependencies): FloatingWindowControls {
  function ensureShellPositioned(): DOMRect {
    const rect = deps.appShellEl.getBoundingClientRect()
    deps.appShellEl.style.left = `${rect.left}px`
    deps.appShellEl.style.top = `${rect.top}px`
    deps.appShellEl.style.transform = 'none'
    return rect
  }

  function moveShellTo(left: number, top: number): void {
    const margin = 8
    const rect = deps.appShellEl.getBoundingClientRect()
    const maxLeft = Math.max(margin, window.innerWidth - Math.min(rect.width, window.innerWidth - margin * 2) - margin)
    const maxTop = Math.max(margin, window.innerHeight - Math.min(rect.height, window.innerHeight - margin * 2) - margin)
    deps.appShellEl.style.left = `${Math.min(Math.max(margin, left), maxLeft)}px`
    deps.appShellEl.style.top = `${Math.min(Math.max(margin, top), maxTop)}px`
    deps.appShellEl.style.transform = 'none'
  }

  function clampShellPosition(): void {
    if (deps.appShellEl.style.transform !== 'none') return

    const rect = deps.appShellEl.getBoundingClientRect()
    moveShellTo(rect.left, rect.top)
  }

  function setWindowMinimized(minimized: boolean): void {
    if (!minimized && deps.appShellEl.style.transform !== 'none') ensureShellPositioned()
    deps.appShellEl.classList.toggle('minimized', minimized)
    deps.windowLauncherEl.hidden = !minimized
    deps.toggleWindowSizeEl.textContent = minimized ? '□' : '−'
    deps.toggleWindowSizeEl.setAttribute('aria-expanded', String(!minimized))
    if (!minimized) window.requestAnimationFrame(clampShellPosition)
  }

  function registerFloatingWindowControls(): void {
    let dragOffsetX = 0
    let dragOffsetY = 0
    let activePointerId: number | undefined

    deps.floatingDragHandleEl.addEventListener('pointerdown', event => {
      if (event.button !== 0) return

      const rect = ensureShellPositioned()
      dragOffsetX = event.clientX - rect.left
      dragOffsetY = event.clientY - rect.top
      activePointerId = event.pointerId
      deps.appShellEl.classList.add('dragging')
      deps.floatingDragHandleEl.setPointerCapture(event.pointerId)
      event.preventDefault()
    })

    deps.floatingDragHandleEl.addEventListener('pointermove', event => {
      if (activePointerId !== event.pointerId) return
      moveShellTo(event.clientX - dragOffsetX, event.clientY - dragOffsetY)
    })

    function stopDragging(event: PointerEvent): void {
      if (activePointerId !== event.pointerId) return
      activePointerId = undefined
      deps.appShellEl.classList.remove('dragging')
      if (deps.floatingDragHandleEl.hasPointerCapture(event.pointerId)) deps.floatingDragHandleEl.releasePointerCapture(event.pointerId)
    }

    deps.floatingDragHandleEl.addEventListener('pointerup', stopDragging)
    deps.floatingDragHandleEl.addEventListener('pointercancel', stopDragging)
    deps.toggleWindowSizeEl.addEventListener('click', () => setWindowMinimized(!deps.appShellEl.classList.contains('minimized')))
    deps.windowLauncherEl.addEventListener('click', () => setWindowMinimized(false))
    window.addEventListener('resize', clampShellPosition)
  }

  return { registerFloatingWindowControls, setWindowMinimized }
}
