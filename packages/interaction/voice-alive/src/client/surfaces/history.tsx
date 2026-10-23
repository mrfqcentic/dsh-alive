/**
 * History surface: the turn list and its search field. Ticket 22 swaps the
 * source behind `createHistorySource`; this component and its export name stay
 * the same.
 * @module @deepseek-ai/dsh-voice-alive/client/surfaces/history
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import { closeHistoryWindow } from '../history/close.ts'
import { HistoryWindow } from '../history/HistoryWindow.tsx'
import { createHistorySource } from '../history/source.ts'
import type { SurfaceProps } from '../surfaces.ts'

/**
 * Render the history surface.
 * @param props - the surface id selected by the registry.
 * @returns the history window inside its floating glass root.
 */
export function HistorySurface({ surface }: SurfaceProps): ReactElement {
  const [source] = useState(createHistorySource)
  return (
    <div className="voice-history-root" data-voice-surface={surface}>
      <HistoryWindow source={source} onClose={closeHistoryWindow} />
    </div>
  )
}
