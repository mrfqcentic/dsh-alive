/** The voice preload exposes the typed bridges and no generic IPC passthrough. */
import { expect, it, vi } from 'vitest'
import type { VoiceModelsApi, VoicePanelApi } from '../src/voice-panel.ts'

const electron = vi.hoisted(() => {
  const exposed = new Map<string, unknown>()
  return {
    exposed,
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    exposeInMainWorld: vi.fn((name: string, api: unknown) => { exposed.set(name, api) }),
  }
})

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, off: electron.off },
}))

await import('../src/preload-voice.ts')

/** @param name - bridge global name. @returns the exposed bridge value. */
function bridge(name: string): unknown {
  const exposed = electron.exposed.get(name)
  if (exposed === undefined) throw new Error(`the preload exposed no ${name} bridge`)
  return exposed
}

const panel = (): VoicePanelApi => bridge('dshVoicePanel') as VoicePanelApi
const models = (): VoiceModelsApi => bridge('dshVoiceModels') as VoiceModelsApi

it('exposes the protocol version and opens a surface over the typed channel', async () => {
  expect(electron.exposeInMainWorld).toHaveBeenCalledWith('dshVoicePanel', expect.any(Object))
  expect(panel().protocolVersion).toBe(1)
  electron.invoke.mockResolvedValueOnce(undefined)
  await expect(panel().openSurface('history')).resolves.toBeUndefined()
  expect(electron.invoke).toHaveBeenCalledWith('dsh-voice:open-surface', 'history')
})

it('forwards state and subscriptions through the panel channel', async () => {
  const state = { visible: true, shortcutRegistered: false }
  electron.invoke.mockResolvedValueOnce(state)
  await expect(panel().state()).resolves.toEqual(state)
  expect(electron.invoke).toHaveBeenCalledWith('dsh-voice:panel-state')

  const listener = vi.fn()
  const stop = panel().subscribe(listener)
  const handler = electron.on.mock.calls.at(-1)![1] as (event: unknown, payload: typeof state) => void
  handler({}, state)
  expect(listener).toHaveBeenCalledWith(state)
  stop()
  expect(electron.off).toHaveBeenCalledWith('dsh-voice:panel-state', handler)
})

it('closes the sender window through the typed close channel', async () => {
  electron.invoke.mockResolvedValueOnce(undefined)
  await expect(panel().close()).resolves.toBeUndefined()
  expect(electron.invoke).toHaveBeenCalledWith('dsh-voice:close')
})

it('delivers mute toggles until the listener unsubscribes', async () => {
  const listener = vi.fn()
  const stop = panel().onToggleMute(listener)
  const handler = electron.on.mock.calls.at(-1)![1] as () => void
  expect(electron.on).toHaveBeenCalledWith('dsh-voice:toggle-mute', handler)
  handler()
  expect(listener).toHaveBeenCalledOnce()
  stop()
  expect(electron.off).toHaveBeenCalledWith('dsh-voice:toggle-mute', handler)
})

it('exposes the model bridge with its own protocol version', () => {
  expect(models().protocolVersion).toBe(1)
})

it('reads the model state over the model channel', async () => {
  const snapshot = { rows: [], readiness: { ready: false, asr: null, tts: null, failure: null } }
  electron.invoke.mockResolvedValueOnce(snapshot)
  await expect(models().state()).resolves.toEqual(snapshot)
  expect(electron.invoke).toHaveBeenCalledWith('dsh-voice:models-state')
})

it('watches the model stream only while the listener is attached', () => {
  const listener = vi.fn()
  const stop = models().subscribe(listener)

  const handler = electron.on.mock.calls.at(-1)![1] as (event: unknown, snapshot: unknown) => void
  expect(electron.on).toHaveBeenCalledWith('dsh-voice:models-event', handler)
  expect(electron.invoke).toHaveBeenCalledWith('dsh-voice:models-watch', true)

  const snapshot = { rows: [], readiness: { ready: true, asr: 'whisper-base', tts: 'kokoro', failure: null } }
  handler({}, snapshot)
  expect(listener).toHaveBeenCalledWith(snapshot)

  stop()
  expect(electron.off).toHaveBeenCalledWith('dsh-voice:models-event', handler)
  expect(electron.invoke).toHaveBeenCalledWith('dsh-voice:models-watch', false)
})

it('sends every model action over the action channel', async () => {
  electron.invoke.mockResolvedValue(undefined)
  await models().download('kokoro')
  expect(electron.invoke).toHaveBeenCalledWith('dsh-voice:models-action', { action: 'download', id: 'kokoro' })
  await models().cancel('kokoro')
  expect(electron.invoke).toHaveBeenCalledWith('dsh-voice:models-action', { action: 'cancel', id: 'kokoro' })
  await models().remove('kokoro')
  expect(electron.invoke).toHaveBeenCalledWith('dsh-voice:models-action', { action: 'remove', id: 'kokoro' })
  await models().activate('kokoro')
  expect(electron.invoke).toHaveBeenCalledWith('dsh-voice:models-action', { action: 'activate', id: 'kokoro' })
})
