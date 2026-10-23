/** Audio state machine: transitions, mute in every state, barge-in, failures, and teardown. */
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { createEchoGuard, type EchoGuard } from '../src/client/audio/echo.ts'
import { createAudioMachine, type AudioMachine, type AudioMachineDeps, type AudioState } from '../src/client/audio/machine.ts'
import type { PlaybackChunk } from '../src/client/audio/playback.ts'
import type { SpeechSegment } from '../src/client/audio/types.ts'
import { createPanelState, type PanelStateStore } from '../src/client/panel/state.ts'
import {
  createFakeCapture,
  createFakeEchoGuard,
  createFakeEchoReference,
  createFakePlayback,
  namedError,
  pcm,
  playbackChunk,
  speechSegment,
  type FakeCapture,
  type FakePlayback,
} from './audio-fakes.client.ts'

/** One machine and the doubles it drives. */
interface Harness {
  readonly machine: AudioMachine
  readonly capture: FakeCapture
  readonly playback: FakePlayback
  readonly store: PanelStateStore
  readonly respond: Mock<(segment: SpeechSegment) => Promise<readonly PlaybackChunk[]>>
  /** States the machine's `onState` observers received. */
  readonly states: AudioState[]
}

const machines: AudioMachine[] = []

function setup(options: {
  muted?: boolean
  transcript?: boolean
  echo?: EchoGuard
  echoReference?: AudioNode
} = {}): Harness {
  const capture = createFakeCapture()
  const playback = createFakePlayback(
    options.echoReference === undefined ? {} : { echoReference: options.echoReference },
  )
  const store = createPanelState(options.muted === false ? 'listening' : 'muted')
  const respond = vi.fn(async (_segment: SpeechSegment): Promise<readonly PlaybackChunk[]> => [])
  const deps: AudioMachineDeps = { capture: capture.controller, playback: playback.controller, store }
  if (options.transcript !== true) deps.respond = respond
  if (options.echo !== undefined) deps.echo = options.echo
  const machine = createAudioMachine(deps)
  const states: AudioState[] = []
  machine.onState(state => states.push(state))
  machines.push(machine)
  return { machine, capture, playback, store, respond, states }
}

/** Drain the microtask chain a turn walks. */
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

/** Start unmuted and enter speaking with one chunk queued. */
async function speaking(h: Harness): Promise<void> {
  h.respond.mockResolvedValue([playbackChunk('reply')])
  await h.machine.start()
  h.capture.emitSegment(speechSegment(1))
  await flush()
  expect(h.machine.state).toBe('speaking')
}

afterEach(() => {
  for (const machine of machines.splice(0)) machine.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('starts muted when the store is muted and leaves capture alone', async () => {
  const h = setup()
  await h.machine.start()
  expect(h.machine.state).toBe('muted')
  expect(h.store.get()).toBe('muted')
  expect(h.capture.start).not.toHaveBeenCalled()
})

it('starts listening and acquires capture when the store is unmuted', async () => {
  const h = setup({ muted: false })
  await h.machine.start()
  expect(h.machine.state).toBe('listening')
  expect(h.store.get()).toBe('listening')
  expect(h.capture.start).toHaveBeenCalledTimes(1)
  expect(h.states).toEqual(['listening'])
})

it('wires capture and the store once across repeated starts', async () => {
  const h = setup({ muted: false })
  await h.machine.start()
  await h.machine.start()
  expect(h.capture.segmentListeners).toBe(1)
  expect(h.capture.errorListeners).toBe(1)
})

it('walks listening, thinking, speaking, and back to listening for a spoken reply', async () => {
  const h = setup({ muted: false })
  const published: AudioState[] = []
  h.store.subscribe(state => published.push(state))
  h.respond.mockResolvedValue([playbackChunk('first'), playbackChunk('second')])
  await h.machine.start()
  h.capture.emitSegment(speechSegment(7))
  expect(h.machine.state).toBe('thinking')
  expect(h.respond).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }))
  await flush()
  expect(h.machine.state).toBe('speaking')
  expect(h.playback.enqueued.map(chunk => chunk.id)).toEqual(['first', 'second'])
  h.playback.drain()
  await flush()
  expect(h.machine.state).toBe('listening')
  expect(h.store.get()).toBe('listening')
  expect(published).toEqual(['thinking', 'speaking', 'listening'])
})

