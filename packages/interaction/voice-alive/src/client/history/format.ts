/**
 * Row labels for the history list: the wall-clock time and the turn duration.
 * @module @deepseek-ai/dsh-voice-alive/client/history/format
 */

/**
 * Format an ISO date-time as the two-digit local time shown on a row.
 * @param at - ISO 8601 timestamp recorded on the entry.
 * @returns the entry's local `HH:MM` wall clock.
 */
export function formatTime(at: string): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * Format a turn length as `M:SS`.
 * @param durationMs - turn duration in milliseconds.
 * @returns the duration with a two-digit seconds field.
 */
export function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
