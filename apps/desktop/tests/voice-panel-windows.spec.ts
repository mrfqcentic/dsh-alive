/** The voice panel's surface windows: lifecycle, IPC ownership, and teardown. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const windows: Array<ReturnType<typeof createWindow>> = []
  const handlers = new Map<string, (event: unknown, value?: unknown) => unknown>()

  function createWindow(options: unknown) {
    const webContents = {
      mainFrame: {},
      setWindowOpenHandler: vi.fn((_handler: () => { action: string }) => {}),
      on: vi.fn(),
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
    }
    return {
      options,
      webContents,
      loadURL: vi.fn(() => Promise.resolve()),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
      moveTop: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
      destroy: vi.fn(),
      setPosition: vi.fn(),
      getBounds: vi.fn(() => ({ x: 100, y: 100, width: 320, height: 440 })),
      setVisibleOnAllWorkspaces: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
    }
  }

  const display = { workArea: { x: 0, y: 0, width: 1440, height: 900 } }
  return {
    windows,
    handlers,
    createWindow,
    BrowserWindow: vi.fn(function (options: unknown) {
      const window = createWindow(options)
      windows.push(window)
      return window
    }),
    app: { on: vi.fn(), off: vi.fn(), focus: vi.fn() },
    globalShortcut: { register: vi.fn((_accelerator: string, _callback: () => void) => true), unregister: vi.fn() },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, value?: unknown) => unknown) => {
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => { handlers.delete(channel) }),
    },
    screen: {
      getAllDisplays: vi.fn(() => [display]),
      getCursorScreenPoint: vi.fn(() => ({ x: 720, y: 450 })),
      getDisplayNearestPoint: vi.fn(() => display),
      getDisplayMatching: vi.fn(() => display),
      on: vi.fn(),
      off: vi.fn(),
    },
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  globalShortcut: electron.globalShortcut,
  ipcMain: electron.ipcMain,
  screen: electron.screen,
}))

const {
  createVoicePanel,
  VOICE_PANEL_URL,
  voiceSurfaceUrl,
} = await import('../src/voice-panel.ts')

const USER_DATA = mkdtempSync(join(tmpdir(), 'desktop-voice-surfaces-'))
const PANEL_STATE_CHANNEL = 'dsh-voice:panel-state'
const SURFACE_CHANNEL = 'dsh-voice:open-surface'
const CLOSE_CHANNEL = 'dsh-voice:close'
const TOGGLE_MUTE_CHANNEL = 'dsh-voice:toggle-mute'

afterEach(() => {
  vi.restoreAllMocks()
  electron.windows.length = 0
  electron.handlers.clear()
  vi.clearAllMocks()
  rmSync(USER_DATA, { recursive: true, force: true })
})

beforeEach(() => { vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin') })

function eventFor(window: ReturnType<typeof electron.createWindow>) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame }
}

function surfaceHandler(): (event: unknown, value?: unknown) => unknown {
  const handler = electron.handlers.get(SURFACE_CHANNEL)
  if (handler === undefined) throw new Error('the surface channel is not registered')
  return handler
}

function closeHandler(): (event: unknown) => unknown {
  const handler = electron.handlers.get(CLOSE_CHANNEL)
  if (handler === undefined) throw new Error('the close channel is not registered')
  return handler
}

function summonChord(): () => void {
  return electron.globalShortcut.register.mock.calls[0]![1]
}

function openSurface(voice: ReturnType<typeof createVoicePanel>, surface: 'settings' | 'history'): void {
  voice.openSurface(surface)
}

describe('desktop voice surface windows', () => {
  it('opens a sandboxed glass window above the panel at its fixed size', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    const panel = electron.windows[0]!
    electron.handlers.get(SURFACE_CHANNEL)!(eventFor(panel), 'settings')

    expect(electron.windows).toHaveLength(2)
    const surface = electron.windows[1]!
    expect(surface.options).toMatchObject({
      width: 520,
      height: 640,
      useContentSize: true,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    const options = surface.options as { webPreferences?: { preload?: string } }
    expect(options.webPreferences?.preload).toMatch(/preload-voice\.cjs$/u)
    expect(surface.options).toMatchObject({ x: 460, y: 130 })
    expect(surface.loadURL).toHaveBeenCalledWith('dsh-app://shell/voice/panel.html?surface=settings')
    expect(surface.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, expect.objectContaining({ visibleOnFullScreen: true }))
    expect(surface.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
    expect(surface.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' })
    voice.dispose()
  })

  it('builds each surface URL from the panel document and rejects other paths', () => {
    expect(voiceSurfaceUrl('history')).toBe(`${VOICE_PANEL_URL}?surface=history`)
    const voice = createVoicePanel(USER_DATA, () => false)
    const panel = electron.windows[0]!
    electron.handlers.get(SURFACE_CHANNEL)!(eventFor(panel), 'history')
    const surface = electron.windows[1]!
    const navigate = surface.webContents.on.mock.calls.find(([name]) => name === 'will-navigate')![1] as
      (event: { preventDefault(): void }, url: string) => void
    const event = { preventDefault: vi.fn() }
    navigate(event, `${VOICE_PANEL_URL}?surface=settings`)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    navigate(event, `${VOICE_PANEL_URL}?surface=history`)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    voice.dispose()
  })

  it('focuses an existing surface instead of opening a duplicate', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    openSurface(voice, 'history')
    const surface = electron.windows[1]!
    openSurface(voice, 'history')
    expect(electron.windows).toHaveLength(2)
    expect(electron.BrowserWindow).toHaveBeenCalledTimes(2)
    expect(surface.show).toHaveBeenCalledOnce()
    expect(surface.moveTop).toHaveBeenCalledOnce()
    expect(surface.focus).toHaveBeenCalledOnce()
    voice.dispose()
  })

  it('shows and raises the surface when its document is ready', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    openSurface(voice, 'settings')
    const surface = electron.windows[1]!
    const ready = surface.once.mock.calls.find(([name]) => name === 'ready-to-show')![1] as () => void
    ready()
    expect(surface.moveTop).toHaveBeenCalledOnce()
    expect(surface.show).toHaveBeenCalledOnce()
    expect(surface.focus).toHaveBeenCalledOnce()
    voice.dispose()
  })

  it('does not show a surface that was disposed while loading', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    openSurface(voice, 'settings')
    const surface = electron.windows[1]!
    const ready = surface.once.mock.calls.find(([name]) => name === 'ready-to-show')![1] as () => void
    voice.dispose()
    ready()
    expect(surface.show).not.toHaveBeenCalled()
  })

  it('leaves Escape to the surface renderer and keeps it for the panel', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    openSurface(voice, 'history')
    const panel = electron.windows[0]!
    const surface = electron.windows[1]!

    expect(surface.webContents.on.mock.calls.some(([name]) => name === 'before-input-event')).toBe(false)

    const key = panel.webContents.on.mock.calls.find(([name]) => name === 'before-input-event')![1] as
      (event: { preventDefault(): void }, input: { type: string; key: string }) => void
    const event = { preventDefault: vi.fn() }
    key(event, { type: 'keyDown', key: 'Escape' })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(panel.hide).toHaveBeenCalledOnce()
    voice.dispose()
  })

  it('closes only the surface window that asked to close', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    openSurface(voice, 'settings')
    openSurface(voice, 'history')
    const panel = electron.windows[0]!
    const settings = electron.windows[1]!
    const history = electron.windows[2]!

    closeHandler()(eventFor(history))
    expect(history.close).toHaveBeenCalledOnce()
    expect(settings.close).not.toHaveBeenCalled()
    expect(panel.close).not.toHaveBeenCalled()
    expect(panel.hide).not.toHaveBeenCalled()
    voice.dispose()
  })

  it('hides the panel instead of destroying it when the panel asks to close', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    const panel = electron.windows[0]!
    panel.isVisible.mockReturnValue(true)

    closeHandler()(eventFor(panel))
    expect(panel.hide).toHaveBeenCalledOnce()
    expect(panel.close).not.toHaveBeenCalled()
    expect(panel.destroy).not.toHaveBeenCalled()
    voice.dispose()
  })

  it('rejects close requests from unowned frames and after disposal', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    const panel = electron.windows[0]!
    const handler = closeHandler()
    expect(() => handler({ sender: {}, senderFrame: {} })).toThrow(/unowned frame/u)
    expect(() => handler({ sender: panel.webContents, senderFrame: {} })).toThrow(/unowned frame/u)
    voice.dispose()
    expect(() => handler(eventFor(panel))).toThrow(/unowned frame/u)
  })

  it('toggles mute on Option+Space while the panel is visible and keeps it visible', () => {
    createVoicePanel(USER_DATA, () => false)
    const panel = electron.windows[0]!
    panel.isVisible.mockReturnValue(true)

    summonChord()()
    expect(panel.webContents.send).toHaveBeenCalledWith(TOGGLE_MUTE_CHANNEL)
    expect(panel.hide).not.toHaveBeenCalled()
    expect(panel.show).not.toHaveBeenCalled()
  })

  it('shows and focuses the hidden panel on Option+Space without toggling mute', () => {
    createVoicePanel(USER_DATA, () => false)
    const panel = electron.windows[0]!

    summonChord()()
    expect(panel.show).toHaveBeenCalledOnce()
    expect(panel.focus).toHaveBeenCalledOnce()
    expect(panel.webContents.send).not.toHaveBeenCalled()
  })

  it('stops delivering mute toggles once the panel is destroyed', () => {
    createVoicePanel(USER_DATA, () => false)
    const panel = electron.windows[0]!
    panel.isVisible.mockReturnValue(true)
    panel.isDestroyed.mockReturnValue(true)

    summonChord()()
    expect(panel.webContents.send).not.toHaveBeenCalled()
  })

  it('frees a closed surface and ignores a stale close from an earlier window', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    openSurface(voice, 'settings')
    const first = electron.windows[1]!
    const closed = first.on.mock.calls.find(([name]) => name === 'closed')![1] as () => void
    closed()
    openSurface(voice, 'settings')
    expect(electron.windows).toHaveLength(3)
    const second = electron.windows[2]!
    closed()
    openSurface(voice, 'settings')
    expect(electron.windows).toHaveLength(3)
    expect(second.show).toHaveBeenCalledOnce()
    voice.dispose()
  })

  it('rejects surface requests from an unowned frame or with an unknown surface', () => {
    createVoicePanel(USER_DATA, () => false)
    const panel = electron.windows[0]!
    const handler = surfaceHandler()
    expect(() => handler({ sender: {}, senderFrame: {} }, 'settings')).toThrow(/unowned frame/u)
    expect(() => handler({ sender: panel.webContents, senderFrame: {} }, 'settings')).toThrow(/unowned frame/u)
    expect(() => handler(eventFor(panel), 'panel')).toThrow(/unknown surface/u)
    expect(() => handler(eventFor(panel), 42)).toThrow(/unknown surface/u)
    expect(() => handler(eventFor(panel), null)).toThrow(/unknown surface/u)
    expect(electron.windows).toHaveLength(1)
  })

  it('accepts a request from a surface main frame', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    openSurface(voice, 'settings')
    surfaceHandler()(eventFor(electron.windows[1]!), 'history')
    expect(electron.windows).toHaveLength(3)
    expect(electron.windows[2]!.loadURL).toHaveBeenCalledWith(`${VOICE_PANEL_URL}?surface=history`)
    voice.dispose()
  })

  it('keeps the state channel restricted to the panel main frame', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    openSurface(voice, 'settings')
    const state = electron.handlers.get(PANEL_STATE_CHANNEL)!
    expect(() => state(eventFor(electron.windows[1]!))).toThrow(/unowned frame/u)
    expect(state(eventFor(electron.windows[0]!))).toEqual({ visible: false, shortcutRegistered: true })
    voice.dispose()
  })

  it('ignores surface requests after disposal', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    const handler = surfaceHandler()
    voice.dispose()
    expect(() => handler(eventFor(electron.windows[0]!), 'settings')).toThrow(/unowned frame/u)
    openSurface(voice, 'settings')
    expect(electron.windows).toHaveLength(1)
  })

  it('destroys a surface whose document fails to load and clears its entry', async () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = Promise.withResolvers<undefined>()
    electron.BrowserWindow.mockImplementationOnce(function (options: unknown) {
      const window = electron.createWindow(options)
      window.loadURL.mockReturnValue(failure.promise)
      electron.windows.push(window)
      return window
    })
    openSurface(voice, 'settings')
    const failed = electron.windows[1]!
    failure.reject(new Error('missing surface document'))
    await vi.waitFor(() => { expect(failed.destroy).toHaveBeenCalledOnce() })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('?surface=settings did not load'), expect.any(Error))
    openSurface(voice, 'settings')
    expect(electron.windows).toHaveLength(3)
    voice.dispose()
  })

  it('tears down every window, channel, and listener on dispose', () => {
    const voice = createVoicePanel(USER_DATA, () => false)
    openSurface(voice, 'settings')
    openSurface(voice, 'history')
    const surfaces = electron.windows.slice(1)
    voice.dispose()
    for (const surface of surfaces) expect(surface.destroy).toHaveBeenCalledOnce()
    expect(electron.windows[0]!.destroy).toHaveBeenCalledOnce()
    expect(electron.handlers.size).toBe(0)
    expect(electron.globalShortcut.unregister).toHaveBeenCalledOnce()
    expect(electron.screen.off).toHaveBeenCalledTimes(2)
    expect(electron.app.off).toHaveBeenCalledOnce()
    voice.dispose()
    expect(electron.windows[0]!.destroy).toHaveBeenCalledOnce()
  })
})