it('returns to listening when the reply is empty', async () => {
  const h = setup({ muted: false })
  h.respond.mockResolvedValue([])
  await h.machine.start()
  h.capture.emitSegment(speechSegment())
  await flush()
  expect(h.machine.state).toBe('listening')
  expect(h.playback.enqueued).toEqual([])
  expect(h.states).toEqual(['listening', 'thinking', 'listening'])
})

it('closes a transcript-only turn without a reply', async () => {
  const h = setup({ muted: false, transcript: true })
  await h.machine.start()
  h.capture.emitSegment(speechSegment())
  expect(h.machine.state).toBe('listening')
  expect(h.states).toEqual(['listening', 'thinking', 'listening'])
  expect(h.playback.enqueued).toEqual([])
})

it('follows playback level only while speaking', async () => {
  const h = setup({ muted: false })
  h.respond.mockResolvedValue([playbackChunk('reply')])
  h.playback.setLevel(0.4)
  await h.machine.start()
  expect(h.machine.getLevel()).toBe(0)
  h.capture.emitSegment(speechSegment())
  expect(h.machine.getLevel()).toBe(0)
  await flush()
  expect(h.machine.getLevel()).toBe(0.4)
  h.playback.setLevel(0.9)
  expect(h.machine.getLevel()).toBe(0.9)
  h.playback.drain()
  await flush()
  expect(h.machine.getLevel()).toBe(0)
})

it('drops a segment that arrives while thinking', async () => {
  const h = setup({ muted: false })
  const reply = Promise.withResolvers<readonly PlaybackChunk[]>()
  h.respond.mockReturnValue(reply.promise)
  await h.machine.start()
  h.capture.emitSegment(speechSegment(1))
  h.capture.emitSegment(speechSegment(2))
  expect(h.machine.state).toBe('thinking')
  expect(h.respond).toHaveBeenCalledTimes(1)
  reply.resolve([])
  await flush()
  expect(h.machine.state).toBe('listening')
})

it('treats a segment while speaking as a barge-in', async () => {
  const h = setup({ muted: false })
  const first = Promise.withResolvers<readonly PlaybackChunk[]>()
  const second = Promise.withResolvers<readonly PlaybackChunk[]>()
  h.respond.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  await h.machine.start()
  h.capture.emitSegment(speechSegment(1))
  first.resolve([playbackChunk('one')])
  await flush()
  expect(h.machine.state).toBe('speaking')

  h.capture.emitSegment(speechSegment(2))
  expect(h.playback.stop).toHaveBeenCalledTimes(1)
  expect(h.machine.state).toBe('thinking')
  second.resolve([playbackChunk('two')])
  await flush()
  expect(h.machine.state).toBe('speaking')
  expect(h.playback.enqueued.map(chunk => chunk.id)).toEqual(['one', 'two'])
  h.playback.drain()
  await flush()
  expect(h.machine.state).toBe('listening')
})

it('cancels the turn and drops the late reply when muted while thinking', async () => {
  const h = setup({ muted: false })
  const reply = Promise.withResolvers<readonly PlaybackChunk[]>()
  h.respond.mockReturnValue(reply.promise)
  await h.machine.start()
  h.capture.emitSegment(speechSegment())
  expect(h.machine.state).toBe('thinking')

  h.machine.setMuted(true)
  expect(h.machine.state).toBe('muted')
  expect(h.playback.stop).toHaveBeenCalledTimes(1)
  expect(h.capture.setMuted).toHaveBeenCalledWith(true)

  reply.resolve([playbackChunk('late')])
  await flush()
  expect(h.playback.enqueued).toEqual([])
  expect(h.machine.state).toBe('muted')
})

it('cuts the speaker when muted while speaking', async () => {
  const h = setup({ muted: false })
  await speaking(h)
  h.machine.setMuted(true)
  expect(h.machine.state).toBe('muted')
  expect(h.playback.stop).toHaveBeenCalledTimes(1)
  await flush()
  expect(h.machine.state).toBe('muted')
})

it('makes mute idempotent when already muted', async () => {
  const h = setup()
  await h.machine.start()
  h.machine.setMuted(true)
  expect(h.capture.setMuted).not.toHaveBeenCalled()
  expect(h.playback.stop).not.toHaveBeenCalled()
  expect(h.machine.state).toBe('muted')
})

it('unmutes to listening and re-acquires capture', async () => {
  const h = setup()
  await h.machine.start()
  h.machine.setMuted(false)
  expect(h.machine.state).toBe('listening')
  expect(h.capture.setMuted).toHaveBeenCalledWith(false)
  expect(h.capture.start).toHaveBeenCalledTimes(1)
  await flush()
  expect(h.machine.state).toBe('listening')
})

