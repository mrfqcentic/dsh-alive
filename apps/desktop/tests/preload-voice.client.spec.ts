/** The voice preload exposes the typed bridge and no generic IPC passthrough. */
import { expect, it, vi } from 'vitest'
import type { VoicePanelApi } from '../src/voice-panel.ts'

const electron = vi.hoisted(() => {
  const exposed: { name?: string; api?: VoicePanelApi } = {}
  return {
    exposed,
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    exposeInMainWorld: vi.fn((name: string, api: VoicePanelApi) => { exposed.name = name; exposed.api = api }),
  }
})

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, off: electron.off },
}))

it('exposes the protocol version and opens a surface over the typed channel', async () => {
  await import('../src/preload-voice.ts')
  expect(electron.exposeInMainWorld).toHaveBeenCalledWith('dshVoicePanel', expect.any(Object))
  const api = electron.exposed.api
  if (api === undefined) throw new Error('the preload exposed no bridge')
  expect(api.protocolVersion).toBe(1)
  electron.invoke.mockResolvedValueOnce(undefined)
  await expect(api.openSurface('history')).resolves.toBeUndefined()
  expect(electron.invoke).toHaveBeenCalledWith('dsh-voice:open-surface', 'history')
})

it('forwards state and subscriptions through the panel channel', async () => {
  await import('../src/preload-voice.ts')
  const api = electron.exposed.api
  if (api === undefined) throw new Error('the preload exposed no bridge')
  const state = { visible: true, shortcutRegistered: false }
  electron.invoke.mockResolvedValueOnce(state)
  await expect(api.state()).resolves.toEqual(state)
  expect(electron.invoke).toHaveBeenCalledWith('dsh-voice:panel-state')

  const listener = vi.fn()
  const stop = api.subscribe(listener)
  const handler = electron.on.mock.calls.at(-1)![1] as (event: unknown, payload: typeof state) => void
  handler({}, state)
  expect(listener).toHaveBeenCalledWith(state)
  stop()
  expect(electron.off).toHaveBeenCalledWith('dsh-voice:panel-state', handler)
})
