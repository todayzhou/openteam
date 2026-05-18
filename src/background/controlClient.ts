import {
  OPENTEAM_CONTROL_CAPABILITIES,
  OPENTEAM_CONTROL_DEFAULT_PORT,
  OPENTEAM_CONTROL_PROTOCOL_VERSION,
  controlFailure,
  isRecord,
  type ControlHttpCommand,
  type ControlHttpResult,
  type DaemonControlMessage,
  type ExtensionControlMessage,
} from '../control/protocol'
import type { OpenTeamStore } from '../group/types'

export interface ControlClientDependencies {
  loadStore(): Promise<OpenTeamStore>
  executeCommand(command: ControlHttpCommand): Promise<ControlHttpResult>
  getExtensionVersion(): string
  getProfileId(): string
  log: {
    debug(event: string, details?: Record<string, unknown>): void
    info(event: string, details?: Record<string, unknown>): void
    warn(event: string, details?: Record<string, unknown>): void
  }
  setTimer(handler: () => void, ms: number): ReturnType<typeof globalThis.setTimeout>
  clearTimer(timerId: ReturnType<typeof globalThis.setTimeout>): void
}

export interface ControlClient {
  sync(): Promise<void>
  stop(): void
}

const RECONNECT_DELAY_MS = 2_000

export function createControlClient(deps: ControlClientDependencies): ControlClient {
  let socket: WebSocket | undefined
  let activeUrl: string | undefined
  let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  let shouldReconnect = false

  diagnostic('info', 'createControlClient:created', {
    profileId: safeCall(deps.getProfileId),
    extensionVersion: safeCall(deps.getExtensionVersion),
  })

  async function sync(): Promise<void> {
    diagnostic('info', 'sync:start', {
      hasSocket: Boolean(socket),
      activeUrl,
      socketReadyState: socket?.readyState,
      shouldReconnect,
    })
    const store = await deps.loadStore()
    diagnostic('info', 'sync:store-loaded', {
      agentControlEnabled: store.settings.agentControlEnabled,
      agentControlPort: store.settings.agentControlPort,
      defaultChatSite: store.settings.defaultChatSite,
    })
    if (!store.settings.agentControlEnabled) {
      shouldReconnect = false
      clearReconnect()
      closeSocket()
      diagnostic('info', 'sync:disabled', {
        reason: 'store.settings.agentControlEnabled is false',
      })
      return
    }

    shouldReconnect = true
    const url = controlDaemonUrl(store, deps.getProfileId())
    diagnostic('info', 'sync:enabled', { url })
    if (socket && activeUrl === url && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      diagnostic('info', 'sync:reuse-existing-socket', { url, readyState: socket.readyState })
      return
    }
    closeSocket()
    connect(url)
  }

  function stop(): void {
    diagnostic('warn', 'stop', { activeUrl, readyState: socket?.readyState })
    shouldReconnect = false
    clearReconnect()
    closeSocket()
  }

  function connect(url: string): void {
    activeUrl = url
    diagnostic('info', 'connect:attempt', { url })
    try {
      socket = new WebSocket(url)
    } catch (error) {
      diagnostic('warn', 'connect:constructor-failed', {
        url,
        error: error instanceof Error ? error.message : String(error),
      })
      deps.log.warn('control-client:constructor-failed', { url, error: error instanceof Error ? error.message : String(error) })
      scheduleReconnect()
      return
    }
    deps.log.info('control-client:connect', { url })
    diagnostic('info', 'connect:socket-created', { url, readyState: socket.readyState })

    socket.onopen = () => {
      deps.log.info('control-client:connected', { url })
      diagnostic('info', 'socket:open', { url, readyState: socket?.readyState })
      send({
        type: 'hello',
        extensionVersion: deps.getExtensionVersion(),
        protocolVersion: OPENTEAM_CONTROL_PROTOCOL_VERSION,
        profileId: deps.getProfileId(),
        capabilities: [...OPENTEAM_CONTROL_CAPABILITIES],
      })
    }
    socket.onmessage = event => {
      diagnostic('info', 'socket:message', {
        url,
        dataType: typeof event.data,
        dataLength: typeof event.data === 'string' ? event.data.length : undefined,
      })
      handleSocketMessage(event.data).catch(error => {
        diagnostic('warn', 'socket:message-failed', {
          url,
          error: error instanceof Error ? error.message : String(error),
        })
        deps.log.warn('control-client:message-failed', { error: error instanceof Error ? error.message : String(error) })
      })
    }
    socket.onerror = event => {
      diagnostic('warn', 'socket:error', {
        url,
        readyState: socket?.readyState,
        eventType: event.type,
      })
      deps.log.warn('control-client:error', { url })
    }
    socket.onclose = event => {
      diagnostic('warn', 'socket:close', {
        url,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        shouldReconnect,
      })
      deps.log.warn('control-client:closed', { url })
      socket = undefined
      if (shouldReconnect) scheduleReconnect()
    }
  }

  async function handleSocketMessage(data: unknown): Promise<void> {
    const message = parseDaemonMessage(data)
    if (!message) {
      diagnostic('warn', 'daemon-message:ignored', { dataType: typeof data })
      return
    }
    diagnostic('info', 'daemon-message:command', {
      id: message.command.id,
      action: message.command.action,
      timeoutMs: message.command.timeoutMs,
    })
    const result = await deps.executeCommand(message.command)
    diagnostic(result.ok ? 'info' : 'warn', 'daemon-message:result', {
      id: result.id,
      ok: result.ok,
      errorCode: result.error?.code,
    })
    send({ type: 'result', result })
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== undefined) {
      diagnostic('info', 'reconnect:already-scheduled')
      return
    }
    diagnostic('warn', 'reconnect:scheduled', { delayMs: RECONNECT_DELAY_MS, activeUrl })
    reconnectTimer = deps.setTimer(() => {
      reconnectTimer = undefined
      diagnostic('info', 'reconnect:tick', { activeUrl })
      sync().catch(error => deps.log.warn('control-client:reconnect-failed', { error: error instanceof Error ? error.message : String(error) }))
    }, RECONNECT_DELAY_MS)
  }

  function clearReconnect(): void {
    if (reconnectTimer === undefined) return
    deps.clearTimer(reconnectTimer)
    reconnectTimer = undefined
    diagnostic('info', 'reconnect:cleared')
  }

  function closeSocket(): void {
    const current = socket
    socket = undefined
    if (!current) return
    diagnostic('warn', 'socket:close-requested', { activeUrl, readyState: current.readyState })
    current.onclose = null
    current.close()
  }

  function send(message: ExtensionControlMessage): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      diagnostic('warn', 'socket:send-skipped', {
        messageType: message.type,
        hasSocket: Boolean(socket),
        readyState: socket?.readyState,
      })
      return
    }
    diagnostic('info', 'socket:send', {
      messageType: message.type,
      resultId: message.type === 'result' ? message.result.id : undefined,
      ok: message.type === 'result' ? message.result.ok : undefined,
    })
    socket.send(JSON.stringify(message))
  }

  return { sync, stop }
}

