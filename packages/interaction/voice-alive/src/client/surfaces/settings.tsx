/**
 * Settings surface: the content of the 520×640 settings window.
 *
 * The Desktop shell owns the window, its glass backdrop, and always-on-top
 * behaviour. This surface owns the five-tab frame, the keyboard model, the
 * Escape-to-close request, and the session-scoped selected tab. The pane list
 * lives only in `settings/tabs.ts`, so a later ticket replaces one pane file.
 * @module @deepseek-ai/dsh-voice-alive/client/surfaces/settings
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { panelBridge } from '../panel/bridge.ts'
import { readActiveSettingsTab, storeActiveSettingsTab } from '../settings/active-tab.ts'
import { copy } from '../settings/locales.ts'
import css from '../settings/settings.module.css'
import { SETTINGS_TABS, type SettingsTabId } from '../settings/tabs.ts'
import type { SurfaceProps } from '../surfaces.ts'

/** @returns the DOM id of one settings tab button. */
function tabElementId(id: SettingsTabId): string {
  return `voice-settings-tab-${id}`
}

/** @returns the DOM id of one settings tab panel. */
function panelElementId(id: SettingsTabId): string {
  return `voice-settings-panel-${id}`
}

/**
 * Render the five-tab settings surface.
 * @param props - the surface id selected by the registry.
 * @returns the settings frame with its tab strip and pane region.
 */
export function SettingsSurface({ surface }: SurfaceProps): ReactElement {
  const [activeId, setActiveId] = useState<SettingsTabId>(readActiveSettingsTab)
  const tabButtons = useRef<Array<HTMLButtonElement>>([])

  const select = (id: SettingsTabId): void => {
    setActiveId(id)
    storeActiveSettingsTab(id)
  }

  // The shell no longer intercepts Escape for surface windows; the surface asks
  // it to close this window, which leaves the tab list's own keys untouched.
  useEffect(() => {
    /** @param event - a keydown received anywhere in the settings document. */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      void panelBridge.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = (index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length; break
      case 'ArrowRight': next = (index + 1) % SETTINGS_TABS.length; break
      case 'Home': next = 0; break
      case 'End': next = SETTINGS_TABS.length - 1; break
      // Escape stays unclaimed by the tab strip; the surface's window listener
      // asks the shell to close the window.
      default: return
    }
    event.preventDefault()
    const nextTab = SETTINGS_TABS[next]
    /* v8 ignore next -- the switch keeps next inside SETTINGS_TABS. */
    if (nextTab === undefined) return
    select(nextTab.id)
    const nextButton = tabButtons.current[next]
    /* v8 ignore next -- a mounted tab registers its ref before a key reaches it. */
    if (nextButton === undefined) return
    nextButton.focus()
  }

  return (
    <section className={css.surface} data-voice-surface={surface} aria-label={copy.window}>
      <header className={css.header}>
        <div>
          <span className="eyebrow">{copy.eyebrow}</span>
          <h2 className={css.title}>{copy.title}</h2>
        </div>
        <div className={css.meta}>
          <span className="badge">{copy.badge}</span>
          <span className={css.subtitle}>{copy.subtitle}</span>
        </div>
      </header>
      <div role="tablist" aria-label={copy.tabsLabel} className={`tabs ${css.tabStrip}`}>
        {SETTINGS_TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => { if (element !== null) tabButtons.current[index] = element }}
            id={tabElementId(tab.id)}
            type="button"
            role="tab"
            aria-selected={tab.id === activeId}
            aria-controls={panelElementId(tab.id)}
            tabIndex={tab.id === activeId ? 0 : -1}
            className={css.tab}
            onClick={() => { select(tab.id) }}
            onKeyDown={(event) => { onTabKeyDown(event, index) }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className={css.paneRegion}>
        {SETTINGS_TABS.map(tab => (
          <section
            key={tab.id}
            id={panelElementId(tab.id)}
            role="tabpanel"
            aria-labelledby={tabElementId(tab.id)}
            hidden={tab.id !== activeId}
            tabIndex={0}
            className={css.pane}
          >
            <tab.Pane />
          </section>
        ))}
      </div>
    </section>
  )
}
