/**
 * Frameless always-on-top voice panel: its summon chord, window lifecycle, and renderer bridge.
 *
 * The shell owns this window; the panel document, its assets, and its Voice client come from the
 * `voice-alive` package through the `dsh-app://shell/voice/` route.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
  type Rectangle,
} from 'electron'
import { serveWebDocument } from './web-document.ts'

/** Document URL of the voice panel; every `/voice/` asset belongs to the same panel directory. */
export const VOICE_PANEL_URL = 'dsh-app://shell/voice/panel.html'
/** Global summon chord: Option+Space on macOS, Alt+Space elsewhere. */
export const VOICE_PANEL_ACCELERATOR = 'Alt+Space'
/** Path prefix the `dsh-app://shell` handler routes to the voice package instead of the Web shell. */
export const VOICE_PANEL_PATH_PREFIX = '/voice'

/**
 * Panel directory inside the packaged `dsh` project: the same `node_modules` layout the shell
 * resolves `@deepseek-ai/dsh-web-frontend/dist` from.
 */
const PACKAGED_PANEL_DIRECTORY = ['node_modules', '@deepseek-ai', 'dsh-voice-alive', 'dist', 'panel'] as const
/**
 * Panel directory inside the repository, used when the packaged layout is absent. This module sits
 * in `apps/desktop/{src,lib}`, so three parents reach the repository root.
 */
const REPOSITORY_PANEL_DIRECTORY = fileURLToPath(
  new URL('../../../packages/experimental/voice-alive/dist/panel', import.meta.url),
)

/** Fixed content size shared by the window options and the position math. */
const PANEL_CONTENT_SIZE = { width: 320, height: 440 } as const
/** Channel shared by the panel bridge and the preload; both copies must stay in sync. */
const VOICE_PANEL_CHANNEL = 'dsh-voice:panel-state'
/** Position file under Electron's `userData`, beside the shell's other device preferences. */
const POSITION_FILE = 'voice-panel.json'
/** Delay that merges a drag's repeated `moved` events into one write. */
const POSITION_SAVE_DELAY_MS = 300

/** Visibility and shortcut availability the panel renderer reads through its preload bridge. */
export interface VoicePanelState {
  /** Whether the panel window is currently shown. */
  readonly visible: boolean
  /** Whether the OS granted the summon chord, i.e. no other application owns it. */
  readonly shortcutRegistered: boolean
}

/**
 * Typed bridge the sandboxed preload exposes as `window.dshVoicePanel`.
 *
 * Panel renderers declare this contract locally instead of importing the shell module; keep the
 * member names and payload fields stable.
 */
export interface VoicePanelApi {
  readonly protocolVersion: 1
  /** @returns Current visibility and shortcut availability. */
  state(): Promise<VoicePanelState>
  /**
   * Observe visibility changes pushed by the shell.
   * @param listener - receives each new state.
   * @returns function that stops observing.
   */
  subscribe(listener: (state: VoicePanelState) => void): () => void
}

/** Shell-owned controls of the single panel window. */
export interface VoicePanel {
  /** Show and focus the panel, or hide it when it is already visible. */
  toggle(): void
  /** Hide the panel without quitting; the Dock, tray, and primary window stay as they are. */
  hide(): void
  /** Unregister the chord, detach listeners and IPC, and destroy the window. */
  dispose(): void
}

/**
 * Resolve the panel document directory for this launch.
 * @param dshDirectory - Packaged `dsh` project root, the same one the Web shell documents resolve from.
 * @param fallback - Repository-relative directory used when the packaged layout is absent.
 * @returns Absolute directory `serveVoicePanelDocument` serves `/voice/` requests from.
 */
export function resolveVoicePanelRoot(dshDirectory: string, fallback: string = REPOSITORY_PANEL_DIRECTORY): string {
  const packaged = join(dshDirectory, ...PACKAGED_PANEL_DIRECTORY)
  return existsSync(packaged) ? packaged : fallback
}

