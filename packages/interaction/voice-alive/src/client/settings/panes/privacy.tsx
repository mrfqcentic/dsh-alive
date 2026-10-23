/**
 * Privacy pane: the placeholder for the local-only data statements.
 * @module @deepseek-ai/dsh-voice-alive/client/settings/panes/privacy
 */
import type { ReactElement } from 'react'
import { copy } from '../locales.ts'
import css from '../settings.module.css'
import { PaneHeader } from './pane-header.tsx'

/**
 * Render the privacy statements.
 * @returns the Privacy pane listing what stays on this machine.
 */
export function PrivacyPane(): ReactElement {
  return (
    <div>
      <PaneHeader title={copy.privacy.title} description={copy.privacy.description} badge={copy.privacy.badge} />
      <div className={css.statements}>
        {copy.privacy.statements.map(statement => (
          <div className={css.statement} key={statement.title}>
            <span className={css.statementMark} aria-hidden="true" />
            <div className={css.statementBody}>
              <strong className={css.statementTitle}>{statement.title}</strong>
              <p className={css.statementCopy}>{statement.body}</p>
            </div>
          </div>
        ))}
      </div>
      <p className={css.foot}>{copy.privacy.foot}</p>
    </div>
  )
}
