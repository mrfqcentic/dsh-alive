/** Input device enumeration, hot-plug refresh, and the typed capture error taxonomy. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CaptureError,
  listInputDevices,
  subscribeInputDevices,
  toCaptureError,
} from '../src/client/audio/devices.ts'

interface DeviceEntry {
  readonly kind: string
  readonly deviceId: string
  readonly label: string
  readonly groupId: string
}

interface FakeRegistry {
  readonly media: {
    enumerateDevices: ReturnType<typeof vi.fn>
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
  }
  dispatch(): void
}

/**
 * Install a fake device registry as `navigator.mediaDevices`.
 * @param entries - devices the registry reports.
 * @returns the registry and a way to fire `devicechange`.
 */
function installRegistry(entries: readonly DeviceEntry[]): FakeRegistry {
  const listeners = new Set<() => void>()
  const media = {
    enumerateDevices: vi.fn(async () => entries),
    addEventListener: vi.fn((_type: string, listener: () => void) => { listeners.add(listener) }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => { listeners.delete(listener) }),
  }
  vi.stubGlobal('navigator', { mediaDevices: media })
  return {
    media,
    dispatch: () => { for (const listener of [...listeners]) listener() },
  }
}

/**
 * Let promise continuations run.
 * @returns after two microtask turns.
 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listInputDevices', () => {
  it('returns audio inputs with the default first and a stable order', async () => {
    installRegistry([
      { kind: 'audioinput', deviceId: 'mic-b', label: 'Studio', groupId: 'g' },
      { kind: 'videoinput', deviceId: 'cam', label: 'Camera', groupId: 'g' },
      { kind: 'audioinput', deviceId: 'default', label: 'System default', groupId: 'g' },
      { kind: 'audioinput', deviceId: 'mic-a', label: 'Built-in', groupId: 'g' },
    ])
    await expect(listInputDevices()).resolves.toEqual([
      { deviceId: 'default', label: 'System default', isDefault: true },
      { deviceId: 'mic-a', label: 'Built-in', isDefault: false },
      { deviceId: 'mic-b', label: 'Studio', isDefault: false },
    ])
  })

  it('returns empty labels before permission without inventing copy', async () => {
    installRegistry([
      { kind: 'audioinput', deviceId: 'mic-a', label: '', groupId: 'g' },
      { kind: 'audioinput', deviceId: 'mic-b', label: '', groupId: 'g' },
    ])
    await expect(listInputDevices()).resolves.toEqual([
      { deviceId: 'mic-a', label: '', isDefault: false },
      { deviceId: 'mic-b', label: '', isDefault: false },
    ])
  })

  it('returns an empty list when the browser reports no inputs', async () => {
    installRegistry([])
    await expect(listInputDevices()).resolves.toEqual([])
  })

  it('reports unsupported without a media device registry', async () => {
    vi.stubGlobal('navigator', {})
    await expect(listInputDevices()).rejects.toMatchObject({ kind: 'unsupported' })
  })
})

describe('hot-plug subscription', () => {
  it('delivers the current list and refreshes on devicechange', async () => {
    const first: DeviceEntry[] = [{ kind: 'audioinput', deviceId: 'mic-a', label: 'Built-in', groupId: 'g' }]
    const registry = installRegistry(first)
    const listener = vi.fn()
    const stop = subscribeInputDevices(listener)
    await settle()
    expect(listener).toHaveBeenLastCalledWith([{ deviceId: 'mic-a', label: 'Built-in', isDefault: false }])

    registry.media.enumerateDevices.mockResolvedValueOnce([
      { kind: 'audioinput', deviceId: 'mic-a', label: 'Built-in', groupId: 'g' },
      { kind: 'audioinput', deviceId: 'mic-b', label: 'Studio', groupId: 'g' },
    ])
    registry.dispatch()
    await settle()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith([
      { deviceId: 'mic-a', label: 'Built-in', isDefault: false },
      { deviceId: 'mic-b', label: 'Studio', isDefault: false },
    ])
    stop()
  })

  it('stops refreshing and removes the browser listener when unsubscribed', async () => {
    const registry = installRegistry([])
    const listener = vi.fn()
    const stop = subscribeInputDevices(listener)
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    expect(registry.media.removeEventListener).toHaveBeenCalledTimes(1)
    registry.dispatch()
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('contains a throwing device listener', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    installRegistry([])
    const stop = subscribeInputDevices(() => {
      throw new Error('render failed')
    })
    await settle()
    expect(consoleError).toHaveBeenCalledWith('voice input device listener failed', expect.any(Error))
    stop()
  })

  it('reports enumeration failures through onError', async () => {
    const registry = installRegistry([])
    registry.media.enumerateDevices.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    const listener = vi.fn()
    const onError = vi.fn()
    const stop = subscribeInputDevices(listener, onError)
    await settle()
    expect(listener).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ kind: 'permission-denied' })
    stop()
  })

  it('drops enumeration failures when no onError is supplied', async () => {
    const registry = installRegistry([])
    registry.media.enumerateDevices.mockRejectedValueOnce(new Error('registry offline'))
    const listener = vi.fn()
    const stop = subscribeInputDevices(listener)
    await settle()
    expect(listener).not.toHaveBeenCalled()
    stop()
  })

  it('refuses to subscribe without a media device registry', () => {
    vi.stubGlobal('navigator', {})
    expect(() => subscribeInputDevices(vi.fn())).toThrow(CaptureError)
  })
})

describe('capture error taxonomy', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'no-device'],
    ['OverconstrainedError', 'no-device'],
    ['NotReadableError', 'device-busy'],
    ['AbortError', 'device-busy'],
    ['UnknownError', 'unsupported'],
  ]

  it.each(cases)('maps %s to %s', (name, kind) => {
    const error = toCaptureError(new DOMException('platform', name))
    expect(error).toBeInstanceOf(CaptureError)
    expect(error.kind).toBe(kind)
    expect(error.name).toBe('CaptureError')
    expect(error.cause).toBeInstanceOf(DOMException)
  })

  it('returns a capture error unchanged', () => {
    const original = new CaptureError('no-device')
    expect(toCaptureError(original)).toBe(original)
    expect(original.cause).toBeUndefined()
  })

  it('maps a non-platform value to unsupported and keeps it as the cause', () => {
    const cause = new Error('boom')
    const error = toCaptureError(cause)
    expect(error.kind).toBe('unsupported')
    expect(error.cause).toBe(cause)
  })
})