it('unmutes without acquiring capture before start', () => {
  const h = setup()
  h.machine.setMuted(false)
  expect(h.machine.state).toBe('listening')
  expect(h.capture.setMuted).not.toHaveBeenCalled()
  expect(h.capture.start).not.toHaveBeenCalled()
})

it('toggles mute in both directions', async () => {
  const h = setup()
  await h.machine.start()
  h.machine.toggleMute()
  expect(h.machine.state).toBe('listening')
  h.machine.toggleMute()
  expect(h.machine.state).toBe('muted')
})

it('follows the panel store mute and unmute writes', async () => {
  const h = setup({ muted: false })
  await h.machine.start()
  h.store.set('muted')
  expect(h.machine.state).toBe('muted')
  expect(h.capture.setMuted).toHaveBeenCalledWith(true)
  h.store.set('listening')
  expect(h.machine.state).toBe('listening')
  expect(h.capture.setMuted).toHaveBeenLastCalledWith(false)
})

it('ignores external states that are not mute commands', async () => {
  const h = setup()
  await h.machine.start()
  h.store.set('thinking')
  expect(h.machine.state).toBe('muted')
  h.store.set('listening')
  expect(h.machine.state).toBe('listening')
  h.store.set('speaking')
  expect(h.machine.state).toBe('listening')
  h.store.set('error')
  expect(h.machine.state).toBe('listening')
  h.store.set('muted')
  expect(h.machine.state).toBe('muted')
})

it('lets the store mute cancel a turn that is thinking', async () => {
  const h = setup({ muted: false })
  const reply = Promise.withResolvers<readonly PlaybackChunk[]>()
  h.respond.mockReturnValue(reply.promise)
  await h.machine.start()
  h.capture.emitSegment(speechSegment())
  h.store.set('muted')
  reply.resolve([playbackChunk('late')])
  await flush()
  expect(h.playback.enqueued).toEqual([])
  expect(h.machine.state).toBe('muted')
})

it('surfaces a capture failure and recovers on the next successful start', async () => {
  const h = setup({ muted: false })
  await h.machine.start()
  h.capture.state = 'error'
  h.capture.emitError()
  expect(h.machine.state).toBe('error')
  expect(h.playback.stop).toHaveBeenCalled()
  h.capture.state = 'idle'
  await h.machine.start()
  expect(h.machine.state).toBe('listening')
  expect(h.capture.start).toHaveBeenCalledTimes(2)
})

it('ignores a capture failure while muted', async () => {
  const h = setup()
  await h.machine.start()
  h.capture.emitError()
  expect(h.machine.state).toBe('muted')
  expect(h.playback.stop).not.toHaveBeenCalled()
})

it('ignores an accepted segment while muted', async () => {
  const h = setup()
  await h.machine.start()
  h.capture.emitSegment(speechSegment())
  expect(h.machine.state).toBe('muted')
  expect(h.respond).not.toHaveBeenCalled()
})

it('cancels the turn when capture fails while thinking', async () => {
  const h = setup({ muted: false })
  const reply = Promise.withResolvers<readonly PlaybackChunk[]>()
  h.respond.mockReturnValue(reply.promise)
  await h.machine.start()
  h.capture.emitSegment(speechSegment())
  h.capture.state = 'error'
  h.capture.emitError()
  expect(h.machine.state).toBe('error')
  reply.resolve([playbackChunk('late')])
  await flush()
  expect(h.playback.enqueued).toEqual([])
})

it('surfaces a rejected capture acquisition', async () => {
  const h = setup({ muted: false })
  h.capture.start.mockRejectedValueOnce(new Error('denied'))
  await h.machine.start()
  expect(h.machine.state).toBe('error')
  expect(h.playback.stop).toHaveBeenCalled()
})

it('ignores a capture rejection that lands after mute', async () => {
  const h = setup({ muted: false })
  const gate = Promise.withResolvers<undefined>()
  h.capture.start.mockReturnValueOnce(gate.promise)
  const started = h.machine.start()
  await flush()
  h.machine.setMuted(true)
  gate.reject(new Error('denied'))
  await started
  expect(h.machine.state).toBe('muted')
})

it('ignores a capture rejection that lands after stop', async () => {
  const h = setup({ muted: false })
  const gate = Promise.withResolvers<undefined>()
  h.capture.start.mockReturnValueOnce(gate.promise)
  const started = h.machine.start()
  await flush()
  h.machine.stop()
  gate.reject(new Error('denied'))
  await started
  expect(h.machine.state).toBe('muted')
})

