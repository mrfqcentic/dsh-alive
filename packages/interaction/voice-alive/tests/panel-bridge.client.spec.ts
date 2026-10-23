// @vitest-environment jsdom
/** Panel bridge: per-method feature detection and no-op degradation. */
import { afterEach, expect, it, vi } from 'vitest'
import {
  createPanelBridge,
  PANEL_PROTOCOL_VERSION,
  panelBridge,
  type PanelVisibility,
  type VoicePanelBridgeApi,
} from '../src/client/panel/bridge.ts'

const VISIBLE: PanelVisibility = { visible: true, shortcutRegistered: true }

afterEach(() => {
  delete window.dshVoicePanel
  vi.restoreAllMocks()
})

it('degrades to no-ops without a shell bridge', async () => {
  const bridge = createPanelBridge(() => undefined)
  expect(bridge.supported).toBe(false)
  await expect(bridge.state()).resolves.toEqual({ visible: true, shortcutRegistered: false })
  const stopVisibility = bridge.subscribe(() => { throw new Error('unreachable') })
  stopVisibility()
  const stopToggle = bridge.onToggleMute(() => { throw new Error('unreachable') })
  stopToggle()
  await expect(bridge.openSurface('settings')).resolves.toBeUndefined()
  await expect(bridge.close()).resolves.toBeUndefined()
})

it('ignores a bridge that speaks another protocol version', async () => {
  const state = vi.fn(async () => VISIBLE)
  const bridge = createPanelBridge(() => ({ protocolVersion: PANEL_PROTOCOL_VERSION + 1, state }))
  expect(bridge.supported).toBe(false)
  await expect(bridge.state()).resolves.toEqual({ visible: true, shortcutRegistered: false })
  expect(state).not.toHaveBeenCalled()
})

it('forwards every method the shell provides', async () => {
  let visibilityListener: ((state: PanelVisibility) => void) | undefined
  let toggleListener: (() => void) | undefined
  const offVisibility = vi.fn()
  const offToggle = vi.fn()
  const openSurface = vi.fn(async () => {})
  const close = vi.fn(async () => {})
  const api: VoicePanelBridgeApi = {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    state: async () => VISIBLE,
    subscribe(listener) {
      visibilityListener = listener
      return offVisibility
    },
    openSurface,
    close,
    onToggleMute(listener) {
      toggleListener = listener
      return offToggle
    },
  }
  const bridge = createPanelBridge(() => api)
  expect(bridge.supported).toBe(true)

  await expect(bridge.state()).resolves.toEqual(VISIBLE)

  const received = vi.fn()
  const stopVisibility = bridge.subscribe(received)
  expect(visibilityListener).toBe(received)
  visibilityListener?.(VISIBLE)
  expect(received).toHaveBeenCalledWith(VISIBLE)
  expect(stopVisibility).toBe(offVisibility)

  const toggled = vi.fn()
  const stopToggle = bridge.onToggleMute(toggled)
  expect(toggleListener).toBe(toggled)
  toggleListener?.()
  expect(toggled).toHaveBeenCalledTimes(1)
  expect(stopToggle).toBe(offToggle)

  await bridge.openSurface('history')
  await bridge.close()
  expect(openSurface).toHaveBeenCalledWith('history')
  expect(close).toHaveBeenCalledTimes(1)
})

it('keeps working when only some methods exist', async () => {
  const bridge = createPanelBridge(() => ({
    protocolVersion: PANEL_PROTOCOL_VERSION,
    state: async () => VISIBLE,
  }))
  expect(bridge.supported).toBe(true)
  await expect(bridge.state()).resolves.toEqual(VISIBLE)
  expect(bridge.subscribe(() => {})).toBeTypeOf('function')
  expect(bridge.onToggleMute(() => {})).toBeTypeOf('function')
  await expect(bridge.openSurface('settings')).resolves.toBeUndefined()
  await expect(bridge.close()).resolves.toBeUndefined()
})

it('falls back when a shell call rejects', async () => {
  const bridge = createPanelBridge(() => ({
    protocolVersion: PANEL_PROTOCOL_VERSION,
    state: async () => { throw new Error('panel window gone') },
    openSurface: async () => { throw new Error('no window') },
    close: async () => { throw new Error('no window') },
  }))
  await expect(bridge.state()).resolves.toEqual({ visible: true, shortcutRegistered: false })
  await expect(bridge.openSurface('settings')).resolves.toBeUndefined()
  await expect(bridge.close()).resolves.toBeUndefined()
})

it('reads the shared bridge from window.dshVoicePanel', async () => {
  expect(panelBridge.supported).toBe(false)
  const api: VoicePanelBridgeApi = {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    state: async () => VISIBLE,
  }
  window.dshVoicePanel = api
  expect(panelBridge.supported).toBe(true)
  await expect(panelBridge.state()).resolves.toEqual(VISIBLE)
})
