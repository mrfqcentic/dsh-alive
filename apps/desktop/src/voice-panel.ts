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
/** Surfaces the panel renderer may open in their own window. */
export const VOICE_SURFACE_IDS = ['settings', 'history'] as const
/** Identifier of a surface that opens in its own always-on-top window. */
export type VoiceSurfaceId = (typeof VOICE_SURFACE_IDS)[number]

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
  new URL('../../../packages/interaction/voice-alive/dist/panel', import.meta.url),
)

/** Fixed content size shared by the window options and the position math. */
const PANEL_CONTENT_SIZE = { width: 320, height: 440 } as const
/** Fixed content size of a settings or history window. */
const SURFACE_CONTENT_SIZE = { width: 520, height: 640 } as const
/** Channel shared by the panel bridge and the preload; both copies must stay in sync. */
const VOICE_PANEL_CHANNEL = 'dsh-voice:panel-state'
/** Channel the panel or a surface renderer uses to open a surface window. */
const VOICE_SURFACE_CHANNEL = 'dsh-voice:open-surface'
/** Channel a renderer uses to close its own window: surfaces close, the panel hides. */
const VOICE_CLOSE_CHANNEL = 'dsh-voice:close'
/** Channel the shell uses to tell the visible panel that the summon chord was pressed. */
const VOICE_TOGGLE_MUTE_CHANNEL = 'dsh-voice:toggle-mute'
/** Channel a renderer reads the Host model store through. */
const VOICE_MODELS_STATE_CHANNEL = 'dsh-voice:models-state'
/** Channel a renderer starts or stops observing the model store through. */
const VOICE_MODELS_WATCH_CHANNEL = 'dsh-voice:models-watch'
/** Channel a renderer sends one model action through. */
const VOICE_MODELS_ACTION_CHANNEL = 'dsh-voice:models-action'
/** Channel the shell pushes each model store change on. */
const VOICE_MODELS_EVENT_CHANNEL = 'dsh-voice:models-event'
/** Host routes the model bridge forwards to; they mirror the voice package's endpoint paths. */
const MODELS_SNAPSHOT_PATH = '/api/voice.models'
const MODELS_EVENTS_PATH = '/api/voice.models.events'
const MODELS_ACTION_PATH = '/api/voice.models.action'
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
  /**
   * Open the window for one surface, or focus it when it is already open.
   * @param surface - settings or history.
   * @returns a promise that resolves once the shell has handled the request.
   */
  openSurface(surface: VoiceSurfaceId): Promise<void>
  /**
   * Close this window. A surface window closes; the panel hides instead of being destroyed.
   * @returns a promise that resolves once the shell has handled the request.
   */
  close(): Promise<void>
  /**
   * Observe the summon chord while the panel is visible. The chord toggles mute and never hides.
   * @param listener - called once per chord press that toggles mute.
   * @returns function that stops observing.
   */
  onToggleMute(listener: () => void): () => void
}

/** One action the Models pane can send to the Host model store. */
export type VoiceModelsAction = 'download' | 'cancel' | 'remove' | 'activate'

/**
 * Typed bridge the sandboxed preload exposes as `window.dshVoiceModels`.
 *
 * The snapshot payload is forwarded as received; the Models pane validates it
 * across the process boundary, so this bridge keeps it opaque.
 */
export interface VoiceModelsApi {
  readonly protocolVersion: 1
  /** @returns the current model snapshot, or null when the Host serves no model store. */
  state(): Promise<unknown>
  /**
   * Observe every model store change the shell pushes.
   * @param listener - receives each pushed snapshot.
   * @returns function that stops observing and releases the Host stream.
   */
  subscribe(listener: (snapshot: unknown) => void): () => void
  /**
   * Download a catalog entry; progress and failures arrive as pushed snapshots.
   * @param id - catalog entry to download.
   * @returns settlement once the Host accepted the request.
   */
  download(id: string): Promise<void>
  /**
   * Cancel a running download.
   * @param id - catalog entry whose download should stop.
   * @returns settlement once the Host accepted the request.
   */
  cancel(id: string): Promise<void>
  /**
   * Remove one installed entry and its partial payload.
   * @param id - catalog entry to remove.
   * @returns settlement once the Host accepted the request.
   */
  remove(id: string): Promise<void>
  /**
   * Choose the entry readiness uses for its kind.
   * @param id - ready catalog entry to activate.
   * @returns settlement once the Host accepted the request.
   */
  activate(id: string): Promise<void>
}

