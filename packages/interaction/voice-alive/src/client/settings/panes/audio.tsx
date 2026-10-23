/**
 * Audio pane: the placeholder for device selection, metering, and the test tone.
 * @module @deepseek-ai/dsh-voice-alive/client/settings/panes/audio
 */
import type { ReactElement } from 'react'
import { copy } from '../locales.ts'
import css from '../settings.module.css'
import { PaneHeader } from './pane-header.tsx'

/**
 * Render the audio device placeholder.
 * @returns the Audio pane with disabled device selects and test-tone action.
 */
export function AudioPane(): ReactElement {
  return (
    <div>
      <PaneHeader title={copy.audio.title} description={copy.audio.description} badge={copy.audio.badge} />
      <div className={css.fieldGrid}>
        <label className="field">
          <span className="label">{copy.audio.inputLabel}</span>
          <span className="select">
            <select disabled defaultValue="system">
              <option value="system">{copy.audio.systemDefault}</option>
            </select>
          </span>
        </label>
        <label className="field">
          <span className="label">{copy.audio.outputLabel}</span>
          <span className="select">
            <select disabled defaultValue="system">
              <option value="system">{copy.audio.systemDefault}</option>
            </select>
          </span>
        </label>
      </div>
      <div className={css.actions}>
        <button type="button" className="btn" disabled>{copy.audio.action}</button>
      </div>
      <p className={css.foot}>{copy.audio.foot}</p>
    </div>
  )
}
