// @vitest-environment jsdom
/** The history window renders turns, filters them, and confirms deletes against its source. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeHistoryWindow } from '../src/client/history/close.ts'
import { filterHistory } from '../src/client/history/filter.ts'
import { formatDuration, formatTime } from '../src/client/history/format.ts'
import { HistoryWindow } from '../src/client/history/HistoryWindow.tsx'
import { t } from '../src/client/history/locales.ts'
import { createHistorySource, type HistoryEntry, type HistorySource } from '../src/client/history/source.ts'
import { HistorySurface } from '../src/client/surfaces/history.tsx'

const ROWS: HistoryEntry[] = [
  {
    id: 'turn-a',
    at: '2026-10-23T14:32:00',
    workspace: 'Voice',
    session: 'Auth middleware',
    user: 'What changed in the auth middleware this morning?',
    assistant: 'The route guard now runs before the session lookup.',
    durationMs: 7000,
    hasAudio: true,
  },
  {
    id: 'turn-b',
    at: '2026-10-23T09:05:00',
    workspace: 'client-x',
    session: 'Billing refactor',
    user: 'Open client-x and continue the invoice work.',
    assistant: 'Two invoice tests still fail on rounding.',
    durationMs: 65000,
    hasAudio: false,
  },
]

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dshVoicePanel')
  vi.restoreAllMocks()
})

function sourceOf(
  rows: readonly HistoryEntry[],
  remove: HistorySource['remove'] = async () => undefined,
): HistorySource {
  return { list: async () => [...rows], remove }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Let the source promise and the resulting React update flush. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function countLabel(): string {
  return document.querySelector('[data-history-count]')?.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
}

function searchBox(): HTMLInputElement {
  const input = screen.getByRole('searchbox', { name: t('search.label') })
  if (!(input instanceof HTMLInputElement)) throw new Error('the history search field is not an input')
  return input
}

function rowHandles(): HTMLElement[] {
  return screen.getAllByRole('listitem')
}

describe('history helpers', () => {
  it('formats the wall-clock time and the turn duration', () => {
    expect(formatTime('2026-10-23T14:32:00')).toBe('14:32')
    expect(formatTime('2026-10-23T09:05:00')).toBe('09:05')
    expect(formatDuration(7000)).toBe('0:07')
    expect(formatDuration(65000)).toBe('1:05')
  })

  it('filters by transcript, workspace, and session, ignoring case and padding', () => {
    expect(filterHistory(ROWS)).toEqual(ROWS)
    expect(filterHistory(ROWS, '   ')).toEqual(ROWS)
    expect(filterHistory(ROWS, 'ROUTE GUARD').map(entry => entry.id)).toEqual(['turn-a'])
    expect(filterHistory(ROWS, 'voice').map(entry => entry.id)).toEqual(['turn-a', 'turn-b'])
    expect(filterHistory(ROWS, 'billing').map(entry => entry.id)).toEqual(['turn-b'])
    expect(filterHistory(ROWS, 'client-x').map(entry => entry.id)).toEqual(['turn-b'])
    expect(filterHistory(ROWS, 'nothing-matches')).toEqual([])
  })

  it('resolves every dictionary label', () => {
    expect(t('history.title')).toBe('History')
    expect(t('row.delete')).toBe('Delete')
  })

  it('serves deterministic fixture rows from independent sources', async () => {
    const source = createHistorySource()
    const all = await source.list()
    expect(all).toHaveLength(6)
    expect(all[0]).toMatchObject({ id: 'turn-01', at: '2026-10-23T14:32:00', hasAudio: true })
    expect(await source.list('billing')).toHaveLength(2)
    await source.remove('turn-01')
    expect(await source.list()).toHaveLength(5)
    await source.remove('missing-id')
    expect(await source.list()).toHaveLength(5)
    expect(await createHistorySource().list()).toHaveLength(6)
  })
})

describe('history window states', () => {
  it('shows the loading state until the source resolves, then renders every row', async () => {
    const pending = deferred<HistoryEntry[]>()
    const source: HistorySource = { list: () => pending.promise, remove: async () => undefined }
    render(<HistoryWindow source={source} onClose={vi.fn()} />)
    expect(screen.getByRole('status', { name: t('loading.label') })).toBeTruthy()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)

    pending.resolve(ROWS)
    await settle()

    expect(screen.queryByRole('status', { name: t('loading.label') })).toBeNull()
    const rows = rowHandles()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('14:32')
    expect(rows[0]?.textContent).toContain('Voice')
    expect(rows[0]?.textContent).toContain('Auth middleware')
    expect(rows[0]?.textContent).toContain('0:07')
    expect(rows[0]?.querySelector('[data-history-audio]')).not.toBeNull()
    expect(rows[1]?.textContent).toContain('09:05')
    expect(rows[1]?.textContent).toContain('1:05')
    expect(rows[1]?.querySelector('[data-history-audio]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
    expect(screen.queryByRole('slider')).toBeNull()
    expect(countLabel()).toBe('2 turns')
  })

  it('discards a list result that arrives after unmount', async () => {
    const pending = deferred<HistoryEntry[]>()
    const source: HistorySource = { list: () => pending.promise, remove: async () => undefined }
    const view = render(<HistoryWindow source={source} onClose={vi.fn()} />)
    view.unmount()
    await act(async () => {
      pending.resolve(ROWS)
      await pending.promise
    })
    expect(document.body.textContent).toBe('')
  })

  it('discards a list failure that arrives after unmount', async () => {
    const pending = deferred<HistoryEntry[]>()
    const source: HistorySource = { list: () => pending.promise, remove: async () => undefined }
    const view = render(<HistoryWindow source={source} onClose={vi.fn()} />)
    view.unmount()
    await act(async () => {
      pending.reject(new Error('late failure'))
      await pending.promise.catch(() => undefined)
    })
    expect(document.body.textContent).toBe('')
  })

  it('shows the error state and retries the load', async () => {
    const source: HistorySource = {
      list: vi.fn().mockRejectedValueOnce(new Error('unreadable')).mockResolvedValueOnce(ROWS),
      remove: async () => undefined,
    }
    render(<HistoryWindow source={source} onClose={vi.fn()} />)
    await settle()
    expect(screen.getByText(t('error.title'))).toBeTruthy()
    expect(screen.getByText(t('error.body'))).toBeTruthy()
    expect(countLabel()).toBe('')

    fireEvent.click(screen.getByRole('button', { name: t('error.retry') }))
    await settle()

    expect(screen.queryByText(t('error.title'))).toBeNull()
    expect(rowHandles()).toHaveLength(2)
  })

  it('shows the empty state when the source has no turns', async () => {
    render(<HistoryWindow source={sourceOf([])} onClose={vi.fn()} />)
    await settle()
    expect(screen.getByText(t('empty.title'))).toBeTruthy()
    expect(screen.getByText(t('empty.body'))).toBeTruthy()
    expect(countLabel()).toBe('0 turns')
  })

  it('reports the no-results state for a query that matches nothing', async () => {
    render(<HistoryWindow source={sourceOf(ROWS)} onClose={vi.fn()} />)
    await settle()
    fireEvent.change(searchBox(), { target: { value: 'nothing-matches' } })
    expect(screen.getByText(t('noResults.title'))).toBeTruthy()
    expect(screen.getByText(t('noResults.body'))).toBeTruthy()
    expect(countLabel()).toBe('0 of 2 turns')
  })
})

describe('history search and keyboard', () => {
  it('filters rows as the query changes and Escape clears the search before closing', async () => {
    const onClose = vi.fn()
    render(<HistoryWindow source={sourceOf(ROWS)} onClose={onClose} />)
    await settle()

    fireEvent.change(searchBox(), { target: { value: 'invoice' } })
    expect(rowHandles()).toHaveLength(1)
    expect(countLabel()).toBe('1 of 2 turns')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(searchBox().value).toBe('')
    expect(rowHandles()).toHaveLength(2)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('focuses search on / and leaves typing untouched', async () => {
    render(<HistoryWindow source={sourceOf(ROWS)} onClose={vi.fn()} />)
    await settle()
    const input = searchBox()

    fireEvent.keyDown(window, { key: '/' })
    expect(document.activeElement).toBe(input)

    const slash = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
    input.dispatchEvent(slash)
    expect(slash.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(input)
  })

  it('closes from the close button', async () => {
    const onClose = vi.fn()
    render(<HistoryWindow source={sourceOf(ROWS)} onClose={onClose} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: t('history.close') }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('moves the selection with arrow keys and clamps at both ends', async () => {
    render(<HistoryWindow source={sourceOf(ROWS)} onClose={vi.fn()} />)
    await settle()
    const rows = rowHandles()
    const [first, second] = rows
    if (first === undefined || second === undefined) throw new Error('the fixture rows did not render')

    fireEvent.keyDown(window, { key: 'a' })
    expect(first.getAttribute('aria-current')).toBeNull()

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(first.getAttribute('aria-current')).toBe('true')
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(second.getAttribute('aria-current')).toBe('true')
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(second.getAttribute('aria-current')).toBe('true')
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(first.getAttribute('aria-current')).toBe('true')
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(first.getAttribute('aria-current')).toBe('true')

    fireEvent.click(second)
    expect(second.getAttribute('aria-current')).toBe('true')
    expect(first.getAttribute('aria-current')).toBeNull()
  })

  it('ignores arrow keys while no row is listed', async () => {
    render(<HistoryWindow source={sourceOf([])} onClose={vi.fn()} />)
    await settle()
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(screen.getByText(t('empty.title'))).toBeTruthy()
  })
})

describe('history row actions', () => {
  it('expands and collapses the assistant transcript', async () => {
    render(<HistoryWindow source={sourceOf(ROWS)} onClose={vi.fn()} />)
    await settle()
    const first = rowHandles()[0]
    if (first === undefined) throw new Error('the fixture rows did not render')

    expect(within(first).queryByText(ROWS[0]?.assistant ?? '')).toBeNull()
    fireEvent.click(within(first).getByRole('button', { name: t('row.showTranscript') }))
    expect(within(first).getByText(ROWS[0]?.assistant ?? '')).toBeTruthy()
    expect(within(first).getByRole('button', { name: t('row.hideTranscript') }).getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(within(first).getByRole('button', { name: t('row.hideTranscript') }))
    expect(within(first).queryByText(ROWS[0]?.assistant ?? '')).toBeNull()
    expect(within(first).getByRole('button', { name: t('row.showTranscript') }).getAttribute('aria-expanded')).toBe('false')
  })

  it('collapses an expanded transcript when the query changes', async () => {
    render(<HistoryWindow source={sourceOf(ROWS)} onClose={vi.fn()} />)
    await settle()
    const first = rowHandles()[0]
    if (first === undefined) throw new Error('the fixture rows did not render')
    fireEvent.click(within(first).getByRole('button', { name: t('row.showTranscript') }))
    expect(within(first).getByText(ROWS[0]?.assistant ?? '')).toBeTruthy()

    fireEvent.change(searchBox(), { target: { value: 'auth' } })
    expect(within(first).queryByText(ROWS[0]?.assistant ?? '')).toBeNull()
  })

  it('cancels a delete without touching the source', async () => {
    const remove = vi.fn(async () => undefined)
    render(<HistoryWindow source={sourceOf(ROWS, remove)} onClose={vi.fn()} />)
    await settle()
    const first = rowHandles()[0]
    if (first === undefined) throw new Error('the fixture rows did not render')

    fireEvent.click(within(first).getByRole('button', { name: t('row.delete') }))
    expect(screen.getByRole('dialog', { name: t('delete.title') })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('delete.cancel') }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(remove).not.toHaveBeenCalled()
    expect(rowHandles()).toHaveLength(2)
  })

  it('closes the confirm dialog on Escape before clearing the search or closing', async () => {
    const onClose = vi.fn()
    render(<HistoryWindow source={sourceOf(ROWS)} onClose={onClose} />)
    await settle()
    fireEvent.change(searchBox(), { target: { value: 'invoice' } })
    const first = rowHandles()[0]
    if (first === undefined) throw new Error('the fixture rows did not render')

    fireEvent.click(within(first).getByRole('button', { name: t('row.delete') }))
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(searchBox().value).toBe('invoice')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('removes a turn optimistically after confirmation', async () => {
    const remove = vi.fn(async () => undefined)
    render(<HistoryWindow source={sourceOf(ROWS, remove)} onClose={vi.fn()} />)
    await settle()
    const first = rowHandles()[0]
    if (first === undefined) throw new Error('the fixture rows did not render')

    fireEvent.click(within(first).getByRole('button', { name: t('row.delete') }))
    fireEvent.click(screen.getByRole('button', { name: t('delete.confirm') }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(rowHandles()).toHaveLength(1)
    expect(countLabel()).toBe('1 turn')

    await settle()

    expect(remove).toHaveBeenCalledWith('turn-a')
    expect(rowHandles()).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('restores an optimistically removed turn when the delete fails', async () => {
    const remove = vi.fn(async () => { throw new Error('locked') })
    render(<HistoryWindow source={sourceOf(ROWS, remove)} onClose={vi.fn()} />)
    await settle()
    const rows = rowHandles()
    const second = rows[1]
    if (second === undefined) throw new Error('the fixture rows did not render')

    fireEvent.click(within(second).getByRole('button', { name: t('row.delete') }))
    fireEvent.click(screen.getByRole('button', { name: t('delete.confirm') }))
    expect(rowHandles()).toHaveLength(1)

    await settle()

    const restored = rowHandles()
    expect(restored).toHaveLength(2)
    expect(restored[0]?.getAttribute('data-entry-id')).toBe('turn-a')
    expect(restored[1]?.getAttribute('data-entry-id')).toBe('turn-b')
    expect(screen.getByRole('alert').textContent).toContain(t('delete.failed'))

    fireEvent.click(within(restored[1]!).getByRole('button', { name: t('row.delete') }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('collapses the transcript when its own turn is deleted', async () => {
    render(<HistoryWindow source={sourceOf(ROWS)} onClose={vi.fn()} />)
    await settle()
    const first = rowHandles()[0]
    if (first === undefined) throw new Error('the fixture rows did not render')
    fireEvent.click(within(first).getByRole('button', { name: t('row.showTranscript') }))
    fireEvent.click(within(first).getByRole('button', { name: t('row.delete') }))
    fireEvent.click(screen.getByRole('button', { name: t('delete.confirm') }))
    await settle()
    expect(rowHandles()).toHaveLength(1)
  })

  it('keeps a different expanded turn open when one row is deleted', async () => {
    render(<HistoryWindow source={sourceOf(ROWS)} onClose={vi.fn()} />)
    await settle()
    const rows = rowHandles()
    const first = rows[0]
    const second = rows[1]
    if (first === undefined || second === undefined) throw new Error('the fixture rows did not render')
    fireEvent.click(within(first).getByRole('button', { name: t('row.showTranscript') }))
    fireEvent.click(within(second).getByRole('button', { name: t('row.delete') }))
    fireEvent.click(screen.getByRole('button', { name: t('delete.confirm') }))
    await settle()
    expect(within(first).getByText(ROWS[0]?.assistant ?? '')).toBeTruthy()
  })
})

describe('history window close', () => {
  it('prefers the shell bridge close operation when it exists', () => {
    const close = vi.fn()
    const fallback = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    Object.defineProperty(window, 'dshVoicePanel', { value: { close }, configurable: true })

    closeHistoryWindow()

    expect(close).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back to window.close when the bridge is absent', () => {
    const fallback = vi.spyOn(window, 'close').mockImplementation(() => undefined)

    closeHistoryWindow()

    expect(fallback).toHaveBeenCalledOnce()
  })
})

describe('history surface', () => {
  it('renders the fixture and closes its window on Escape', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    const view = render(<HistorySurface surface="history" />)
    await settle()
    expect(view.container.querySelector('[data-voice-surface="history"]')).not.toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(6)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })
})
