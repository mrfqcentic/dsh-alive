/** The shell's model bridge: Host forwarding, action relay, and the watch-scoped event stream. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const windows: Array<ReturnType<typeof createWindow>> = []
  const handlers = new Map<string, (event: unknown, value?: unknown) => unknown>()

  function createWindow(options: unknown) {
    const webContents = {
      mainFrame: {},
      setWindowOpenHandler: vi.fn(),
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
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
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
  decodeModelEventFrame,
  decodeVoiceModelsAction,
  modelActionFailure,
  pumpVoiceModelEvents,
} = await import('../src/voice-panel.ts')

const USER_DATA = mkdtempSync(join(tmpdir(), 'desktop-voice-models-'))
const STATE_CHANNEL = 'dsh-voice:models-state'
const WATCH_CHANNEL = 'dsh-voice:models-watch'
const ACTION_CHANNEL = 'dsh-voice:models-action'
const EVENT_CHANNEL = 'dsh-voice:models-event'
const HOST = { url: 'http://127.0.0.1:1234', cookie: 'dsh=browser' }
const SNAPSHOT = { rows: [], readiness: { ready: false, asr: null, tts: null, failure: null } }

/** One response the fake Host serves. */
type Served = Response | (() => Response)

/** Host URL, path, and request facts the fake fetch recorded. */
interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

const calls: Call[] = []
let serve: (url: string, init?: RequestInit) => Served = () => new Response('not found', { status: 404 })

/** Install the fake Host fetch. */
function stubFetch(): void {
  vi.stubGlobal('fetch', async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const value = serve(String(url), init)
    return typeof value === 'function' ? value() : value
  })
}

/** @param body - JSON payload. @returns one JSON response. */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

/**
 * Streaming event response whose frames the test pushes.
 * @returns the response, a frame publisher, and a closer.
 */
function eventStream(): { response: () => Response; push: (value: unknown) => void; close: () => void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const encoder = new TextEncoder()
  return {
    response: () => new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value },
    }), { headers: { 'content-type': 'text/event-stream' } }),
    push(value) { controller?.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)) },
    close() { controller?.close() },
  }
}

/** @param window - fake panel window. @returns the IPC event a renderer would send. */
function eventFor(window: ReturnType<typeof electron.createWindow>) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame }
}

/**
 * @param channel - IPC channel to invoke.
 * @returns the registered handler.
 */
function handler(channel: string): (event: unknown, value?: unknown) => unknown {
  const found = electron.handlers.get(channel)
  if (found === undefined) throw new Error(`the ${channel} channel is not registered`)
  return found
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  calls.length = 0
  serve = () => new Response('not found', { status: 404 })
  electron.windows.length = 0
  electron.handlers.clear()
  vi.clearAllMocks()
})

