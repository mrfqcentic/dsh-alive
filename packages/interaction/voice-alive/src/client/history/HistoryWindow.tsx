/**
 * History window: the turn list, its search field, row actions, and the
 * loading, empty, and failure states.
 *
 * It renders whatever `HistorySource` it receives; the default fixture lives in
 * `./source.ts` until ticket 22 swaps the implementation behind the same
 * interface. Escape clears an active search before it asks the surface to close,
 * `/` focuses search, and the arrow keys move the selected row.
 * @module @deepseek-ai/dsh-voice-alive/client/history/HistoryWindow
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { filterHistory } from './filter.ts'
import { formatDuration, formatTime } from './format.ts'
import { t } from './locales.ts'
import type { HistoryEntry, HistorySource } from './source.ts'
import './history.css'

/** Where the panel document is in its load of the turn list. */
type LoadPhase = 'loading' | 'ready' | 'error'

/** Search glyph drawn inside the field; it carries no product copy. */
function SearchGlyph(): ReactElement {
  return (
    <svg className="voice-history-search-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </svg>
  )
}

/** Props the history surface supplies to the window. */
export interface HistoryWindowProps {
  /** Source of the turns listed and deleted. */
  readonly source: HistorySource
  /** Close the window; the surface wires this to the shell window. */
  readonly onClose: () => void
}

/**
 * Render the history window content.
 * @param props - the turn source and the close action.
 * @returns the complete history window for the panel document.
 */
