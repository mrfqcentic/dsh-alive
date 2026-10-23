/**
 * History surface placeholder. Ticket 07 replaces this file with the turn
 * list and its search field; the export name and prop contract stay the same.
 * @module @deepseek-ai/dsh-voice-alive/client/surfaces/history
 */
import type { ReactElement } from 'react'
import type { SurfaceProps } from '../surfaces.ts'

/**
 * Render the history surface placeholder.
 * @param props - the surface id selected by the registry.
 * @returns a monochrome placeholder naming the surface.
 */
export function HistorySurface({ surface }: SurfaceProps): ReactElement {
  return (
    <section className="card" data-voice-surface={surface} data-voice-surface-stub="">
      <div className="empty">
        <strong className="mono">{surface}</strong>
      </div>
    </section>
  )
}
