/** Echo guard: reference cancellation, half-duplex tail, path delay, and the semantic gate. */
import { expect, it } from 'vitest'
import { createEchoGuard, type EchoGuard } from '../src/client/audio/echo.ts'
import { FRAME_SAMPLES } from '../src/client/audio/vad.ts'
import { createFakeEchoReference, pcm, type FakeEchoReference } from './audio-fakes.client.ts'

/** Levels with enough spread for the path-delay correlation to align. */
const PATTERN = [0.02, 0.09, 0.04, 0.11, 0.03, 0.08, 0.05, 0.12, 0.06, 0.1]

/**
 * Prime the guard with one sounding block, then drain the reference.
 * The drain block that detects silence starts the tail and is itself
 * discarded, so the caller has one block less than the full window left.
 * @param guard - guard under test.
 * @param tap - reference fixture the guard attached.
 * @returns nothing.
 */
function drain(guard: EchoGuard, tap: FakeEchoReference): void {
  tap.level = 0.2
  expect(guard.suppress(pcm(0.1))).toBe(true)
  tap.level = 0
  expect(guard.suppress(pcm(0))).toBe(true)
  expect(guard.suppress(pcm(0))).toBe(true)
  expect(guard.suppress(pcm(0))).toBe(true)
}

it('suppresses self-audio read from the attached reference', () => {
  const tap = createFakeEchoReference()
  const guard = createEchoGuard()
  guard.attach(tap.node)
  tap.level = 0.2
  expect(guard.suppress(pcm(0.1))).toBe(true)
  expect(guard.suppress(pcm(0.1))).toBe(true)
})

it('passes distinct, energetic speech above the predicted echo', () => {
  const tap = createFakeEchoReference()
  const guard = createEchoGuard()
  guard.attach(tap.node)
  tap.level = 0.3
  for (let block = 0; block < 8; block += 1) expect(guard.suppress(pcm(0.15))).toBe(true)
  // Echo level settled near 0.15; a 0.5 barge-in is clearly above the residual.
  expect(guard.suppress(pcm(0.5))).toBe(false)
})

it('does not suppress without a reference or with an unusable one', () => {
  const guard = createEchoGuard()
  expect(guard.suppress(pcm(0.5))).toBe(false)
  expect(guard.suppress(new Int16Array(0))).toBe(false)

  const tap = createFakeEchoReference()
  guard.attach(tap.node)
  tap.level = Number.NaN
  expect(guard.suppress(pcm(0.5))).toBe(false)
})

it('holds the default 225 ms tail after the reference drains', () => {
  const tap = createFakeEchoReference()
  const guard = createEchoGuard()
  guard.attach(tap.node)
  drain(guard, tap)
  for (let block = 0; block < 11; block += 1) expect(guard.suppress(pcm(0.4))).toBe(true)
  expect(guard.suppress(pcm(0.4))).toBe(false)
})

it('clamps the tail to the 200-250 ms window', () => {
  const shortTap = createFakeEchoReference()
  const short = createEchoGuard({ tailMs: 50 })
  short.attach(shortTap.node)
  drain(short, shortTap)
  for (let block = 0; block < 9; block += 1) expect(short.suppress(pcm(0.4))).toBe(true)
  expect(short.suppress(pcm(0.4))).toBe(false)

  const longTap = createFakeEchoReference()
  const long = createEchoGuard({ tailMs: 1000 })
  long.attach(longTap.node)
  drain(long, longTap)
  for (let block = 0; block < 12; block += 1) expect(long.suppress(pcm(0.4))).toBe(true)
  expect(long.suppress(pcm(0.4))).toBe(false)
})

it('charges the tail per frame of a long block rather than per call', () => {
  const tap = createFakeEchoReference()
  const guard = createEchoGuard()
  guard.attach(tap.node)
  drain(guard, tap)
  // Eleven silent frames cover the remaining 205 ms of the 225 ms tail, so the
  // whole block is muted and the tail ends inside it.
  expect(guard.suppress(pcm(0, FRAME_SAMPLES * 11))).toBe(true)
  expect(guard.suppress(pcm(0))).toBe(false)
})

