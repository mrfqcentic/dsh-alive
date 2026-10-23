/**
 * Browser half of the voice row. The same `dsh.client` row that the panel
 * document boots is also present in the full chat surface, so this plugin
 * activates only when the document declares itself the voice panel; in the
 * chat shell it stays inert instead of mounting a second root.
 * @module @deepseek-ai/dsh-voice-alive/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountPanel } from './mount.tsx'

/** Document marker the panel page sets; absence means a non-panel surface. */
export const PANEL_DOCUMENT_ATTRIBUTE = 'data-dsh-voice-panel'

/**
 * Mount the panel root when this document owns the voice panel.
 * @param ctx - Client runtime that owns the mount lifetime.
 */
export function apply(ctx: Context): void {
  if (!document.documentElement.hasAttribute(PANEL_DOCUMENT_ATTRIBUTE)) return
  mountPanel(ctx)
}
