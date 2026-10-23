/** Typed visibility bridge for the voice panel renderer; it exposes no generic IPC passthrough. */

import { contextBridge, ipcRenderer } from 'electron'
import type { VoicePanelApi, VoicePanelState, VoiceSurfaceId } from './voice-panel.ts'

/** Mirrors the channel in `voice-panel.ts`; the preload cannot import the main-process module. */
const VOICE_PANEL_CHANNEL = 'dsh-voice:panel-state'
/** Mirrors the surface channel in `voice-panel.ts`. */
const VOICE_SURFACE_CHANNEL = 'dsh-voice:open-surface'

const api: VoicePanelApi = {
  protocolVersion: 1,
  state: () => ipcRenderer.invoke(VOICE_PANEL_CHANNEL) as Promise<VoicePanelState>,
  subscribe(listener) {
    const handle = (_event: Electron.IpcRendererEvent, state: VoicePanelState): void => { listener(state) }
    ipcRenderer.on(VOICE_PANEL_CHANNEL, handle)
    return () => { ipcRenderer.off(VOICE_PANEL_CHANNEL, handle) }
  },
  openSurface: (surface: VoiceSurfaceId) => ipcRenderer.invoke(VOICE_SURFACE_CHANNEL, surface) as Promise<void>,
}

contextBridge.exposeInMainWorld('dshVoicePanel', api)
