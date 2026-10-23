// @vitest-environment jsdom
/** Models pane: readiness banner, per-state rows, progress, and actions. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { copy, formatModelProgress, formatModelSize } from '../src/client/settings/locales.ts'
import type {
  ModelCatalogSource,
  ModelRowView,
  ModelSnapshot,
} from '../src/client/settings/models-source.ts'
import { ModelsPane } from '../src/client/settings/panes/models.tsx'

afterEach(() => { cleanup() })

/** @param overrides - row fields to replace. @returns one valid catalog row. */
function row(overrides: Partial<ModelRowView> = {}): ModelRowView {
  return {
    id: 'kokoro',
    kind: 'tts',
    name: 'Kokoro test',
    summary: 'Required voice fixture.',
    languages: ['English'],
    required: true,
    bytes: 100_000_000,
    state: 'absent',
    receivedBytes: 0,
    failure: null,
    ...overrides,
  }
}

/** @param overrides - snapshot fields to replace. @returns one valid snapshot. */
function snapshot(overrides: Partial<ModelSnapshot> = {}): ModelSnapshot {
  return { rows: [row()], readiness: { ready: false, asr: null, tts: null, failure: null }, ...overrides }
}

/** Recording catalog source the pane renders in tests. */
interface FakeSource {
  readonly source: ModelCatalogSource
  readonly calls: string[]
  /** @param next - snapshot to publish to subscribers. */
  publish(next: ModelSnapshot): void
}

/**
 * Build the fake source.
 * @param initial - snapshot the pane reads first.
 * @param supported - whether the shell bridge exists.
 * @returns the source, its recorded calls, and a publisher.
 */
