/**
 * Models pane: the placeholder for the local model catalog.
 * @module @deepseek-ai/dsh-voice-alive/client/settings/panes/models
 */
import type { ReactElement } from 'react'
import { copy } from '../locales.ts'
import css from '../settings.module.css'
import { PaneHeader } from './pane-header.tsx'

/**
 * Render the model catalog placeholder.
 * @returns the Models pane with a disabled download action.
 */
export function ModelsPane(): ReactElement {
  return (
    <div>
      <PaneHeader title={copy.models.title} description={copy.models.description} badge={copy.models.badge} />
      <div className="empty">
        <strong>{copy.models.emptyTitle}</strong>
        <span className={css.emptyBody}>{copy.models.emptyBody}</span>
      </div>
      <div className={css.actions}>
        <button type="button" className="btn" disabled>{copy.models.action}</button>
      </div>
      <p className={css.foot}>{copy.models.foot}</p>
    </div>
  )
}