it('treats a long block as echo only when every frame in it is echo', () => {
  const tap = createFakeEchoReference()
  const guard = createEchoGuard()
  guard.attach(tap.node)
  tap.level = 0.2
  expect(guard.suppress(pcm(0.1, FRAME_SAMPLES * 10))).toBe(true)
  // A closed segment that ends with a loud frame is a turn, not echo.
  const mixed = pcm(0.1, FRAME_SAMPLES * 21)
  mixed.fill(Math.round(0.6 * 32767), FRAME_SAMPLES * 20)
  expect(guard.suppress(mixed)).toBe(false)
})

it('attaches once per node, reattaches, and detaches', () => {
  const first = createFakeEchoReference()
  const second = createFakeEchoReference()
  const guard = createEchoGuard()
  guard.attach(null)
  guard.attach(first.node)
  expect(first.connect).toHaveBeenCalledTimes(1)
  expect(first.analyser.fftSize).toBe(1024)
  guard.attach(first.node)
  expect(first.connect).toHaveBeenCalledTimes(1)
  guard.attach(second.node)
  expect(first.disconnect).toHaveBeenCalledWith(first.analyser)
  expect(second.connect).toHaveBeenCalledTimes(1)
  guard.attach(null)
  expect(second.disconnect).toHaveBeenCalledWith(second.analyser)
  expect(guard.suppress(pcm(0.5))).toBe(false)
})

it('clears history and filter state on reset but keeps the tap', () => {
  const tap = createFakeEchoReference()
  const guard = createEchoGuard()
  guard.attach(tap.node)
  guard.noteSpoken('the quick brown fox jumps over the lazy dog')
  tap.level = 0.2
  expect(guard.suppress(pcm(0.1))).toBe(true)
  guard.reset()
  expect(guard.reject('the quick brown fox jumps over the lazy dog')).toBe(false)
  // The reference is still read; the filter starts over from its initial gain.
  expect(guard.suppress(pcm(0.5))).toBe(false)
})

it('learns a path delay so delayed echo does not become barge-in', () => {
  const tap = createFakeEchoReference()
  const guard = createEchoGuard()
  guard.attach(tap.node)
  const passed: number[] = []
  for (let block = 0; block < 60; block += 1) {
    tap.level = PATTERN[block % PATTERN.length]!
    const echo = block >= 3 ? 0.5 * PATTERN[(block - 3) % PATTERN.length]! : 0
    if (!guard.suppress(pcm(echo))) passed.push(block)
  }
  expect(passed.filter(block => block >= 50)).toEqual([])
})

it('keeps the current delay when the reference does not vary', () => {
  const tap = createFakeEchoReference()
  const guard = createEchoGuard()
  guard.attach(tap.node)
  tap.level = 0.1
  for (let block = 0; block < 40; block += 1) expect(guard.suppress(pcm(0.05))).toBe(true)
})

it('handles silent capture and zero reference windows in the delay search', () => {
  const silentCapture = createFakeEchoReference()
  const guard = createEchoGuard()
  guard.attach(silentCapture.node)
  for (let block = 0; block < 40; block += 1) {
    silentCapture.level = PATTERN[block % PATTERN.length]!
    expect(guard.suppress(pcm(0))).toBe(true)
  }

  const lateStart = createFakeEchoReference()
  const late = createEchoGuard()
  late.attach(lateStart.node)
  for (let block = 0; block < 36; block += 1) {
    lateStart.level = 0
    late.suppress(pcm(0))
  }
  for (let block = 0; block < 5; block += 1) {
    lateStart.level = 0.2
    expect(late.suppress(pcm(0.1))).toBe(true)
  }
})

