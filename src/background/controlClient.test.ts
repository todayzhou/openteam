import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENTEAM_CONTROL_DEFAULT_PORT, OPENTEAM_CONTROL_PROTOCOL_VERSION } from '../control/protocol'
import { createDefaultStore } from '../group/store'
import { createControlClient } from './controlClient'

describe('background control client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not connect while local agent control is disabled', async () => {
    const sockets: FakeWebSocket[] = []
    vi.stubGlobal('WebSocket', fakeWebSocketClass(sockets))
    const store = createDefaultStore()
    store.settings.agentControlEnabled = false

    const client = createControlClient({
      loadStore: async () => store,
      executeCommand: vi.fn(),
      getExtensionVersion: () => '1.0.0',
      getProfileId: () => 'profile-test',
      log: testLog(),
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    })

    await client.sync()

    expect(sockets).toHaveLength(0)
  })

  it('connects to the configured daemon port and answers commands', async () => {
    const sockets: FakeWebSocket[] = []
    vi.stubGlobal('WebSocket', fakeWebSocketClass(sockets))
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    store.settings.agentControlPort = 19999
    const executeCommand = vi.fn(async () => ({ id: 'cmd-1', ok: true, data: { pong: true } }))
    const client = createControlClient({
      loadStore: async () => store,
      executeCommand,
      getExtensionVersion: () => '1.0.0',
      getProfileId: () => 'profile-test',
      log: testLog(),
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    })

    await client.sync()
    sockets[0].open()
    sockets[0].receive(JSON.stringify({ type: 'command', command: { id: 'cmd-1', action: 'store.get' } }))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sockets[0].url).toBe('ws://127.0.0.1:19999/ext?profileId=profile-test')
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({
      type: 'hello',
      extensionVersion: '1.0.0',
      protocolVersion: OPENTEAM_CONTROL_PROTOCOL_VERSION,
      profileId: 'profile-test',
    })
    expect(JSON.parse(sockets[0].sent[1])).toEqual({
      type: 'result',
      result: { id: 'cmd-1', ok: true, data: { pong: true } },
    })
  })

  it('uses the default port when settings do not override it', async () => {
    const sockets: FakeWebSocket[] = []
    vi.stubGlobal('WebSocket', fakeWebSocketClass(sockets))
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    const client = createControlClient({
      loadStore: async () => store,
      executeCommand: vi.fn(),
      getExtensionVersion: () => '1.0.0',
      getProfileId: () => 'profile-test',
      log: testLog(),
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    })

    await client.sync()

    expect(sockets[0].url).toBe(`ws://127.0.0.1:${OPENTEAM_CONTROL_DEFAULT_PORT}/ext?profileId=profile-test`)
  })
})

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1

  readonly url: string
  sent: string[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  receive(data: string): void {
    this.onmessage?.({ data })
  }
}

function fakeWebSocketClass(sockets: FakeWebSocket[]): typeof FakeWebSocket {
  return class extends FakeWebSocket {
    constructor(url: string) {
      super(url)
      sockets.push(this)
    }
  }
}

function testLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }
}
