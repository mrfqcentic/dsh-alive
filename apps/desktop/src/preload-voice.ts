/** Typed visibility bridge for the voice panel renderer; it exposes no generic IPC passthrough. */

import { contextBridge, ipcRenderer } from 'electron'
import type { VoicePanelApi, VoicePanelState } from './voice-panel.ts'

/** Mirrors the channel in `voice-panel.ts`; the preload cannot import the main-process module. */
const VOICE_PANEL_CHANNEL = 'dsh-voice:panel-state'

const api: VoicePanelApi = {
  protocolVersion: 1,
  state: () => ipcRenderer.invoke(VOICE_PANEL_CHANNEL) as Promise<VoicePanelState>,
  subscribe(listener) {
    const handle = (_event: Electron.IpcRendererEvent, state: VoicePanelState): void => { listener(state) }
    ipcRenderer.on(VOICE_PANEL_CHANNEL, handle)
    return () => { ipcRenderer.off(VOICE_PANEL_CHANNEL, handle) }
  },
}

contextBridge.exposeInMainWorld('dshVoicePanel', api)
