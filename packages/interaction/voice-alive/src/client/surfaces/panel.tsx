/**
 * Panel surface placeholder. Ticket 05 replaces this file with the orb and
 * panel chrome; the export name and prop contract stay the same.
 * @module @deepseek-ai/dsh-voice-alive/client/surfaces/panel
 */
import type { ReactElement } from 'react'
import type { SurfaceProps } from '../surfaces.ts'

/**
 * Render the panel surface placeholder.
 * @param props - the surface id selected by the registry.
 * @returns a monochrome placeholder naming the surface.
 */
export function PanelSurface({ surface }: SurfaceProps): ReactElement {
  return (
    <main className="card" data-voice-surface={surface} data-voice-surface-stub="">
      <span className="eyebrow">{surface}</span>
    </main>
  )
}
