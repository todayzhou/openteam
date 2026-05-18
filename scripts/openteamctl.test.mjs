import { describe, expect, it } from 'vitest'
import { buildCliRequest } from './openteamctl.mjs'

describe('openteamctl command builder', () => {
  it('builds doctor and daemon commands', () => {
    expect(buildCliRequest(['doctor'])).toEqual({ kind: 'doctor' })
    expect(buildCliRequest(['daemon', 'status'])).toEqual({ kind: 'daemon-status' })
    expect(buildCliRequest(['daemon', 'stop'])).toEqual({ kind: 'daemon-stop' })
  })

  it('builds chat, role, task, and run control commands', () => {
    expect(buildCliRequest(['chat', 'list'])).toMatchObject({
      kind: 'command',
      command: { action: 'chat.list' },
    })
    expect(buildCliRequest(['chat', 'create', '--name', '评审群', '--mode', 'independent'])).toMatchObject({
      kind: 'command',
      command: { action: 'chat.create', payload: { name: '评审群', mode: 'independent' } },
    })
    expect(buildCliRequest(['role', 'batch-add', '--chat', 'chat-1', '--file', 'roles.json'])).toMatchObject({
      kind: 'file-command',
      action: 'roles.batchAdd',
      file: 'roles.json',
      decoratePayload: expect.any(Function),
    })
    expect(buildCliRequest(['task', 'post', '--chat', 'chat-1', '--target', 'all', '--content', '请评估'])).toMatchObject({
      kind: 'command',
      command: { action: 'task.post', payload: { chatId: 'chat-1', target: 'all', content: '请评估' } },
    })
    expect(buildCliRequest(['run', 'create-and-post', '--file', 'task.json', '--wait'])).toMatchObject({
      kind: 'file-command',
      action: 'run.createAndPost',
      file: 'task.json',
      wait: true,
    })
  })
})
