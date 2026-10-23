/** Typed window bridges for the voice panel renderer; they expose no generic IPC passthrough. */

import { contextBridge, ipcRenderer } from 'electron'
import type { VoiceModelsAction, VoiceModelsApi, VoicePanelApi, VoicePanelState, VoiceSurfaceId } from './voice-panel.ts'

/** Mirrors the channel in `voice-panel.ts`; the preload cannot import the main-process module. */
const VOICE_PANEL_CHANNEL = 'dsh-voice:panel-state'
/** Mirrors the surface channel in `voice-panel.ts`. */
const VOICE_SURFACE_CHANNEL = 'dsh-voice:open-surface'
/** Mirrors the close channel in `voice-panel.ts`. */
const VOICE_CLOSE_CHANNEL = 'dsh-voice:close'
/** Mirrors the mute-toggle channel in `voice-panel.ts`. */
const VOICE_TOGGLE_MUTE_CHANNEL = 'dsh-voice:toggle-mute'
/** Mirrors the model snapshot channel in `voice-panel.ts`. */
const VOICE_MODELS_STATE_CHANNEL = 'dsh-voice:models-state'
/** Mirrors the model watch channel in `voice-panel.ts`. */
const VOICE_MODELS_WATCH_CHANNEL = 'dsh-voice:models-watch'
/** Mirrors the model action channel in `voice-panel.ts`. */
const VOICE_MODELS_ACTION_CHANNEL = 'dsh-voice:models-action'
/** Mirrors the pushed model snapshot channel in `voice-panel.ts`. */
const VOICE_MODELS_EVENT_CHANNEL = 'dsh-voice:models-event'

const api: VoicePanelApi = {
  protocolVersion: 1,
  state: () => ipcRenderer.invoke(VOICE_PANEL_CHANNEL) as Promise<VoicePanelState>,
  subscribe(listener) {
    const handle = (_event: Electron.IpcRendererEvent, state: VoicePanelState): void => { listener(state) }
    ipcRenderer.on(VOICE_PANEL_CHANNEL, handle)
    return () => { ipcRenderer.off(VOICE_PANEL_CHANNEL, handle) }
  },
  openSurface: (surface: VoiceSurfaceId) => ipcRenderer.invoke(VOICE_SURFACE_CHANNEL, surface) as Promise<void>,
  close: () => ipcRenderer.invoke(VOICE_CLOSE_CHANNEL) as Promise<void>,
  onToggleMute(listener) {
    const handle = (): void => { listener() }
    ipcRenderer.on(VOICE_TOGGLE_MUTE_CHANNEL, handle)
    return () => { ipcRenderer.off(VOICE_TOGGLE_MUTE_CHANNEL, handle) }
  },
}

/** @param action - action the Models pane requested. @param id - catalog entry it addresses. */
const sendModelAction = (action: VoiceModelsAction, id: string): Promise<void> =>
  ipcRenderer.invoke(VOICE_MODELS_ACTION_CHANNEL, { action, id }) as Promise<void>

const models: VoiceModelsApi = {
  protocolVersion: 1,
  state: () => ipcRenderer.invoke(VOICE_MODELS_STATE_CHANNEL) as Promise<unknown>,
  subscribe(listener) {
    const handle = (_event: Electron.IpcRendererEvent, snapshot: unknown): void => { listener(snapshot) }
    ipcRenderer.on(VOICE_MODELS_EVENT_CHANNEL, handle)
    // The shell holds the Host event stream only while a renderer watches it.
    void ipcRenderer.invoke(VOICE_MODELS_WATCH_CHANNEL, true)
    return () => {
      ipcRenderer.off(VOICE_MODELS_EVENT_CHANNEL, handle)
      void ipcRenderer.invoke(VOICE_MODELS_WATCH_CHANNEL, false)
    }
  },
  download: id => sendModelAction('download', id),
  cancel: id => sendModelAction('cancel', id),
  remove: id => sendModelAction('remove', id),
  activate: id => sendModelAction('activate', id),
}

contextBridge.exposeInMainWorld('dshVoicePanel', api)
contextBridge.exposeInMainWorld('dshVoiceModels', models)