export function HistoryWindow({ source, onClose }: HistoryWindowProps): ReactElement {
  const searchRef = useRef<HTMLInputElement>(null)
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(-1)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<HistoryEntry | null>(null)
  const [deleteFailed, setDeleteFailed] = useState(false)

  useEffect(() => {
    let active = true
    setPhase('loading')
    void source.list().then(
      (rows) => {
        if (!active) return
        setEntries(rows)
        setPhase('ready')
      },
      () => {
        if (active) setPhase('error')
      },
    )
    return () => { active = false }
  }, [source, attempt])

  const visible = filterHistory(entries, query)
  const searching = query.trim() !== ''

  useEffect(() => {
    /** @param delta - one row down (1) or up (-1). */
    const moveSelection = (delta: number): void => {
      if (visible.length === 0) return
      setSelected(current => Math.max(0, Math.min(visible.length - 1, current + delta)))
    }
    /** @param event - a keydown received anywhere in the panel document. */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === '/') {
        if (event.target instanceof HTMLInputElement) return
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (event.key === 'Escape') {
        if (pendingDelete !== null) {
          setPendingDelete(null)
          return
        }
        if (query !== '') {
          setQuery('')
          setSelected(-1)
          return
        }
        onClose()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveSelection(1)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveSelection(-1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [onClose, pendingDelete, query, visible.length])

  /**
   * Remove one turn optimistically and put it back when the source rejects.
   * @param target - the turn confirmed in the dialog.
   */
  const removeEntry = (target: HistoryEntry): void => {
    const index = entries.findIndex(entry => entry.id === target.id)
    const previous = entries
    setPendingDelete(null)
    setDeleteFailed(false)
    setEntries(previous.filter(entry => entry.id !== target.id))
    setExpanded(current => (current === target.id ? null : current))
    setSelected(-1)
    void source.remove(target.id).then(
      () => undefined,
      () => {
        setDeleteFailed(true)
        setEntries((current) => {
          const restored = [...current]
          restored.splice(Math.max(0, index), 0, target)
          return restored
        })
      },
    )
  }

  return (
    <section className="dialog voice-history-window" aria-label={t('history.title')}>
      <header className="voice-history-head">
        <div className="voice-history-heading">
          <span className="eyebrow">{t('history.eyebrow')}</span>
          <h2 className="voice-history-title">{t('history.title')}</h2>
        </div>
        <div className="input-wrap voice-history-search">
          <span className="adorn" aria-hidden="true"><SearchGlyph /></span>
          <input
            ref={searchRef}
            className="input"
            type="search"
            value={query}
            placeholder={t('search.placeholder')}
            aria-label={t('search.label')}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(-1)
              setExpanded(null)
            }}
          />
        </div>
        <button
          className="btn btn--sm btn--ghost voice-history-close"
          type="button"
          aria-label={t('history.close')}
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="voice-history-toolbar">
        <span className="voice-history-count" data-history-count="">
          {phase === 'ready'
            ? (
              <>
                <span className="mono">{visible.length}</span>
                {searching
                  ? <span> {t('count.of')} <span className="mono">{entries.length}</span></span>
                  : null}
                {' '}
                {(searching ? entries.length : visible.length) === 1 ? t('count.turn') : t('count.turns')}
              </>
            )
            : null}
        </span>
        <span className="voice-history-retention">{t('history.retention')}</span>
      </div>

      {deleteFailed
        ? <p className="alert voice-history-delete-error" role="alert"><span className="body">{t('delete.failed')}</span></p>
        : null}

      {phase === 'loading'
        ? (
          <div className="voice-history-loading" role="status" aria-label={t('loading.label')} aria-busy="true">
            {[0, 1, 2].map(row => (
              <div className="voice-history-skeleton" key={row}>
                <span className="skeleton voice-history-skeleton-time" />
                <span className="skeleton voice-history-skeleton-text" />
                <span className="skeleton voice-history-skeleton-action" />
              </div>
            ))}
          </div>
        )
        : phase === 'error'
          ? (
            <div className="voice-history-state">
              <div className="empty">
                <strong>{t('error.title')}</strong>
                <span>{t('error.body')}</span>
                <button
                  className="btn btn--sm"
                  type="button"
                  onClick={() => { setAttempt(value => value + 1) }}
                >
                  {t('error.retry')}
                </button>
              </div>
            </div>
          )
          : visible.length === 0
            ? (
              <div className="voice-history-state">
                <div className="empty">
                  <strong>{searching ? t('noResults.title') : t('empty.title')}</strong>
                  <span>{searching ? t('noResults.body') : t('empty.body')}</span>
                </div>
              </div>
            )
            : (
              <ul className="voice-history-list" role="list" aria-label={t('list.label')}>
                {visible.map((entry, index) => {
                  const isSelected = index === selected
                  const isExpanded = expanded === entry.id
                  return (
                    <li
                      key={entry.id}
                      className={isSelected ? 'history-row is-selected' : 'history-row'}
                      data-entry-id={entry.id}
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => { setSelected(index) }}
                    >
                      <time className="voice-history-time" dateTime={entry.at}>{formatTime(entry.at)}</time>
                      <div className="voice-history-body">
                        <p className="voice-history-text">{entry.user}</p>
                        <div className="voice-history-meta">
                          <span className="badge">{entry.workspace}</span>
                          <span>{entry.session}</span>
                          <span className="voice-history-dot" aria-hidden="true" />
                          <span className="mono">{formatDuration(entry.durationMs)}</span>
                          {entry.hasAudio ? <span className="badge" data-history-audio="">{t('row.audio')}</span> : null}
                        </div>
                        {isExpanded
                          ? (
                            <div className="voice-history-transcript">
                              <p className="voice-history-reply">{entry.assistant}</p>
                            </div>
                          )
                          : null}
                      </div>
                      <div className="voice-history-actions">
                        <button
                          className="btn btn--sm btn--ghost"
                          type="button"
                          aria-expanded={isExpanded}
                          onClick={(event) => {
                            event.stopPropagation()
                            setExpanded(isExpanded ? null : entry.id)
                          }}
                        >
                          {isExpanded ? t('row.hideTranscript') : t('row.showTranscript')}
                        </button>
                        <button
                          className="btn btn--sm btn--ghost"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            setDeleteFailed(false)
                            setPendingDelete(entry)
                          }}
                        >
                          {t('row.delete')}
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

      {pendingDelete !== null
        ? (
          <div className="voice-history-confirm">
            <div
              className="dialog voice-history-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="voice-history-delete-title"
            >
              <header className="dialog-head">
                <h2 className="dialog-title" id="voice-history-delete-title">{t('delete.title')}</h2>
              </header>
              <div className="dialog-body">{t('delete.body')}</div>
              <div className="dialog-foot">
                <button
                  className="btn btn--sm btn--ghost"
                  type="button"
                  autoFocus={true}
                  onClick={() => { setPendingDelete(null) }}
                >
                  {t('delete.cancel')}
                </button>
                <button
                  className="btn btn--sm btn--danger"
                  type="button"
                  onClick={() => { removeEntry(pendingDelete) }}
                >
                  {t('delete.confirm')}
                </button>
              </div>
            </div>
          </div>
        )
        : null}
    </section>
  )
}
