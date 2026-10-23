/** Shared title row for the five settings panes. */
import type { ReactElement } from 'react'
import css from '../settings.module.css'

/** Content of one pane title row. */
export interface PaneHeaderProps {
  /** Pane name. */
  readonly title: string
  /** One-line description of what the pane will hold. */
  readonly description: string
  /** Short status badge. */
  readonly badge: string
}

/**
 * Render a pane's title, description, and status badge.
 * @param props - pane copy.
 * @returns the shared pane heading row.
 */
export function PaneHeader({ title, description, badge }: PaneHeaderProps): ReactElement {
  return (
    <header className={css.paneHead}>
      <div>
        <h3 className={css.paneTitle}>{title}</h3>
        <p className={css.paneLede}>{description}</p>
      </div>
      <span className="badge">{badge}</span>
    </header>
  )
}