it('ignores a capture acquisition that succeeds after mute', async () => {
  const h = setup({ muted: false })
  const gate = Promise.withResolvers<undefined>()
  h.capture.start.mockReturnValueOnce(gate.promise)
  const started = h.machine.start()
  await flush()
  h.machine.setMuted(true)
  gate.resolve(undefined)
  await started
  expect(h.machine.state).toBe('muted')
})

it('ignores a capture acquisition that succeeds after stop', async () => {
  const h = setup({ muted: false })
  const gate = Promise.withResolvers<undefined>()
  h.capture.start.mockReturnValueOnce(gate.promise)
  const started = h.machine.start()
  await flush()
  h.machine.stop()
  gate.resolve(undefined)
  await started
  expect(h.machine.state).toBe('muted')
})

it('leaves the state listening when acquisition reports no running session', async () => {
  const h = setup({ muted: false })
  h.capture.start.mockResolvedValue(undefined)
  await h.machine.start()
  expect(h.machine.state).toBe('listening')
})

it('surfaces a reply failure and recovers to listening without logging', async () => {
  vi.useFakeTimers()
  const h = setup({ muted: false })
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  h.respond.mockRejectedValue(new Error('model down'))
  await h.machine.start()
  h.capture.emitSegment(speechSegment())
  await flush()
  expect(h.machine.state).toBe('error')
  expect(h.store.get()).toBe('error')
  expect(consoleError).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.machine.state).toBe('listening')
})

it('surfaces a playback chunk failure and recovers to listening', async () => {
  vi.useFakeTimers()
  const h = setup({ muted: false })
  await speaking(h)
  h.playback.fail(namedError('PlaybackChunkError'))
  await flush()
  expect(h.machine.state).toBe('error')
  expect(h.store.get()).toBe('error')
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.machine.state).toBe('listening')
})

it('returns to listening when the player aborts', async () => {
  const h = setup({ muted: false })
  await speaking(h)
  h.playback.fail(namedError('AbortError'))
  await flush()
  expect(h.machine.state).toBe('listening')
})

it('surfaces a non-error playback rejection as an error', async () => {
  vi.useFakeTimers()
  const h = setup({ muted: false })
  await speaking(h)
  h.playback.fail('boom')
  await flush()
  expect(h.machine.state).toBe('error')
  h.machine.stop()
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.machine.state).toBe('muted')
})

it('clears the recovery window when muted during error', async () => {
  vi.useFakeTimers()
  const h = setup({ muted: false })
  h.respond.mockRejectedValue(new Error('model down'))
  await h.machine.start()
  h.capture.emitSegment(speechSegment())
  await flush()
  expect(h.machine.state).toBe('error')
  h.machine.setMuted(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.machine.state).toBe('muted')
})

it('delivers transitions to state observers and lets them unsubscribe', async () => {
  const h = setup({ muted: false })
  const seen: AudioState[] = []
  const stop = h.machine.onState(state => seen.push(state))
  await h.machine.start()
  h.machine.setMuted(true)
  stop()
  h.machine.setMuted(false)
  expect(seen).toEqual(['listening', 'muted'])
})

it('tolerates a throwing state observer', async () => {
  const h = setup({ muted: false })
  h.machine.onState(() => { throw new Error('observer failed') })
  await h.machine.start()
  expect(h.machine.state).toBe('listening')
})

it('stops while listening and makes teardown idempotent', async () => {
  const h = setup({ muted: false })
  await h.machine.start()
  h.machine.stop()
  expect(h.machine.state).toBe('muted')
  expect(h.capture.stop).toHaveBeenCalledTimes(1)
  expect(h.playback.stop).toHaveBeenCalledTimes(1)
  expect(h.capture.segmentListeners).toBe(0)
  expect(h.capture.errorListeners).toBe(0)

  h.capture.emitSegment(speechSegment())
  h.capture.emitError()
  h.store.set('listening')
  expect(h.machine.state).toBe('muted')

  h.machine.stop()
  expect(h.capture.stop).toHaveBeenCalledTimes(2)
  expect(h.playback.stop).toHaveBeenCalledTimes(2)
})

it('stops before start without touching a turn', () => {
  const h = setup()
  h.machine.stop()
  expect(h.machine.state).toBe('muted')
  expect(h.capture.stop).toHaveBeenCalledTimes(1)
  expect(h.playback.stop).toHaveBeenCalledTimes(1)
})