function fakeSource(initial: ModelSnapshot, supported = true): FakeSource {
  const calls: string[] = []
  const listeners = new Set<() => void>()
  let current = initial
  return {
    calls,
    source: {
      get supported() { return supported },
      snapshot: () => current,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      download: async (id) => { calls.push(`download:${id}`) },
      cancel: (id) => { calls.push(`cancel:${id}`) },
      remove: async (id) => { calls.push(`remove:${id}`) },
      activate: async (id) => { calls.push(`activate:${id}`) },
    },
    publish(next) {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * Resolve the list item that carries one row name.
 * @param name - catalog name shown in the row.
 * @returns the row element.
 */
function rowElement(name: string): HTMLElement {
  const element = screen.getByText(name).closest('li')
  if (element === null) throw new Error(`no row rendered for ${name}`)
  return element
}

it('renders the disconnected state when the shell has no model bridge', () => {
  render(<ModelsPane source={fakeSource(snapshot(), false).source} />)
  expect(screen.getByText(copy.models.badgeUnavailable)).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe(copy.models.bannerUnavailable)
  expect(screen.getByText(copy.models.disconnectedTitle)).toBeTruthy()
  expect(screen.getByText(copy.models.disconnectedBody)).toBeTruthy()
  expect(screen.queryAllByRole('button')).toHaveLength(0)
  expect(screen.getByText(copy.models.foot)).toBeTruthy()
})

it('renders the loading line before the host answers', () => {
  render(<ModelsPane source={fakeSource(snapshot({ rows: [] })).source} />)
  expect(screen.getByText(copy.models.loading)).toBeTruthy()
  expect(screen.getByText(copy.models.badgeBlocked)).toBeTruthy()
})

it('renders row metadata, the required tag, and the kind tag', () => {
  const { source } = fakeSource(snapshot({
    rows: [
      row(),
      row({ id: 'whisper-base', kind: 'asr', name: 'Whisper test', required: false, languages: ['Multilingual'] }),
    ],
  }))
  render(<ModelsPane source={source} />)

  const kokoro = rowElement('Kokoro test')
  expect(within(kokoro).getByText(copy.models.requiredTag)).toBeTruthy()
  expect(within(kokoro).getByText(copy.models.ttsTag)).toBeTruthy()
  expect(within(kokoro).getByText(formatModelSize(100_000_000))).toBeTruthy()
  expect(within(kokoro).getByText('English')).toBeTruthy()
  expect(within(kokoro).getByText(copy.models.stateAbsent)).toBeTruthy()

  const whisper = rowElement('Whisper test')
  expect(within(whisper).getByText(copy.models.alternativeTag)).toBeTruthy()
  expect(within(whisper).getByText(copy.models.asrTag)).toBeTruthy()
})

it('starts a download from a not-installed row', () => {
  const fake = fakeSource(snapshot())
  render(<ModelsPane source={fake.source} />)
  fireEvent.click(within(rowElement('Kokoro test')).getByRole('button', { name: copy.models.download }))
  expect(fake.calls).toEqual(['download:kokoro'])
})

it('shows progress and cancels a running download', () => {
  const fake = fakeSource(snapshot({ rows: [row({ state: 'downloading', receivedBytes: 50_000_000 })] }))
  render(<ModelsPane source={fake.source} />)
  const element = rowElement('Kokoro test')
  const bar = within(element).getByRole('progressbar')
  expect(bar.getAttribute('aria-valuenow')).toBe('50')
  expect(within(element).getByText(formatModelProgress(50_000_000, 100_000_000))).toBeTruthy()
  fireEvent.click(within(element).getByRole('button', { name: copy.models.cancel }))
  expect(fake.calls).toEqual(['cancel:kokoro'])
})

it('shows a zero percentage for a row whose size is not known yet', () => {
  const { source } = fakeSource(snapshot({ rows: [row({ state: 'downloading', bytes: 0, receivedBytes: 0 })] }))
  render(<ModelsPane source={source} />)
  expect(within(rowElement('Kokoro test')).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
})

it('shows an indeterminate bar while verifying and offers no action', () => {
  const { source } = fakeSource(snapshot({ rows: [row({ state: 'verifying' })] }))
  render(<ModelsPane source={source} />)
  const element = rowElement('Kokoro test')
  const bar = within(element).getByRole('progressbar')
  expect(bar.className).toContain('progress--indeterminate')
  expect(bar.getAttribute('aria-valuenow')).toBeNull()
  expect(within(element).queryAllByRole('button')).toHaveLength(0)
  expect(within(element).getByText(copy.models.stateVerifying)).toBeTruthy()
})

it('marks a ready row with a check mark and removes it', () => {
  const fake = fakeSource(snapshot({
    rows: [row({ state: 'ready', receivedBytes: 100_000_000 })],
    readiness: { ready: true, asr: 'whisper-base', tts: 'kokoro', failure: null },
  }))
  render(<ModelsPane source={fake.source} />)
  const element = rowElement('Kokoro test')
  expect(within(element).getByText(copy.models.checkMark)).toBeTruthy()
  expect(screen.getByText(copy.models.badgeReady)).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe(copy.models.bannerReady)
  fireEvent.click(within(element).getByRole('button', { name: copy.models.remove }))
  expect(fake.calls).toEqual(['remove:kokoro'])
})

const FAILURES: ReadonlyArray<readonly [string, string]> = [
  ['network', copy.models.failureNetwork],
  ['disk', copy.models.failureDisk],
  ['hash-mismatch', copy.models.failureHash],
  ['size-mismatch', copy.models.failureHash],
  ['unsupported-platform', copy.models.failurePlatform],
  ['cancelled', copy.models.failureCancelled],
]

it.each(FAILURES)('localizes the %s failure', (code, text) => {
  const { source } = fakeSource(snapshot({
    rows: [row({ state: 'error', failure: { code, message: 'host detail' } })],
  }))
  render(<ModelsPane source={source} />)
  expect(within(rowElement('Kokoro test')).getByText(text)).toBeTruthy()
})

it('retries a failed row and shows the host message for an unknown code', () => {
  const fake = fakeSource(snapshot({
    rows: [row({ state: 'error', failure: { code: 'quantum', message: 'Something new happened' } })],
  }))
  render(<ModelsPane source={fake.source} />)
  const element = rowElement('Kokoro test')
  expect(within(element).getByText('Something new happened')).toBeTruthy()
  fireEvent.click(within(element).getByRole('button', { name: copy.models.retry }))
  fireEvent.click(within(element).getByRole('button', { name: copy.models.remove }))
  expect(fake.calls).toEqual(['download:kokoro', 'remove:kokoro'])
})

it('offers an installed alternative for use and marks the entry readiness uses', () => {
  const fake = fakeSource(snapshot({
    rows: [
      row({ id: 'whisper-base', kind: 'asr', name: 'Whisper test', state: 'ready', receivedBytes: 100_000_000 }),
      row({ id: 'parakeet-v3', kind: 'asr', name: 'Parakeet test', state: 'ready', receivedBytes: 100_000_000 }),
    ],
    readiness: { ready: false, asr: 'whisper-base', tts: null, failure: { code: 'tts-missing', message: 'missing' } },
  }))
  render(<ModelsPane source={fake.source} />)

  const whisper = rowElement('Whisper test')
  expect(within(whisper).getByText(copy.models.activeTag)).toBeTruthy()
  expect(within(whisper).queryByRole('button', { name: copy.models.activate })).toBeNull()

  const parakeet = rowElement('Parakeet test')
  expect(within(parakeet).queryByText(copy.models.activeTag)).toBeNull()
  fireEvent.click(within(parakeet).getByRole('button', { name: copy.models.activate }))
  expect(fake.calls).toEqual(['activate:parakeet-v3'])
})

it('re-renders when the host pushes a new snapshot', () => {
  const fake = fakeSource(snapshot())
  render(<ModelsPane source={fake.source} />)
  expect(screen.getByText(copy.models.badgeBlocked)).toBeTruthy()
  act(() => {
    fake.publish(snapshot({
      rows: [row({ state: 'ready', receivedBytes: 100_000_000 })],
      readiness: { ready: true, asr: 'whisper-base', tts: 'kokoro', failure: null },
    }))
  })
  expect(screen.getByText(copy.models.badgeReady)).toBeTruthy()
  expect(within(rowElement('Kokoro test')).getByText(copy.models.stateReady)).toBeTruthy()
})

it('formats sizes in whole megabytes and one-decimal gigabytes', () => {
  expect(formatModelSize(0)).toBe('0 MB')
  expect(formatModelSize(160_609_290)).toBe('161 MB')
  expect(formatModelSize(2_500_000_000)).toBe('2.5 GB')
})

it('formats progress as a bounded percentage with transferred bytes', () => {
  expect(formatModelProgress(50_000_000, 100_000_000)).toBe('50% · 50 MB of 100 MB')
  expect(formatModelProgress(0, 0)).toBe('0% · 0 MB of 0 MB')
  expect(formatModelProgress(200, 100)).toBe('100% · 0 MB of 0 MB')
  expect(formatModelProgress(-1, 100)).toBe('0% · 0 MB of 0 MB')
})
