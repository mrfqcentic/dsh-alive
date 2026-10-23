/**
 * The panel surface: an orb stage, two icon controls, and drag regions.
 *
 * No prose is rendered; the orb carries every state. The section is the
 * window's drag region and each control opts out so it stays clickable. The
 * Desktop shell owns visibility, Escape, and position persistence.
 * @module @deepseek-ai/dsh-voice-alive/client/panel/Panel
 */
import { useCallback, useEffect, useSyncExternalStore, type ReactElement } from 'react'
import { Orb } from '../orb/Orb.tsx'
import type { SurfaceProps } from '../surfaces.ts'
import { panelBridge } from './bridge.ts'
import { HistoryIcon, SettingsIcon } from './icons.tsx'
import { copy } from './locales.ts'
import css from './panel.module.css'
import { panelState, togglePanelMute } from './state.ts'

/**
 * Render the panel surface.
 * @param props - the surface id selected by the registry.
 * @returns the glass panel with its orb and two icon buttons.
 */
export function Panel({ surface }: SurfaceProps): ReactElement {
  const subscribe = useCallback((listener: () => void) => panelState.subscribe(listener), [])
  const read = useCallback(() => panelState.get(), [])
  const state = useSyncExternalStore(subscribe, read, read)
  const muted = state === 'muted'

  // A programmatic ref focuses the panel root so Tab reaches the controls; the
  // callback also runs with null on unmount.
  const focusPanel = useCallback((element: HTMLElement | null): void => {
    element?.focus()
  }, [])

  const toggleMute = useCallback((): void => { togglePanelMute() }, [])

  // The shell fires this while the panel is visible; the surface only flips
  // the state it owns.
  useEffect(() => panelBridge.onToggleMute(toggleMute), [toggleMute])

  return (
    <section
      ref={focusPanel}
      tabIndex={-1}
      className={css.surface}
      data-voice-surface={surface}
      data-state={state}
      data-muted={String(muted)}
      aria-label={copy.panel}
    >
      <header className={css.topBar}>
        <span className={css.grip} aria-hidden="true" />
        <div className={css.actions}>
          <button
            type="button"
            className={`${css.iconButton} ${css.noDrag}`}
            aria-label={copy.settings}
            onClick={() => { void panelBridge.openSurface('settings') }}
          >
            <SettingsIcon />
          </button>
          <button
            type="button"
            className={`${css.iconButton} ${css.noDrag}`}
            aria-label={copy.history}
            onClick={() => { void panelBridge.openSurface('history') }}
          >
            <HistoryIcon />
          </button>
        </div>
      </header>
      <div className={css.stage}>
        <span className={css.halo} aria-hidden="true" />
        <button
          type="button"
          className={`${css.orbButton} ${css.noDrag}`}
          aria-label={muted ? copy.unmute : copy.mute}
          aria-pressed={muted}
          onClick={toggleMute}
        >
          <Orb state={state} />
        </button>
      </div>
    </section>
  )
}
