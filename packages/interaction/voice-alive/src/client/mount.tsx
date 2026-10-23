/** Panel mount lifecycle: one React root under `#root`, disposed with the plugin. */
import type { Context } from '@deepseek-ai/cordis'
import { createRoot } from 'react-dom/client'
import { parseSurface, SURFACES } from './surfaces.ts'

/**
 * Replace the boot page with the panel root and keep it for the plugin's life.
 * @param ctx - Client runtime that owns the effect.
 * @throws {Error} when the panel document has no `#root` mount point.
 */
export function mountPanel(ctx: Context): void {
  const container = document.getElementById('root')
  if (container === null) throw new Error('voice-alive: the panel document has no #root')
  ctx.effect(() => {
    for (const boot of container.querySelectorAll(':scope > [data-dsh-boot]')) boot.remove()
    const surface = parseSurface(window.location.search)
    const Surface = SURFACES[surface]
    const root = createRoot(container)
    root.render(<Surface surface={surface} />)
    return () => { root.unmount() }
  }, 'voice-alive: panel mount')
}
