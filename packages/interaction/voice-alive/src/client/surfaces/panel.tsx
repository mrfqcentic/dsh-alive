/**
 * Panel surface. Ticket 05 renders the orb, the two shell controls, and the
 * drag regions; the export name and prop contract stay the same.
 * @module @deepseek-ai/dsh-voice-alive/client/surfaces/panel
 */
import type { ReactElement } from 'react'
import { Panel } from '../panel/Panel.tsx'
import type { SurfaceProps } from '../surfaces.ts'

/**
 * Render the panel surface.
 * @param props - the surface id selected by the registry.
 * @returns the panel with its orb and icon controls.
 */
export function PanelSurface({ surface }: SurfaceProps): ReactElement {
  return <Panel surface={surface} />
}
