/**
 * English copy for the history window.
 *
 * The panel document has no locale service of its own, so this object is the
 * copy owner for the surface; the Client UI i18n check treats a `locales.ts`
 * module as the only legitimate place for product text. Like the panel and
 * settings dictionaries beside it, the object is not a registered locale
 * dictionary: naming it `en` would promise the other shipped languages.
 * @module @deepseek-ai/dsh-voice-alive/client/history/locales
 */

/** English history-window copy. */
export const copy = {
  'history.eyebrow': 'Voice turns',
  'history.title': 'History',
  'history.close': 'Close history',
  'history.retention': 'Audio kept 7 days · transcripts retained',
  'search.placeholder': 'Search transcripts or workspaces',
  'search.label': 'Search voice turns',
  'list.label': 'Voice turns',
  'count.of': 'of',
  'count.turn': 'turn',
  'count.turns': 'turns',
  'loading.label': 'Loading voice turns',
  'empty.title': 'No turns yet',
  'empty.body': 'Recorded turns appear here after your first spoken exchange.',
  'noResults.title': 'No turns match.',
  'noResults.body': 'Try a workspace, a session name, or a word from the transcript.',
  'error.title': 'Could not load history',
  'error.body': 'The turn list could not be read. Try again.',
  'error.retry': 'Retry',
  'row.audio': 'Audio',
  'row.showTranscript': 'Transcript',
  'row.hideTranscript': 'Hide',
  'row.delete': 'Delete',
  'delete.title': 'Delete this turn?',
  'delete.body': 'The transcript and any retained audio leave the history. This cannot be undone.',
  'delete.cancel': 'Cancel',
  'delete.confirm': 'Delete turn',
  'delete.failed': 'The turn could not be deleted. It is still in history.',
} as const

/** Key domain of the history-window dictionary. */
export type HistoryKey = keyof typeof copy

/**
 * Resolve one history-window label.
 * @param key - dictionary key owned by this module.
 * @returns the English label for that key.
 */
export function t(key: HistoryKey): string {
  return copy[key]
}
