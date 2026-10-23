/**
 * Shortcuts pane: the placeholder for recording the summon chord.
 * @module @deepseek-ai/dsh-voice-alive/client/settings/panes/shortcuts
 */
import type { ReactElement } from 'react'
import { copy } from '../locales.ts'
import css from '../settings.module.css'
import { PaneHeader } from './pane-header.tsx'

/**
 * Render the shortcut placeholder with the default chord.
 * @returns the Shortcuts pane with disabled record and reset actions.
 */
export function ShortcutsPane(): ReactElement {
  return (
    <div>
      <PaneHeader
        title={copy.shortcuts.title}
        description={copy.shortcuts.description}
        badge={copy.shortcuts.badge}
      />
      <div className="card">
        <span className="card-title">{copy.shortcuts.summonTitle}</span>
        <div className={css.chord}>
          <kbd className={css.chordKey}>{copy.shortcuts.modifier}</kbd>
          <kbd className={css.chordKey}>{copy.shortcuts.key}</kbd>
        </div>
        <p className={css.cardCopy}>{copy.shortcuts.summonBody}</p>
      </div>
      <div className={css.actions}>
        <button type="button" className="btn" disabled>{copy.shortcuts.record}</button>
        <button type="button" className="btn btn--ghost" disabled>{copy.shortcuts.reset}</button>
      </div>
      <p className={css.foot}>{copy.shortcuts.foot}</p>
    </div>
  )
}
