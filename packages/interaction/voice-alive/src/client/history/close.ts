/**
 * Close the history surface's shell window.
 *
 * The Electron preload exposes `window.dshVoicePanel`; when it grows a
 * `close()` operation this accessor uses it, and in every other document
 * (including this package's tests and a plain browser) it falls back to
 * `window.close()`. The accessor stays private so the shell bridge can gain
 * that operation without another edit here.
 * @module @deepseek-ai/dsh-voice-alive/client/history/close
 */

/** The part of the voice preload bridge this surface needs. */
interface VoicePanelCloseBridge {
  /** Close the window that renders the surface. */
  readonly close?: () => void
}

declare global {
  interface Window {
    /** Shell bridge present only in the Electron voice panel document. */
    readonly dshVoicePanel?: VoicePanelCloseBridge
  }
}

/**
 * Close the window that renders the history surface.
 */
export function closeHistoryWindow(): void {
  const bridge = window.dshVoicePanel
  if (bridge?.close !== undefined) {
    bridge.close()
    return
  }
  window.close()
}