function controlDaemonUrl(store: OpenTeamStore, profileId: string): string {
  const port = typeof store.settings.agentControlPort === 'number' && Number.isFinite(store.settings.agentControlPort)
    ? store.settings.agentControlPort
    : OPENTEAM_CONTROL_DEFAULT_PORT
  return `ws://127.0.0.1:${port}/ext?profileId=${encodeURIComponent(profileId)}`
}

function parseDaemonMessage(data: unknown): DaemonControlMessage | undefined {
  const parsed = typeof data === 'string' ? JSON.parse(data) as unknown : data
  if (!isRecord(parsed) || parsed.type !== 'command' || !isRecord(parsed.command)) return undefined
  const id = typeof parsed.command.id === 'string' ? parsed.command.id : ''
  const action = typeof parsed.command.action === 'string' ? parsed.command.action : ''
  if (!id || !action) {
    return {
      type: 'command',
      command: { id: id || 'invalid-command', action: 'invalid' },
    }
  }
  return {
    type: 'command',
    command: {
      id,
      action,
      payload: parsed.command.payload,
      timeoutMs: typeof parsed.command.timeoutMs === 'number' ? parsed.command.timeoutMs : undefined,
      profileId: typeof parsed.command.profileId === 'string' ? parsed.command.profileId : undefined,
    },
  }
}

export function invalidControlCommandResult(id: string): ControlHttpResult {
  return controlFailure(id, 'invalid_request', '控制命令格式无效。', { recoverable: false })
}

function diagnostic(level: 'info' | 'warn', event: string, details: Record<string, unknown> = {}): void {
  const payload = {
    at: new Date().toISOString(),
    ...details,
  }
  console[level](`[OpenTeam][control] ${event}`, payload)
}

function safeCall(read: () => string): string {
  try {
    return read()
  } catch (error) {
    return `unavailable:${error instanceof Error ? error.message : String(error)}`
  }
}