it('stops during thinking and drops the reply', async () => {
  const h = setup({ muted: false })
  const reply = Promise.withResolvers<readonly PlaybackChunk[]>()
  h.respond.mockReturnValue(reply.promise)
  await h.machine.start()
  h.capture.emitSegment(speechSegment())
  h.machine.stop()
  reply.resolve([playbackChunk('late')])
  await flush()
  expect(h.playback.enqueued).toEqual([])
  expect(h.machine.state).toBe('muted')
})

it('stops during speaking and cuts the player', async () => {
  const h = setup({ muted: false })
  await speaking(h)
  h.machine.stop()
  await flush()
  expect(h.machine.state).toBe('muted')
  expect(h.playback.stop).toHaveBeenCalled()
})

it('stops during error and clears the recovery window', async () => {
  vi.useFakeTimers()
  const h = setup({ muted: false })
  h.respond.mockRejectedValue(new Error('model down'))
  await h.machine.start()
  h.capture.emitSegment(speechSegment())
  await flush()
  expect(h.machine.state).toBe('error')
  h.machine.stop()
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.machine.state).toBe('muted')
})

it('starts muted after stop until it is unmuted again', async () => {
  const h = setup({ muted: false })
  await h.machine.start()
  h.machine.stop()
  await h.machine.start()
  expect(h.machine.state).toBe('muted')
  h.machine.setMuted(false)
  expect(h.machine.state).toBe('listening')
})

it('attaches the playback reference, notes spoken text, and resets the echo guard', async () => {
  const echo = createFakeEchoGuard()
  const reference = createFakeEchoReference()
  const h = setup({ muted: false, echo: echo.guard, echoReference: reference.node })
  h.respond.mockResolvedValue([
    { id: 'first', wav: new ArrayBuffer(0), text: 'hello there' },
    playbackChunk('second'),
  ])
  await h.machine.start()
  h.capture.emitSegment(speechSegment(1, { pcm: pcm(0.5) }))
  await flush()
  expect(h.machine.state).toBe('speaking')
  expect(echo.attach).toHaveBeenLastCalledWith(reference.node)
  expect(echo.noteSpoken).toHaveBeenCalledTimes(1)
  expect(echo.noteSpoken).toHaveBeenCalledWith('hello there')

  h.machine.setMuted(true)
  expect(echo.reset).toHaveBeenCalledTimes(1)
  h.machine.stop()
  expect(echo.reset).toHaveBeenCalledTimes(2)
  expect(echo.attach).toHaveBeenLastCalledWith(null)
})

it('keeps echoed segments out of barge-in and out of the tail before listening', async () => {
  const reference = createFakeEchoReference()
  const guard = createEchoGuard()
  const h = setup({ muted: false, echo: guard, echoReference: reference.node })
  h.respond.mockResolvedValue([playbackChunk('reply')])
  await h.machine.start()
  reference.level = 0.2
  h.capture.emitSegment(speechSegment(1, { pcm: pcm(0.1) }))
  await flush()
  expect(h.machine.state).toBe('speaking')
  expect(reference.connect).toHaveBeenCalledTimes(1)

  // The reply's own echo: suppressed, so playback keeps going.
  h.capture.emitSegment(speechSegment(2, { pcm: pcm(0.1) }))
  expect(h.playback.stop).not.toHaveBeenCalled()
  expect(h.machine.state).toBe('speaking')

  // A genuine, energetic interruption still cuts the reply.
  h.capture.emitSegment(speechSegment(3, { pcm: pcm(0.6) }))
  expect(h.playback.stop).toHaveBeenCalledTimes(1)
  expect(h.machine.state).toBe('thinking')
  await flush()
  expect(h.machine.state).toBe('speaking')

  // After the reply drains, the tail rejects the room echo before a new turn.
  h.playback.drain()
  await flush()
  expect(h.machine.state).toBe('listening')
  reference.level = 0
  let attempts = 0
  while (h.machine.state === 'listening' && attempts < 20) {
    h.capture.emitSegment(speechSegment(4 + attempts, { pcm: pcm(0) }))
    attempts += 1
  }
  expect(h.machine.state).toBe('thinking')
  expect(attempts).toBeGreaterThan(1)
  await flush()
  // The genuine segment that outlasted the tail opened the next turn.
  expect(h.respond).toHaveBeenCalledTimes(3)
  expect(h.machine.state).toBe('speaking')
})