/** Launch facts the shell needs to call the Host model routes. */
export interface VoiceModelsHost {
  /** Authenticated Host base URL the shell already forwards application requests to. */
  readonly url: string
  /** Authority-bound browser cookie the shell holds for that Host. */
  readonly cookie: string
}

/** @returns the Host facts, or undefined while the Host is unavailable. */
export type VoiceModelsHostReader = () => VoiceModelsHost | undefined

/** Shell-owned controls of the single panel window and its surface windows. */
export interface VoicePanel {
  /** Show and focus the panel while hidden; while visible, ask the renderer to toggle mute. */
  toggle(): void
  /** Hide the panel without quitting; the Dock, tray, and primary window stay as they are. */
  hide(): void
  /**
   * Open the window for one surface, or focus it when it is already open.
   * @param surface - settings or history.
   */
  openSurface(surface: VoiceSurfaceId): void
  /** Unregister the chord, detach listeners and IPC, and destroy every voice window. */
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

/**
 * Document URL of one surface window: the panel document with its surface selection.
 * @param surface - settings or history.
 * @returns the `dsh-app://shell` URL that renders the selected surface.
 */
export function voiceSurfaceUrl(surface: VoiceSurfaceId): string {
  const url = new URL(VOICE_PANEL_URL)
  url.searchParams.set('surface', surface)
  return url.toString()
}

/**
 * Narrow a renderer payload to a surface that opens in its own window.
 * @param value - value received over IPC.
 * @returns whether the value names a surface window.
 */
function isVoiceSurfaceId(value: unknown): value is VoiceSurfaceId {
  return value === 'settings' || value === 'history'
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

/** @returns a surface window's renderer preferences: the panel's sandbox and preload at window size. */
function voiceSurfaceWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    ...voicePanelWindowOptions(preload),
    ...SURFACE_CONTENT_SIZE,
  }
}

/**
 * Keep a voice window above full-screen spaces and above normal application windows.
 * @param target - the panel or surface window to configure.
 */
function applyTopmost(target: BrowserWindow): void {
  if (process.platform === 'darwin') {
    // Full-screen spaces keep a normal always-on-top window behind them; the chord must reach it.
    target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    target.setAlwaysOnTop(true, 'floating')
  } else if (process.platform === 'win32') {
    target.setVisibleOnAllWorkspaces(true)
  }
}

/** @param value - decoded renderer value. @returns whether it names a model action. */
function isVoiceModelsAction(value: unknown): value is VoiceModelsAction {
  return value === 'download' || value === 'cancel' || value === 'remove' || value === 'activate'
}

/**
 * Decode one renderer action payload.
 * @param value - value received over IPC.
 * @returns the action and catalog id, or undefined when the payload is malformed.
 */
export function decodeVoiceModelsAction(value: unknown): { readonly action: VoiceModelsAction; readonly id: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { action, id } = value as Record<string, unknown>
  if (!isVoiceModelsAction(action) || typeof id !== 'string' || id === '') return undefined
  return { action, id }
}

/**
 * Read the typed failure of one refused model action.
 * @param value - decoded response body.
 * @returns `code: message` from the Host, or undefined when the body carries no failure.
 */
export function modelActionFailure(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const failure = (value as Record<string, unknown>).failure
  if (typeof failure !== 'object' || failure === null || Array.isArray(failure)) return undefined
  const { code, message } = failure as Record<string, unknown>
  if (typeof code !== 'string' || typeof message !== 'string') return undefined
  return `${code}: ${message}`
}

