/** Session-scoped persistence of the selected settings tab. */
import { DEFAULT_SETTINGS_TAB, isSettingsTabId, type SettingsTabId } from './tabs.ts'

/** Session storage key for the selected settings tab. */
export const SETTINGS_TAB_STORAGE_KEY = 'dsh.voice-alive.settings-tab'

/**
 * Read the tab selected earlier in this session.
 * @returns the stored tab, or the default tab when storage is empty, stale, or unavailable.
 */
export function readActiveSettingsTab(): SettingsTabId {
  try {
    const stored = window.sessionStorage.getItem(SETTINGS_TAB_STORAGE_KEY)
    return isSettingsTabId(stored) ? stored : DEFAULT_SETTINGS_TAB
  } catch (_storageUnavailable) {
    return DEFAULT_SETTINGS_TAB
  }
}

/**
 * Remember the selected tab for the rest of this session, so closing and
 * reopening the settings window returns to it.
 * @param tab - the tab to restore on the next mount.
 */
export function storeActiveSettingsTab(tab: SettingsTabId): void {
  try {
    window.sessionStorage.setItem(SETTINGS_TAB_STORAGE_KEY, tab)
  } catch (_storageUnavailable) {
    // A private or sandboxed session keeps the selection only for this mount.
  }
}
