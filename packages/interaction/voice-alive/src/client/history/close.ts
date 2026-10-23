/**
 * Close the history surface's shell window.
 *
 * The Electron preload exposes `window.dshVoicePanel`; its contract is owned by
 * `client/panel/bridge.ts`, so this module adds no second declaration. In a
 * document without the bridge (this package's tests and a plain browser) the
 * close falls back to `window.close()`.
 * @module @deepseek-ai/dsh-voice-alive/client/history/close
 */
import type { VoicePanelBridgeApi } from '../panel/bridge.ts'

/**
 * Close the window that renders the history surface.
 */
export function closeHistoryWindow(): void {
  const bridge: Pick<VoicePanelBridgeApi, 'close'> | undefined = window.dshVoicePanel
  if (bridge?.close !== undefined) {
    void bridge.close()
    return
  }
  window.close()
}