/**
 * Decode the JSON payloads of one server-sent event frame.
 * @param frame - one complete `data:` frame without its blank-line terminator.
 * @returns the decoded snapshot values in the frame; a malformed payload is dropped.
 */
export function decodeModelEventFrame(frame: string): readonly unknown[] {
  const payloads: unknown[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      payloads.push(JSON.parse(line.slice('data: '.length)))
    } catch {
      // The line is not JSON, so it carries no snapshot; dropping it keeps the last pushed state.
    }
  }
  return payloads
}

/**
 * Forward one Host model event stream until the request ends or the caller aborts.
 *
 * The Host route emits one snapshot per store change, so the shell holds the
 * stream only while a renderer is watching and never polls.
 * @param host - Host facts the shell authenticates with.
 * @param onSnapshot - receives every decoded snapshot.
 * @param signal - aborts the request and releases the Host stream.
 * @returns settlement once the stream ends or is aborted.
 */
export async function pumpVoiceModelEvents(
  host: VoiceModelsHost,
  onSnapshot: (snapshot: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(new URL(MODELS_EVENTS_PATH, host.url), {
    headers: { cookie: host.cookie },
    signal,
  })
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    return
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        for (const snapshot of decodeModelEventFrame(buffer.slice(0, boundary))) onSnapshot(snapshot)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    // The shell aborts the request when the last watcher leaves; that is the intended end, not a failure.
    if (signal.aborted) return
    throw error
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
 * @param modelsHost - Host facts the model bridge forwards to; omitted by tests and by a window
 * whose Host never became ready.
 * @returns the show/hide and teardown controls.
 */
export function createVoicePanel(
  userData: string,
  isQuitting: () => boolean,
  modelsHost: VoiceModelsHostReader = () => undefined,
): VoicePanel {
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
  const preload = fileURLToPath(new URL('./preload-voice.cjs', import.meta.url))
  const window = new BrowserWindow({
    ...voicePanelWindowOptions(preload),
    ...initial,
  })
  applyTopmost(window)
  let disposed = false
  let shortcutRegistered = false
  let saveTimer: NodeJS.Timeout | undefined
  const surfaces = new Map<VoiceSurfaceId, BrowserWindow>()
  /** Renderers currently watching the model store, with their subscription depth. */
  const modelWatchers = new Map<Electron.WebContents, number>()
  let modelStream: AbortController | undefined

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

  /** Tell the visible panel's renderer that the chord toggled mute; a destroyed window gets nothing. */
  const notifyToggleMute = (): void => {
    if (disposed || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(VOICE_TOGGLE_MUTE_CHANNEL)
  }

  const toggle = (): void => {
    if (disposed || window.isDestroyed()) return
    // The chord mutes; Escape hides. A hidden panel is summoned by the same chord.
    if (window.isVisible()) notifyToggleMute()
    else show()
  }

  /** @returns where a surface window opens: centred on the panel's display. */
  const surfacePosition = (): { x: number; y: number } => {
    const area = screen.getDisplayMatching(window.getBounds()).workArea
    return {
      x: Math.round(area.x + (area.width - SURFACE_CONTENT_SIZE.width) / 2),
      y: Math.round(area.y + (area.height - SURFACE_CONTENT_SIZE.height) / 2),
    }
  }

  /** Close one surface window; its `closed` listener releases the map entry. */
  const closeSurface = (surface: VoiceSurfaceId): void => {
    const target = surfaces.get(surface)
    if (target === undefined || target.isDestroyed()) return
    target.close()
  }

  /**
   * Open one surface window, or raise the existing one. Closing a surface never
   * quits the application; only `dispose` or the renderer's Escape destroys it.
   */
  const openSurface = (surface: VoiceSurfaceId): void => {
    if (disposed) return
    const existing = surfaces.get(surface)
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.show()
      existing.moveTop()
      existing.focus()
      return
    }
    const surfaceWindow = new BrowserWindow({
      ...voiceSurfaceWindowOptions(preload),
      ...surfacePosition(),
    })
    surfaces.set(surface, surfaceWindow)
    applyTopmost(surfaceWindow)
    const url = voiceSurfaceUrl(surface)
    surfaceWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    surfaceWindow.webContents.on('will-navigate', (event, target) => {
      if (target !== url) event.preventDefault()
    })
    // The surface renderer owns Escape: history cancels the delete dialog, clears search, then
    // asks this shell to close the window through `window.dshVoicePanel.close()`.
    surfaceWindow.on('closed', () => {
      if (surfaces.get(surface) === surfaceWindow) surfaces.delete(surface)
      // A closed surface releases its model subscription with its renderer.
      modelWatchers.delete(surfaceWindow.webContents)
      syncModelStream()
    })
    surfaceWindow.once('ready-to-show', () => {
      if (disposed || surfaceWindow.isDestroyed()) return
      // Opening after the panel puts the surface above it at the same always-on-top level.
      surfaceWindow.moveTop()
      surfaceWindow.show()
      surfaceWindow.focus()
    })
    void surfaceWindow.loadURL(url).catch((error: unknown) => {
      if (surfaces.get(surface) === surfaceWindow) surfaces.delete(surface)
      if (!surfaceWindow.isDestroyed()) surfaceWindow.destroy()
      if (disposed) return
      console.warn(`desktop voice panel: ${url} did not load`, error)
    })
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

  /**
   * Hold the Host event stream exactly while at least one renderer watches it.
   *
   * A pane that unmounts, a surface that closes, or the last watcher leaving
   * aborts the request, so a hidden or closed surface never keeps the Host
   * streaming model state.
   */
  const syncModelStream = (): void => {
    if (disposed || modelWatchers.size === 0) {
      modelStream?.abort()
      modelStream = undefined
      return
    }
    if (modelStream !== undefined) return
    const host = modelsHost()
    if (host === undefined) return
    const controller = new AbortController()
    modelStream = controller
    const forward = (snapshot: unknown): void => {
      for (const contents of modelWatchers.keys()) {
        if (contents.isDestroyed()) continue
        contents.send(VOICE_MODELS_EVENT_CHANNEL, snapshot)
      }
    }
    void pumpVoiceModelEvents(host, forward, controller.signal)
      .catch((error: unknown) => {
        // A failed stream is a lost connection, not a broken pane; the next subscription retries it.
        console.warn('desktop voice panel: model event stream ended', error)
      })
      .finally(() => {
        if (modelStream === controller) modelStream = undefined
      })
  }

  /**
   * Apply one renderer's watch request.
   * @param contents - renderer that asked to watch or stop watching.
   * @param watching - true to add one subscription, false to release one.
   */
  const setModelWatching = (contents: Electron.WebContents, watching: boolean): void => {
    const depth = modelWatchers.get(contents) ?? 0
    if (watching) modelWatchers.set(contents, depth + 1)
    else if (depth > 1) modelWatchers.set(contents, depth - 1)
    else modelWatchers.delete(contents)
    syncModelStream()
  }

  /**
   * Read the Host model snapshot for one renderer.
   * @returns the snapshot payload, or null when the Host serves no model store.
   */
  const readModels = async (): Promise<unknown> => {
    const host = modelsHost()
    if (host === undefined) return null
    const response = await fetch(new URL(MODELS_SNAPSHOT_PATH, host.url), { headers: { cookie: host.cookie } })
    if (!response.ok) {
      await response.body?.cancel()
      return null
    }
    return response.json().catch(() => null)
  }

  /**
   * Forward one model action to the Host.
   * @param action - validated action and catalog id.
   * @returns settlement once the Host accepted the request.
   * @throws when the Host is unavailable or refused the action.
   */
  const sendModelAction = async (action: { readonly action: VoiceModelsAction; readonly id: string }): Promise<void> => {
    const host = modelsHost()
    if (host === undefined) throw new Error('desktop voice panel: the Host is unavailable')
    const response = await fetch(new URL(MODELS_ACTION_PATH, host.url), {
      method: 'POST',
      headers: { cookie: host.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(action),
    })
    if (response.ok) {
      await response.body?.cancel()
      return
    }
    const result: unknown = await response.json().catch(() => null)
    const failure = modelActionFailure(result)
    throw new Error(failure ?? `desktop voice panel: the Host refused the ${action.action} request`)
  }

  /** @returns whether the request came from the main frame of the panel or one of its surfaces. */
  const isOwnedFrame = (event: IpcMainInvokeEvent): boolean => {
    if (event.senderFrame !== event.sender.mainFrame) return false
    if (event.sender === window.webContents) return true
    for (const surfaceWindow of surfaces.values()) {
      if (surfaceWindow.webContents === event.sender) return true
    }
    return false
  }
  ipcMain.handle(VOICE_MODELS_STATE_CHANNEL, async (event: IpcMainInvokeEvent) => {
    if (disposed || !isOwnedFrame(event)) {
      throw new Error('desktop voice panel: rejected model state request from an unowned frame')
    }
    return readModels()
  })
  ipcMain.handle(VOICE_MODELS_WATCH_CHANNEL, (event: IpcMainInvokeEvent, watching: unknown) => {
    if (disposed || !isOwnedFrame(event)) {
      throw new Error('desktop voice panel: rejected model watch request from an unowned frame')
    }
    setModelWatching(event.sender, watching === true)
  })
  ipcMain.handle(VOICE_MODELS_ACTION_CHANNEL, async (event: IpcMainInvokeEvent, request: unknown) => {
    if (disposed || !isOwnedFrame(event)) {
      throw new Error('desktop voice panel: rejected model action from an unowned frame')
    }
    const action = decodeVoiceModelsAction(request)
    if (action === undefined) throw new Error('desktop voice panel: rejected a malformed model action')
    await sendModelAction(action)
  })
  ipcMain.handle(VOICE_PANEL_CHANNEL, (event: IpcMainInvokeEvent) => {
    if (disposed || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('desktop voice panel: rejected state request from an unowned frame')
    }
    return state()
  })
  ipcMain.handle(VOICE_SURFACE_CHANNEL, (event: IpcMainInvokeEvent, surface: unknown) => {
    if (disposed || !isOwnedFrame(event)) {
      throw new Error('desktop voice panel: rejected surface request from an unowned frame')
    }
    if (!isVoiceSurfaceId(surface)) throw new Error('desktop voice panel: rejected unknown surface')
    openSurface(surface)
  })
  ipcMain.handle(VOICE_CLOSE_CHANNEL, (event: IpcMainInvokeEvent) => {
    if (disposed || !isOwnedFrame(event)) {
      throw new Error('desktop voice panel: rejected close request from an unowned frame')
    }
    if (event.sender === window.webContents) {
      // Closing the panel hides it; a renderer never destroys the window that keeps the app alive.
      hide()
      return
    }
    for (const [surface, surfaceWindow] of surfaces) {
      if (surfaceWindow.webContents !== event.sender) continue
      closeSurface(surface)
      return
    }
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
    modelWatchers.clear()
    syncModelStream()
    ipcMain.removeHandler(VOICE_PANEL_CHANNEL)
    ipcMain.removeHandler(VOICE_SURFACE_CHANNEL)
    ipcMain.removeHandler(VOICE_CLOSE_CHANNEL)
    ipcMain.removeHandler(VOICE_MODELS_STATE_CHANNEL)
    ipcMain.removeHandler(VOICE_MODELS_WATCH_CHANNEL)
    ipcMain.removeHandler(VOICE_MODELS_ACTION_CHANNEL)
    for (const surfaceWindow of surfaces.values()) {
      if (!surfaceWindow.isDestroyed()) surfaceWindow.destroy()
    }
    surfaces.clear()
    if (!window.isDestroyed()) window.destroy()
  }
  app.on('will-quit', dispose)

  void window.loadURL(VOICE_PANEL_URL).catch((error: unknown) => {
    if (disposed || window.isDestroyed()) return
    // The panel document ships with the voice package; until it exists the window stays empty.
    console.warn(`desktop voice panel: ${VOICE_PANEL_URL} did not load`, error)
  })

  return { toggle, hide, openSurface, dispose }
}
