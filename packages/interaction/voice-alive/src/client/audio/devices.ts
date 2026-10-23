/**
 * Input device enumeration and the typed microphone failure taxonomy.
 *
 * Labels are the browser's names for the devices: they are empty until the
 * origin holds microphone permission, and this module never substitutes a
 * localized placeholder. User-facing copy belongs to the UI layer.
 * @module @deepseek-ai/dsh-voice-alive/client/audio/devices
 */

/**
 * Stable discriminators for microphone failures.
 *
 * - `permission-denied`: the user or the operating system refused access.
 * - `no-device`: the requested or default input does not exist.
 * - `device-busy`: the input exists but cannot be opened (hardware or another
 *   application holds it).
 * - `unsupported`: this environment cannot do Web Audio capture at all, or the
 *   platform failed in a way that has no more specific meaning.
 */
export type CaptureErrorKind = 'permission-denied' | 'no-device' | 'device-busy' | 'unsupported'

/** Platform rejection names mapped to the two kinds they identify. */
const PLATFORM_ERROR_KINDS: Readonly<Record<string, CaptureErrorKind>> = {
  NotAllowedError: 'permission-denied',
  SecurityError: 'permission-denied',
  NotFoundError: 'no-device',
  OverconstrainedError: 'no-device',
  NotReadableError: 'device-busy',
  AbortError: 'device-busy',
}

/** Capture failure carrying the discriminator the UI maps to its own words. */
export class CaptureError extends Error {
  /** The stable failure discriminator. */
  readonly kind: CaptureErrorKind

  /**
   * @param kind - the stable failure discriminator.
   * @param cause - the platform error this capture failure translates, if any.
   */
  constructor(kind: CaptureErrorKind, cause?: unknown) {
    super(kind, { cause })
    this.name = 'CaptureError'
    this.kind = kind
  }
}

/** One input device offered by the browser. */
export interface InputDevice {
  /** Browser-assigned id, stable for this origin for the life of the installation. */
  readonly deviceId: string
  /** Browser-provided name; empty until the origin holds microphone permission. */
  readonly label: string
  /** True for the browser's default-input entry. */
  readonly isDefault: boolean
}

/**
 * Translate a platform rejection into the capture taxonomy.
 * @param error - rejection value from `getUserMedia` or device enumeration.
 * @returns the equivalent {@link CaptureError}; unrecognized values become
 * `unsupported` and keep the original as their cause.
 */
export function toCaptureError(error: unknown): CaptureError {
  if (error instanceof CaptureError) return error
  if (error instanceof DOMException) {
    const kind = PLATFORM_ERROR_KINDS[error.name]
    if (kind !== undefined) return new CaptureError(kind, error)
  }
  return new CaptureError('unsupported', error)
}

/**
 * Read the browser's media device registry.
 * @returns the registry, or throws `unsupported` when the page has none
 * (insecure context, or a test environment without media devices).
 */
function requireMediaDevices(): MediaDevices {
  const media = navigator.mediaDevices as MediaDevices | undefined
  if (media === undefined) throw new CaptureError('unsupported')
  return media
}

/**
 * Sort key that puts the default input first, then orders by label and id so
 * repeated enumerations return the same order.
 * @param device - the device to key.
 * @returns a string whose lexical order is the display order.
 */
function sortKey(device: InputDevice): string {
  return `${device.isDefault ? '0' : '1'}\u0000${device.label}\u0000${device.deviceId}`
}

/**
 * List the available microphones.
 * @returns audio inputs with the default first and a deterministic order;
 * empty when the browser knows of none.
 * @throws CaptureError `unsupported` when the page has no media device registry.
 */
export async function listInputDevices(): Promise<InputDevice[]> {
  const devices = await requireMediaDevices().enumerateDevices()
  const inputs: InputDevice[] = []
  for (const device of devices) {
    if (device.kind !== 'audioinput') continue
    inputs.push({ deviceId: device.deviceId, label: device.label, isDefault: device.deviceId === 'default' })
  }
  inputs.sort((a, b) => Number(sortKey(a) > sortKey(b)) - Number(sortKey(a) < sortKey(b)))
  return inputs
}

/**
 * Follow microphone hot-plug changes.
 *
 * Delivers the current list immediately, then one list per `devicechange`
 * event. Enumeration failures arrive through `onError` and leave the previous
 * list untouched.
 * @param listener - receives every successfully enumerated list.
 * @param onError - receives enumeration failures; omitted failures are dropped.
 * @returns function that stops refreshing and removes the browser listener.
 * @throws CaptureError `unsupported` when the page has no media device registry.
 */
export function subscribeInputDevices(
  listener: (devices: readonly InputDevice[]) => void,
  onError?: (error: CaptureError) => void,
): () => void {
  const media = requireMediaDevices()
  const refresh = (): void => {
    void listInputDevices().then((devices) => {
      try {
        listener(devices)
      } catch (error) {
        console.error('voice input device listener failed', error)
      }
    }, (error: unknown) => {
      if (onError !== undefined) onError(toCaptureError(error))
    })
  }
  const handleChange = (): void => { refresh() }
  media.addEventListener('devicechange', handleChange)
  refresh()
  return () => { media.removeEventListener('devicechange', handleChange) }
}
