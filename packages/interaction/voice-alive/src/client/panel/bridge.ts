/**
 * Typed access to the Desktop shell's panel bridge.
 *
 * The shell ships this preload independently of the surface, so every method
 * is detected on its own and replaced by a no-op when the shell does not
 * provide it. Components call this module and never `window.dshVoicePanel`,
 * which keeps the panel renderable in a browser tab and under test.
 * @module @deepseek-ai/dsh-voice-alive/client/panel/bridge
 */

/** Surface a panel action can open in the shell. */
export type PanelSurfaceId = 'settings' | 'history'

/** Visibility and shortcut availability the shell publishes. */
export interface PanelVisibility {
  /** Whether the panel window is currently shown. */
  readonly visible: boolean
  /** Whether the OS granted the summon chord. */
  readonly shortcutRegistered: boolean
}

/**
 * Methods the preload exposes on `window.dshVoicePanel`.
 *
 * Every method is optional here because the shell lands in parallel with this
 * surface; the wrapper checks each one before calling it.
 */
export interface VoicePanelBridgeApi {
  /** Bridge protocol version the shell implements. */
  readonly protocolVersion?: number
  /** @returns current visibility and shortcut availability. */
  state?(): Promise<PanelVisibility>
  /** @param listener - receives each visibility change. @returns function that stops observing. */
  subscribe?(listener: (state: PanelVisibility) => void): () => void
  /** @param surface - shell window to show above the panel. @returns completion of the request. */
  openSurface?(surface: PanelSurfaceId): Promise<void>
  /** @returns completion of the hide request. */
  close?(): Promise<void>
  /** @param listener - receives each mute-toggle chord. @returns function that stops observing. */
  onToggleMute?(listener: () => void): () => void
}

declare global {
  interface Window {
    /** Preload bridge installed by the Desktop shell; absent in a browser tab. */
    dshVoicePanel?: VoicePanelBridgeApi
  }
}

/** Protocol version this wrapper understands. */
export const PANEL_PROTOCOL_VERSION = 1

/** State reported when the shell has no bridge or cannot answer. */
const FALLBACK_VISIBILITY: PanelVisibility = Object.freeze({
  visible: true,
  shortcutRegistered: false,
})

/** Unsubscriber returned when the shell does not offer the subscription. */
const NOOP_UNSUBSCRIBE = (): void => {}

/** Panel-facing bridge in which every shell method is callable. */
export interface PanelBridge {
  /** Whether the shell exposes a compatible bridge right now. */
  readonly supported: boolean
  /** @returns the shell's visibility state, or the fallback when unavailable. */
  state(): Promise<PanelVisibility>
  /** @param listener - receives each visibility change. @returns function that stops observing. */
  subscribe(listener: (state: PanelVisibility) => void): () => void
  /** @param surface - shell window to show above the panel. @returns completion of the request. */
  openSurface(surface: PanelSurfaceId): Promise<void>
  /** @returns completion of the hide request. */
  close(): Promise<void>
  /** @param listener - receives each mute-toggle chord. @returns function that stops observing. */
  onToggleMute(listener: () => void): () => void
}

/**
 * Build a bridge over one shell API reader.
 * @param read - returns the current API, normally from `window`.
 * @returns the bridge; an absent method resolves or ignores as a no-op.
 */
export function createPanelBridge(
  read: () => VoicePanelBridgeApi | undefined = () => window.dshVoicePanel,
): PanelBridge {
  const current = (): VoicePanelBridgeApi | undefined => {
    const candidate = read()
    return candidate?.protocolVersion === PANEL_PROTOCOL_VERSION ? candidate : undefined
  }

  return {
    get supported() { return current() !== undefined },
    state() {
      const api = current()
      if (typeof api?.state !== 'function') return Promise.resolve(FALLBACK_VISIBILITY)
      // A rejected invoke means the shell channel is gone; the panel keeps
      // rendering against the fallback instead of surfacing an error.
      return api.state().catch(() => FALLBACK_VISIBILITY)
    },
    subscribe(listener) {
      const api = current()
      return typeof api?.subscribe === 'function' ? api.subscribe(listener) : NOOP_UNSUBSCRIBE
    },
    openSurface(surface) {
      const api = current()
      if (typeof api?.openSurface !== 'function') return Promise.resolve()
      return api.openSurface(surface).catch(() => {})
    },
    close() {
      const api = current()
      if (typeof api?.close !== 'function') return Promise.resolve()
      return api.close().catch(() => {})
    },
    onToggleMute(listener) {
      const api = current()
      return typeof api?.onToggleMute === 'function' ? api.onToggleMute(listener) : NOOP_UNSUBSCRIBE
    },
  }
}

/** Bridge shared by the panel surface. */
export const panelBridge: PanelBridge = createPanelBridge()
