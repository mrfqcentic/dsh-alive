/**
 * Monochrome line icons for the panel's two window controls.
 *
 * Both are decorative: the button around each one carries the accessible name.
 * The paths come from the approved prototype's sprite.
 * @module @deepseek-ai/dsh-voice-alive/client/panel/icons
 */
import type { ReactElement } from 'react'

/**
 * Render the settings gear.
 * @returns a decorative 16px line icon.
 */
export function SettingsIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.7" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.36 1.03V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.03-.36H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8.6 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .36-1.03V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 8.6c.12.37.35.7.65.94.3.24.67.37 1.05.36H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.1Z" />
    </svg>
  )
}

/**
 * Render the history clock.
 * @returns a decorative 16px line icon.
 */
export function HistoryIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.7" aria-hidden="true" focusable="false">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l3.2 2" />
    </svg>
  )
}
