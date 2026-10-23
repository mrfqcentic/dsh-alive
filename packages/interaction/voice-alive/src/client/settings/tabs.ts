/**
 * Settings tab registry: the only module that lists the settings panes.
 *
 * A ticket that replaces one pane imports nothing from this file except its
 * `SettingsTab` contract; it changes that pane's component file and keeps the
 * export name, so this ordered list stays untouched.
 * @module @deepseek-ai/dsh-voice-alive/client/settings/tabs
 */
import type { ComponentType } from 'react'
import { copy } from './locales.ts'
import { AudioPane } from './panes/audio.tsx'
import { ModelsPane } from './panes/models.tsx'
import { PrivacyPane } from './panes/privacy.tsx'
import { ShortcutsPane } from './panes/shortcuts.tsx'
import { WorkspacesPane } from './panes/workspaces.tsx'

/** One settings tab: a stable id, its localized label, and the pane component. */
export interface SettingsTab {
  /** Stable id used for the URL, DOM ids, and the persisted selection. */
  readonly id: string
  /** Visible tab label. */
  readonly label: string
  /** Pane rendered inside the tab panel. */
  readonly Pane: ComponentType
}

/** Tabs in display order. The first entry is the default selection. */
export const SETTINGS_TABS = [
  { id: 'models', label: copy.tabs.models, Pane: ModelsPane },
  { id: 'workspaces', label: copy.tabs.workspaces, Pane: WorkspacesPane },
  { id: 'audio', label: copy.tabs.audio, Pane: AudioPane },
  { id: 'shortcuts', label: copy.tabs.shortcuts, Pane: ShortcutsPane },
  { id: 'privacy', label: copy.tabs.privacy, Pane: PrivacyPane },
] as const satisfies readonly SettingsTab[]

/** Identifier of one settings tab. */
export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']

/** Tab selected before the user has chosen one in this session. */
export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'models'

/**
 * Narrow an arbitrary stored value to a settings tab id.
 * @param value - value read from session storage, possibly null or stale.
 * @returns whether the value names a tab in {@link SETTINGS_TABS}.
 */
export function isSettingsTabId(value: string | null): value is SettingsTabId {
  return value !== null && SETTINGS_TABS.some(tab => tab.id === value)
}