beforeEach(() => { vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin') })

afterAll(() => { rmSync(USER_DATA, { recursive: true, force: true }) })

describe('model bridge decoding', () => {
  it('decodes the four actions and rejects every other payload', () => {
    for (const action of ['download', 'cancel', 'remove', 'activate']) {
      expect(decodeVoiceModelsAction({ action, id: 'kokoro' })).toEqual({ action, id: 'kokoro' })
    }
    for (const value of [null, 'download', [], {}, { action: 'delete', id: 'kokoro' },
      { action: 'download' }, { action: 'download', id: '' }, { action: 'download', id: 4 }]) {
      expect(decodeVoiceModelsAction(value)).toBeUndefined()
    }
  })

  it('reads data lines of one event frame and ignores the rest', () => {
    expect(decodeModelEventFrame(`event: snapshot\ndata: ${JSON.stringify(SNAPSHOT)}\nid: 2`)).toEqual([SNAPSHOT])
    expect(decodeModelEventFrame('data: not json')).toEqual([])
    expect(decodeModelEventFrame('comment only')).toEqual([])
  })

  it('names the typed failure of a refused action', () => {
    expect(modelActionFailure({ ok: false, failure: { code: 'disk', message: 'no space' } }))
      .toBe('disk: no space')
    for (const value of [null, 'failure', [], { ok: true }, { failure: 'disk' }, { failure: { code: 'disk' } }]) {
      expect(modelActionFailure(value)).toBeUndefined()
    }
  })
})

describe('host event stream', () => {
  beforeEach(() => { stubFetch() })

  it('forwards each frame until the caller aborts', async () => {
    const stream = eventStream()
    serve = () => stream.response()
    const abort = new AbortController()
    const received: unknown[] = []
    const pumping = pumpVoiceModelEvents(HOST, (value) => { received.push(value) }, abort.signal)

    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    expect(calls[0]!.url).toBe('http://127.0.0.1:1234/api/voice.models.events')
    expect(calls[0]!.init).toMatchObject({ headers: { cookie: 'dsh=browser' } })

    stream.push(SNAPSHOT)
    await vi.waitFor(() => { expect(received).toEqual([SNAPSHOT]) })

    abort.abort()
    stream.close()
    await expect(pumping).resolves.toBeUndefined()
  })

  it('ends quietly when the Host refuses the stream', async () => {
    serve = () => new Response('forbidden', { status: 403 })
    await expect(pumpVoiceModelEvents(HOST, () => {}, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('surfaces a broken stream that the shell did not abort', async () => {
    serve = () => { throw new Error('socket closed') }
    await expect(pumpVoiceModelEvents(HOST, () => {}, new AbortController().signal))
      .rejects.toThrow('socket closed')
  })
})

describe('model IPC', () => {
  it('reads the snapshot with the Host cookie and reports an absent Host', async () => {
    stubFetch()
    serve = () => json(SNAPSHOT)
    const voice = createVoicePanel(USER_DATA, () => false, () => HOST)
    const panel = electron.windows[0]!

    await expect(handler(STATE_CHANNEL)(eventFor(panel))).resolves.toEqual(SNAPSHOT)
    expect(calls[0]!.url).toBe('http://127.0.0.1:1234/api/voice.models')
    expect(calls[0]!.init).toMatchObject({ headers: { cookie: 'dsh=browser' } })
    voice.dispose()
  })

  it('answers null when the Host serves no model store or is not ready', async () => {
    stubFetch()
    serve = () => new Response('missing', { status: 404 })
    const ready = createVoicePanel(USER_DATA, () => false, () => HOST)
    expect(await handler(STATE_CHANNEL)(eventFor(electron.windows[0]!))).toBeNull()
    ready.dispose()

    electron.windows.length = 0
    electron.handlers.clear()
    const waiting = createVoicePanel(USER_DATA, () => false)
    expect(await handler(STATE_CHANNEL)(eventFor(electron.windows[0]!))).toBeNull()
    waiting.dispose()
  })

  it('rejects a model request from an unowned frame', async () => {
    const voice = createVoicePanel(USER_DATA, () => false, () => HOST)
    const panel = electron.windows[0]!

    await expect(handler(STATE_CHANNEL)({ sender: panel.webContents, senderFrame: {} })).rejects.toThrow(/unowned frame/u)
    expect(() => handler(WATCH_CHANNEL)({ sender: {}, senderFrame: {} }, true)).toThrow(/unowned frame/u)
    await expect(handler(ACTION_CHANNEL)({ sender: {}, senderFrame: {} }, { action: 'download', id: 'kokoro' }))
      .rejects.toThrow(/unowned frame/u)
    voice.dispose()
  })

  it('relays one action as JSON and reports a refusal with the Host failure', async () => {
    stubFetch()
    serve = () => new Response(null, { status: 204 })
    const voice = createVoicePanel(USER_DATA, () => false, () => HOST)
    const panel = electron.windows[0]!

    await expect(handler(ACTION_CHANNEL)(eventFor(panel), { action: 'download', id: 'kokoro' })).resolves.toBeUndefined()
    expect(calls[0]!.url).toBe('http://127.0.0.1:1234/api/voice.models.action')
    expect(calls[0]!.init).toMatchObject({
      method: 'POST',
      headers: { cookie: 'dsh=browser', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'download', id: 'kokoro' }),
    })

    serve = () => new Response(JSON.stringify({ ok: false, failure: { code: 'disk', message: 'no space' } }), { status: 409 })
    await expect(handler(ACTION_CHANNEL)(eventFor(panel), { action: 'remove', id: 'kokoro' }))
      .rejects.toThrow('disk: no space')

    serve = () => new Response('bad gateway', { status: 502 })
    await expect(handler(ACTION_CHANNEL)(eventFor(panel), { action: 'remove', id: 'kokoro' }))
      .rejects.toThrow(/refused the remove request/u)
    voice.dispose()
  })

  it('rejects a malformed action and an action without a Host', async () => {
    stubFetch()
    const voice = createVoicePanel(USER_DATA, () => false, () => HOST)
    const panel = electron.windows[0]!
    await expect(handler(ACTION_CHANNEL)(eventFor(panel), { action: 'delete', id: 'kokoro' }))
      .rejects.toThrow(/malformed model action/u)
    voice.dispose()

    electron.windows.length = 0
    electron.handlers.clear()
    const waiting = createVoicePanel(USER_DATA, () => false, () => undefined)
    await expect(handler(ACTION_CHANNEL)(eventFor(electron.windows[0]!), { action: 'download', id: 'kokoro' }))
      .rejects.toThrow(/Host is unavailable/u)
    waiting.dispose()
  })

  it('holds one event stream while a renderer watches and releases it with the last watcher', async () => {
    const stream = eventStream()
    stubFetch()
    serve = url => url.endsWith('/api/voice.models.events') ? stream.response() : json(SNAPSHOT)
    const voice = createVoicePanel(USER_DATA, () => false, () => HOST)
    const panel = electron.windows[0]!

    handler(WATCH_CHANNEL)(eventFor(panel), true)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    stream.push(SNAPSHOT)
    await vi.waitFor(() => { expect(panel.webContents.send).toHaveBeenCalledWith(EVENT_CHANNEL, SNAPSHOT) })

    // A second subscription from the same renderer reuses the open stream.
    handler(WATCH_CHANNEL)(eventFor(panel), true)
    handler(WATCH_CHANNEL)(eventFor(panel), false)
    expect(calls).toHaveLength(1)

    const signal = calls[0]!.init?.signal
    handler(WATCH_CHANNEL)(eventFor(panel), false)
    expect(signal?.aborted).toBe(true)
    stream.close()
    voice.dispose()
  })

  it('releases a surface subscription when its window closes', async () => {
    const stream = eventStream()
    stubFetch()
    serve = url => url.endsWith('/api/voice.models.events') ? stream.response() : json(SNAPSHOT)
    const voice = createVoicePanel(USER_DATA, () => false, () => HOST)
    const panel = electron.windows[0]!
    handler('dsh-voice:open-surface')(eventFor(panel), 'settings')
    const surface = electron.windows[1]!

    handler(WATCH_CHANNEL)(eventFor(surface), true)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    const signal = calls[0]!.init?.signal
    const closed = surface.on.mock.calls.find(([name]) => name === 'closed')![1] as () => void
    closed()

    expect(signal?.aborted).toBe(true)
    stream.close()
    voice.dispose()
  })

  it('stops the stream and withdraws every channel on dispose', async () => {
    const stream = eventStream()
    stubFetch()
    serve = () => stream.response()
    const voice = createVoicePanel(USER_DATA, () => false, () => HOST)
    const panel = electron.windows[0]!
    handler(WATCH_CHANNEL)(eventFor(panel), true)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    const signal = calls[0]!.init?.signal

    voice.dispose()

    expect(signal?.aborted).toBe(true)
    expect(electron.handlers.has(STATE_CHANNEL)).toBe(false)
    expect(electron.handlers.has(WATCH_CHANNEL)).toBe(false)
    expect(electron.handlers.has(ACTION_CHANNEL)).toBe(false)
    stream.close()
    expect(() => handler(WATCH_CHANNEL)(eventFor(panel), false)).toThrow(/not registered/u)
  })
})