/**
 * Serve a `/voice/` document from the voice package's panel directory.
 *
 * `serveWebDocument` receives the pathname with the prefix removed, so `/voice/panel.html` maps to
 * `<root>/panel.html` and every relative asset URL stays below the same root. Its decode-and-resolve
 * check rejects paths that leave that root.
 * @param request - Request on the `dsh-app://shell` origin whose pathname starts with `/voice/`.
 * @param root - Panel document directory, normally from `resolveVoicePanelRoot`.
 * @returns Static response, or the missing/invalid path response from `serveWebDocument`.
 */
export function serveVoicePanelDocument(request: Request, root: string): Promise<Response> {
  const target = new URL(request.url)
  target.pathname = target.pathname.slice(VOICE_PANEL_PATH_PREFIX.length) || '/'
  return serveWebDocument(new Request(target, { method: request.method }), root)
}

/** @returns whether `value` is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns whether two rectangles overlap at all. */
function intersects(bounds: Rectangle, area: Rectangle): boolean {
  return bounds.x < area.x + area.width && area.x < bounds.x + bounds.width
    && bounds.y < area.y + area.height && area.y < bounds.y + bounds.height
}

/** @returns `bounds` moved just enough to sit inside `area`, keeping its size. */
function clampToArea(bounds: Rectangle, area: Rectangle): { x: number; y: number } {
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height),
  }
}

/** @returns the stored position, or `undefined` when the file is absent or invalid. */
function readStoredPosition(path: string): { x: number; y: number } | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`desktop voice panel: cannot read ${path}`, error)
    return undefined
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) return undefined
    const { x, y } = value
    return typeof x === 'number' && typeof y === 'number' && Number.isSafeInteger(x) && Number.isSafeInteger(y)
      ? { x, y } : undefined
  } catch (error) {
    // A corrupt position is a preference, not startup data; the panel still opens centred.
    console.warn(`desktop voice panel: ignoring stored position in ${path}`, error)
    return undefined
  }
}

/** Replace the stored position synchronously, so a quit cannot lose the last move. */
function storePosition(path: string, position: { x: number; y: number }): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, `${JSON.stringify(position)}\n`, { mode: 0o600 })
  } catch (error) {
    console.warn(`desktop voice panel: cannot store position in ${path}`, error)
  }
}

/** @returns the panel's renderer preferences: sandboxed, isolated, and no Node integration. */
function voicePanelWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    ...PANEL_CONTENT_SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: true,
    },
  }
}

/**
 * Create the process's sole voice panel and register its global summon chord.
 *
 * The returned controls are idempotent. Teardown on `will-quit` is registered here and removed by
 * `dispose`, so the shell wires the whole feature with one call.
 * @param userData - Electron's `userData` directory; the last window position is stored below it.
 * @param isQuitting - Whether the application is shutting down, read when the panel is closed. A
 * close during shutdown must not be prevented, because a prevented close cancels `app.quit()`.
 * @returns the show/hide and teardown controls.
 */
