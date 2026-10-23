/**
 * Workspaces pane: the placeholder for the registered workspace list.
 * @module @deepseek-ai/dsh-voice-alive/client/settings/panes/workspaces
 */
import type { ReactElement } from 'react'
import { copy } from '../locales.ts'
import css from '../settings.module.css'
import { PaneHeader } from './pane-header.tsx'

/**
 * Render the workspace list placeholder.
 * @returns the Workspaces pane with a disabled add-folder action.
 */
export function WorkspacesPane(): ReactElement {
  return (
    <div>
      <PaneHeader
        title={copy.workspaces.title}
        description={copy.workspaces.description}
        badge={copy.workspaces.badge}
      />
      <div className="empty">
        <strong>{copy.workspaces.emptyTitle}</strong>
        <span className={css.emptyBody}>{copy.workspaces.emptyBody}</span>
      </div>
      <div className={css.actions}>
        <button type="button" className="btn" disabled>{copy.workspaces.action}</button>
      </div>
      <p className={css.foot}>{copy.workspaces.foot}</p>
    </div>
  )
}
