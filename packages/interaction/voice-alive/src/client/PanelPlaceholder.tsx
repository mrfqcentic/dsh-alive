/**
 * Placeholder panel root. The orb and panel chrome replace it; until then it
 * proves the client entry mounts inside the dedicated panel document and
 * renders nothing else.
 * @module @deepseek-ai/dsh-voice-alive/client/placeholder
 */
import type { ReactElement } from 'react'
import css from './PanelPlaceholder.module.css'

/**
 * Centered monochrome mark for the panel document.
 * @returns the temporary panel root element.
 */
export function PanelPlaceholder(): ReactElement {
  return (
    <div className={css.panel} data-voice-panel-placeholder="">
      <div className={css.orb} />
    </div>
  )
}
