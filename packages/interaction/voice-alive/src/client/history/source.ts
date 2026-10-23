/**
 * Turn-history data seam for the history window.
 *
 * The window renders `HistorySource`; ticket 22 replaces
 * `createHistorySource` with the SQLite index and keeps this interface,
 * so the surface code does not change when rows move out of memory.
 * @module @deepseek-ai/dsh-voice-alive/client/history/source
 */
import { filterHistory } from './filter.ts'

/** One recorded voice turn. */
export interface HistoryEntry {
  /** Stable row id; the delete call addresses the turn by this value. */
  id: string
  /** ISO 8601 date-time the turn was recorded at. */
  at: string
  /** Workspace label shown beside the session. */
  workspace: string
  /** Session title the turn belongs to. */
  session: string
  /** Recognized user transcript. */
  user: string
  /** Reply text the assistant spoke for the turn. */
  assistant: string
  /** Turn length in milliseconds. */
  durationMs: number
  /** Whether the recording still exists; rendered as a badge, never played here. */
  hasAudio: boolean
}

/** Read and delete the turns shown in the history window. */
export interface HistorySource {
  /**
   * List recorded turns.
   * @param query - optional search text; omitted lists every retained turn.
   * @returns matching turns, newest first.
   */
  list(query?: string): Promise<HistoryEntry[]>
  /**
   * Delete one turn and its retained audio.
   * @param id - id of the turn to remove.
   * @returns a promise that rejects when the turn could not be deleted.
   */
  remove(id: string): Promise<void>
}

/** Deterministic rows used until ticket 22's store replaces the fixture. */
const FIXTURE_ENTRIES: readonly HistoryEntry[] = [
  {
    id: 'turn-01',
    at: '2026-10-23T14:32:00',
    workspace: 'Voice',
    session: 'Auth middleware',
    user: 'What changed in the auth middleware this morning?',
    assistant: 'The route guard now runs before the session lookup. Missing or malformed tokens return 401 before the store is touched. The middleware test table is green.',
    durationMs: 7000,
    hasAudio: true,
  },
  {
    id: 'turn-02',
    at: '2026-10-23T14:21:00',
    workspace: 'client-x',
    session: 'Billing refactor',
    user: 'Open client-x and continue the invoice work.',
    assistant: 'client-x is open. Two invoice tests still fail on rounding because the subtotal switched to Number. The workspace stays local.',
    durationMs: 4000,
    hasAudio: true,
  },
  {
    id: 'turn-03',
    at: '2026-10-23T13:58:00',
    workspace: 'Voice',
    session: 'Voice',
    user: 'Read that last answer again, slower.',
    assistant: 'Reading the last answer again at a slower pace. The queue is empty now.',
    durationMs: 3000,
    hasAudio: false,
  },
  {
    id: 'turn-04',
    at: '2026-10-23T12:40:00',
    workspace: 'Harness',
    session: 'Voice plugin spec',
    user: 'Summarise the decisions we made about the panel.',
    assistant: 'Panel is 268 px, glass, and above windows. Option+Space toggles mute. History holds the only text. Models are local and required before voice starts.',
    durationMs: 6000,
    hasAudio: true,
  },
  {
    id: 'turn-05',
    at: '2026-10-23T11:12:00',
    workspace: 'client-x',
    session: 'Billing refactor',
    user: 'Run the tests and tell me what fails.',
    assistant: 'Two failures, both invoice rounding. 41 tests pass, 2 fail, 0 skipped. The failures share the subtotal path.',
    durationMs: 5000,
    hasAudio: true,
  },
  {
    id: 'turn-06',
    at: '2026-10-23T09:47:00',
    workspace: 'Voice',
    session: 'Voice',
    user: 'New conversation. I want to plan the release.',
    assistant: 'Three gates before the release: required models verify on a clean install, the shortcut is confirmed, and privacy stays local-first.',
    durationMs: 4000,
    hasAudio: false,
  },
]

/**
 * Create the source the history window renders.
 *
 * It currently returns a deterministic in-memory fixture; ticket 22 replaces
 * this implementation with the SQLite index and keeps the export and the
 * `HistorySource` interface. Each source owns its rows, so a remounted window
 * starts again from the fixture and a delete never mutates a shared table.
 * @returns a source whose rows and timestamps are fixed for its lifetime.
 */
export function createHistorySource(): HistorySource {
  let entries = [...FIXTURE_ENTRIES]
  return {
    async list(query) {
      return filterHistory(entries, query)
    },
    async remove(id) {
      entries = entries.filter(entry => entry.id !== id)
    },
  }
}
