export const teamPageLog = {
  debug(event: string, details?: Record<string, unknown>): void {
    console.debug('[OpenTeam][team-page]', event, details || {})
  },
  info(event: string, details?: Record<string, unknown>): void {
    console.info('[OpenTeam][team-page]', event, details || {})
  },
  warn(event: string, details?: Record<string, unknown>): void {
    console.warn('[OpenTeam][team-page]', event, details || {})
  },
}

export function createErrorPresenter(errorEl: HTMLElement): (message: string) => void {
  return message => {
    errorEl.textContent = message
    errorEl.hidden = false
    window.setTimeout(() => {
      errorEl.hidden = true
    }, 5200)
  }
}
