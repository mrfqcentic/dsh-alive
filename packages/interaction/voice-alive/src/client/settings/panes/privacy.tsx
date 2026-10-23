/**
 * Privacy pane: what leaves the machine, where the panel keeps its data, and
 * the two controls that change either.
 * @module @deepseek-ai/dsh-voice-alive/client/settings/panes/privacy
 */
import type { ReactElement } from 'react'
import { copy } from '../locales.ts'
import css from '../settings.module.css'
import { PaneHeader } from './pane-header.tsx'

/** One plain statement: a short title and its full sentence. */
interface Statement {
  /** Short label for the statement. */
  readonly title: string
  /** Complete sentence shown below the label. */
  readonly body: string
}

/**
 * Render one titled list of plain statements.
 * @param props - section title and its statements.
 * @returns the section heading and statement cards.
 */
function StatementGroup({ title, statements }: { readonly title: string; readonly statements: readonly Statement[] }): ReactElement {
  return (
    <section>
      <h4 className={css.sectionTitle}>{title}</h4>
      <div className={css.statements}>
        {statements.map(statement => (
          <div className={css.statement} key={statement.title}>
            <span className={css.statementMark} aria-hidden="true" />
            <div className={css.statementBody}>
              <strong className={css.statementTitle}>{statement.title}</strong>
              <p className={css.statementCopy}>{statement.body}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * Render the privacy statements.
 * @returns the Privacy pane, with no control that claims to change outbound behavior.
 */
export function PrivacyPane(): ReactElement {
  return (
    <div>
      <PaneHeader title={copy.privacy.title} description={copy.privacy.description} badge={copy.privacy.badge} />
      <StatementGroup title={copy.privacy.leavesTitle} statements={copy.privacy.leaves} />
      <StatementGroup title={copy.privacy.diskTitle} statements={copy.privacy.disk} />
      <StatementGroup title={copy.privacy.switchesTitle} statements={copy.privacy.switches} />
      <p className={css.foot}>{copy.privacy.foot}</p>
    </div>
  )
}