it('skips gain adaptation when the delayed reference is silent', () => {
  const tap = createFakeEchoReference()
  const guard = createEchoGuard()
  guard.attach(tap.node)
  for (let block = 0; block < 60; block += 1) {
    tap.level = PATTERN[block % PATTERN.length]!
    const echo = block >= 3 ? 0.5 * PATTERN[(block - 3) % PATTERN.length]! : 0
    guard.suppress(pcm(echo))
  }
  for (let block = 0; block < 15; block += 1) {
    tap.level = 0
    guard.suppress(pcm(0))
  }
  tap.level = 0.2
  expect(guard.suppress(pcm(0))).toBe(true)
})

it('rejects a near-identical transcript despite case, punctuation, digits, and spacing', () => {
  const guard = createEchoGuard()
  guard.noteSpoken('Set a timer for 5 minutes, please.')
  expect(guard.reject('SET  A TIMER FOR FIVE MINUTES PLEASE')).toBe(true)
})

it('rejects a drifted transcript of the same sentence', () => {
  const guard = createEchoGuard()
  guard.noteSpoken('The quick brown fox jumps over the lazy dog.')
  expect(guard.reject('the quick brown fox jumped over the lazy dog')).toBe(true)
})

it('accepts a distinct user question that shares the reply grammar', () => {
  const guard = createEchoGuard()
  guard.noteSpoken('What is the time in Berlin?')
  expect(guard.reject('what is the weather tomorrow')).toBe(false)
})

it('accepts short backchannels as genuine barge-ins', () => {
  const guard = createEchoGuard()
  guard.noteSpoken('Yes. No. Stop. Please wait.')
  expect(guard.reject('yes')).toBe(false)
  expect(guard.reject('No, stop.')).toBe(false)
  expect(guard.reject('yes yes yes yes')).toBe(false)
})

it('compares against recentText and empty spoken entries', () => {
  const guard = createEchoGuard({ recentText: () => ['The meeting is at noon', '   '] })
  expect(guard.reject('the meeting is at noon')).toBe(true)
  expect(guard.reject('hello')).toBe(false)

  const emptyText = createEchoGuard({ recentText: () => [''] })
  expect(emptyText.reject('hello')).toBe(false)
})

it('falls back to full tokens when an utterance has no content words', () => {
  const guard = createEchoGuard()
  guard.noteSpoken('It is.')
  expect(guard.reject('it is')).toBe(true)
  expect(guard.reject('the weather')).toBe(false)
})

it('ignores empty transcripts and empty spoken notes', () => {
  const guard = createEchoGuard()
  guard.noteSpoken('   ')
  expect(guard.reject('')).toBe(false)
  expect(guard.reject('   ')).toBe(false)
  expect(guard.reject('the quick brown fox jumps')).toBe(false)
})

it('counts repeated tokens and bounds the spoken history', () => {
  const guard = createEchoGuard()
  guard.noteSpoken('the cat the cat')
  expect(guard.reject('cat cat')).toBe(true)

  const bounded = createEchoGuard()
  const sentences = [
    'zulu yankee xray',
    'alfa bravo charlie',
    'delta golf hotel',
    'india juliet kilo',
    'lima mike november',
    'oscar papa quebec',
    'romeo sierra tango',
    'uniform victor whiskey',
    'fox six seven',
  ]
  for (const sentence of sentences) bounded.noteSpoken(sentence)
  expect(bounded.reject('zulu yankee xray')).toBe(false)
  expect(bounded.reject('fox six seven')).toBe(true)
})

it('uses the configured semantic threshold', () => {
  const strict = createEchoGuard({ threshold: 1 })
  strict.noteSpoken('The quick brown fox jumps over the lazy dog.')
  expect(strict.reject('the quick brown fox jumped over the lazy dog')).toBe(false)
  expect(strict.reject('the quick brown fox jumps over the lazy dog')).toBe(true)
})