export function createVoicePanel(userData: string, isQuitting: () => boolean): VoicePanel {
  const positionPath = join(userData, 'desktop', POSITION_FILE)
  const stored = readStoredPosition(positionPath)
  const storedBounds: Rectangle | undefined = stored === undefined
    ? undefined : { ...stored, ...PANEL_CONTENT_SIZE }
  const visibleDisplays = screen.getAllDisplays()
  const onScreen = storedBounds !== undefined && visibleDisplays.some(display => intersects(storedBounds, display.workArea))
  const cursorArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const initial = onScreen && stored !== undefined ? stored : {
    x: Math.round(cursorArea.x + (cursorArea.width - PANEL_CONTENT_SIZE.width) / 2),
    y: Math.round(cursorArea.y + (cursorArea.height - PANEL_CONTENT_SIZE.height) / 2),
  }
  const window = new BrowserWindow({
    ...voicePanelWindowOptions(fileURLToPath(new URL('./preload-voice.cjs', import.meta.url))),
    ...initial,
  })
  if (process.platform === 'darwin') {
    // Full-screen spaces keep a normal always-on-top window behind them; the chord must reach it.
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    window.setAlwaysOnTop(true, 'floating')
  } else if (process.platform === 'win32') {
    window.setVisibleOnAllWorkspaces(true)
  }
  let disposed = false
  let shortcutRegistered = false
  let saveTimer: NodeJS.Timeout | undefined

  const state = (): VoicePanelState => ({
    visible: !window.isDestroyed() && window.isVisible(),
    shortcutRegistered,
  })
  const publish = (): void => {
    if (disposed || window.webContents.isDestroyed()) return
    window.webContents.send(VOICE_PANEL_CHANNEL, state())
  }

  /** Move the panel back inside the display it is nearest to after the display layout changes. */
  const keepOnScreen = (): void => {
    if (disposed || window.isDestroyed()) return
    const bounds = window.getBounds()
    const clamped = clampToArea(bounds, screen.getDisplayMatching(bounds).workArea)
    if (clamped.x !== bounds.x || clamped.y !== bounds.y) window.setPosition(clamped.x, clamped.y)
  }

  /** Merge a drag's repeated moves into one write. */
  const schedulePositionSave = (): void => {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      if (window.isDestroyed()) return
      const { x, y } = window.getBounds()
      storePosition(positionPath, { x, y })
    }, POSITION_SAVE_DELAY_MS)
  }

  const hide = (): void => {
    if (disposed || window.isDestroyed()) return
    if (saveTimer !== undefined) { clearTimeout(saveTimer); saveTimer = undefined }
    window.hide()
    // A hide that follows a drag stores the settled position without waiting for the timer.
    const { x, y } = window.getBounds()
    storePosition(positionPath, { x, y })
  }

  const show = (): void => {
    if (disposed || window.isDestroyed()) return
    keepOnScreen()
    // macOS keeps a background application behind the frontmost one unless it is activated.
    if (process.platform === 'darwin') app.focus({ steal: true })
    window.show()
    window.moveTop()
    window.focus()
  }

  const toggle = (): void => {
    if (window.isVisible()) hide()
    else show()
  }

  /** @returns whether this process owns the chord; reports every failure once and never throws. */
  const registerShortcut = (): boolean => {
    try {
      if (globalShortcut.register(VOICE_PANEL_ACCELERATOR, toggle)) return true
    } catch (error) {
      console.warn(`desktop voice panel: cannot register ${VOICE_PANEL_ACCELERATOR}`, error)
      return false
    }
    console.warn(`desktop voice panel: ${VOICE_PANEL_ACCELERATOR} is already taken; the panel has no keyboard summon`)
    return false
  }
  shortcutRegistered = registerShortcut()

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== VOICE_PANEL_URL) event.preventDefault()
  })
  // Escape works even while the panel document is missing or its renderer never boots.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault()
      hide()
    }
  })
  window.webContents.on('did-finish-load', publish)
  window.on('show', publish)
  window.on('hide', publish)
  window.on('moved', schedulePositionSave)
  window.on('close', (event) => {
    if (disposed) return
    if (isQuitting()) {
      // The window is about to be destroyed by the quit; keep its last position first.
      const { x, y } = window.getBounds()
      storePosition(positionPath, { x, y })
      return
    }
    // Closing the panel hides it; only quitting the application destroys it.
    event.preventDefault()
    hide()
  })

  ipcMain.handle(VOICE_PANEL_CHANNEL, (event: IpcMainInvokeEvent) => {
    if (disposed || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('desktop voice panel: rejected state request from an unowned frame')
    }
    return state()
  })
  screen.on('display-removed', keepOnScreen)
  screen.on('display-metrics-changed', keepOnScreen)

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    app.off('will-quit', dispose)
    screen.off('display-removed', keepOnScreen)
    screen.off('display-metrics-changed', keepOnScreen)
    if (saveTimer !== undefined) { clearTimeout(saveTimer); saveTimer = undefined }
    if (!window.isDestroyed()) {
      const { x, y } = window.getBounds()
      storePosition(positionPath, { x, y })
    }
    if (shortcutRegistered) globalShortcut.unregister(VOICE_PANEL_ACCELERATOR)
    ipcMain.removeHandler(VOICE_PANEL_CHANNEL)
    if (!window.isDestroyed()) window.destroy()
  }
  app.on('will-quit', dispose)

  void window.loadURL(VOICE_PANEL_URL).catch((error: unknown) => {
    if (disposed || window.isDestroyed()) return
    // The panel document ships with the voice package; until it exists the window stays empty.
    console.warn(`desktop voice panel: ${VOICE_PANEL_URL} did not load`, error)
  })

  return { toggle, hide, dispose }
}
