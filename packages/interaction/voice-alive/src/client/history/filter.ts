/**
 * Local turn search. The history window calls this over the rows it loaded;
 * ticket 22 moves the same predicate behind `HistorySource.list`.
 * @module @deepseek-ai/dsh-voice-alive/client/history/filter
 */
import type { HistoryEntry } from './source.ts'

/** Entry fields a query is matched against; transcripts first, then the row labels. */
const SEARCH_FIELDS = ['user', 'assistant', 'workspace', 'session'] as const

/**
 * Match entries against a case-insensitive substring of a transcript, workspace, or session.
 * @param entries - rows to filter.
 * @param query - raw text from the search field; blank returns every row.
 * @returns matching rows in their original order.
 */
export function filterHistory(entries: readonly HistoryEntry[], query = ''): HistoryEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...entries]
  return entries.filter(entry =>
    SEARCH_FIELDS.some(field => entry[field].toLowerCase().includes(needle)))
}
