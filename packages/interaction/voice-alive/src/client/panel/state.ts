/**
 * Panel state store.
 *
 * One tiny external store owns the state the orb renders and the mute toggle
 * flips. Components read it through `useSyncExternalStore`; the audio state
 * machine drives it with {@link PanelStateStore.set} instead of scattering
 * `useState` across the panel tree.
 * @module @deepseek-ai/dsh-voice-alive/client/panel/state
 */
import type { OrbState } from '../orb/Orb.tsx'

/** The five panel states; the same union the orb renders. */
export type PanelState = OrbState

/** Every panel state, in product order. */
export const PANEL_STATES: readonly PanelState[] = ['muted', 'listening', 'thinking', 'speaking', 'error']

/** Observable holder for one panel state. */
export interface PanelStateStore {
  /** @returns the current state. */
  get(): PanelState
  /**
   * Replace the state and notify subscribers when it actually changed.
   * @param next - the state to publish.
   */
  set(next: PanelState): void
  /**
   * Observe every published state.
   * @param listener - receives each new state.
   * @returns function that stops observing.
   */
  subscribe(listener: (state: PanelState) => void): () => void
}

/**
 * Create an independent panel state store.
 * @param initial - state before the first `set`; `muted` unless supplied.
 * @returns the store with its getter, setter, and subscription.
 */
export function createPanelState(initial: PanelState = 'muted'): PanelStateStore {
  let current = initial
  const listeners = new Set<(state: PanelState) => void>()
  return {
    get: () => current,
    set(next) {
      if (next === current) return
      current = next
      // Iterate a copy so subscription changes a listener makes do not affect
      // the set of listeners already being notified.
      for (const listener of [...listeners]) listener(next)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** Store shared by the panel surface and, from ticket 10 on, the audio state machine. */
export const panelState: PanelStateStore = createPanelState()

/**
 * The state a mute toggle produces: muted listens again, anything else mutes.
 * @param state - the state before the toggle.
 * @returns `listening` when muted, otherwise `muted`.
 */
export function nextMutedState(state: PanelState): PanelState {
  return state === 'muted' ? 'listening' : 'muted'
}

/**
 * Flip the mute state on one store.
 * @param store - store to toggle; the panel singleton unless supplied.
 */
export function togglePanelMute(store: PanelStateStore = panelState): void {
  store.set(nextMutedState(store.get()))
}
