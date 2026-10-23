/**
 * Panel surface. Renders the orb, the two shell controls, and the drag
 * regions, and owns the audio state machine for the panel's lifetime.
 * @module @deepseek-ai/dsh-voice-alive/client/surfaces/panel
 */
import { useEffect, type ReactElement } from 'react'
import { createCapture } from '../audio/capture.ts'
import { createAudioMachine } from '../audio/machine.ts'
import { createPlayback } from '../audio/playback.ts'
import { Panel } from '../panel/Panel.tsx'
import { panelState } from '../panel/state.ts'
import type { SurfaceProps } from '../surfaces.ts'

/**
 * Render the panel surface.
 *
 * The machine reads its mute state from the shared store, so the panel's mute
 * chord and orb button reach it without changing those controls.
 * @param props - the surface id selected by the registry.
 * @returns the panel with its orb and icon controls.
 */
export function PanelSurface({ surface }: SurfaceProps): ReactElement {
  useEffect(() => {
    const machine = createAudioMachine({
      capture: createCapture(),
      playback: createPlayback(),
      store: panelState,
    })
    void machine.start()
    return () => { machine.stop() }
  }, [])
  return <Panel surface={surface} />
}
