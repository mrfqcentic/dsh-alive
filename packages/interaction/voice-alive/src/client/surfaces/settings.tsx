/**
 * Settings surface placeholder. Ticket 06 replaces this file with the glass
 * frame and its five tabs; the export name and prop contract stay the same.
 * @module @deepseek-ai/dsh-voice-alive/client/surfaces/settings
 */
import type { ReactElement } from 'react'
import type { SurfaceProps } from '../surfaces.ts'

/**
 * Render the settings surface placeholder.
 * @param props - the surface id selected by the registry.
 * @returns a monochrome placeholder naming the surface.
 */
export function SettingsSurface({ surface }: SurfaceProps): ReactElement {
  return (
    <section className="dialog" data-voice-surface={surface} data-voice-surface-stub="">
      <header className="dialog-head">
        <span className="eyebrow">{surface}</span>
      </header>
    </section>
  )
}
