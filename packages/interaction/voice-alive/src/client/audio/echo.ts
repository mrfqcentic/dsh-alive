/**
 * Echo guard for always-listening playback.
 *
 * Playback leaks through speakers into the microphone; without a guard the
 * recognizer hears the orb's own voice and opens a turn for it. The guard has
 * the three layers the audio spec requires:
 *
 * 1. Reference cancellation. `attach` taps the playback bus returned by
 *    `PlaybackController.createEchoReference()`. Every analysis block measures
 *    the reference level and compares the capture level with an adaptively
 *    scaled, path-delayed copy of that reference. The delay is selected by
 *    normalized cross-correlation over the recent level history, so the model
 *    learns the speaker-to-microphone latency instead of assuming one.
 * 2. Half-duplex gate. While the reference sounds, a block is suppressed
 *    unless its level stands above the predicted residual echo by both a
 *    relative and an absolute margin. After the reference drains, the gate
 *    holds `tailMs` (200-250 ms) so the room tail cannot open a turn.
 * 3. Semantic gate. `reject` compares a candidate transcript with the last
 *    spoken utterances on content tokens, tolerating ASR drift, while short
 *    backchannels ("yes", "no", "stop") always remain genuine barge-ins.
 *
 * `suppress` consumes one block per call. Feeding consecutive 20 ms capture
 * frames through `CaptureOptions.frameGate` gives the delay model frame
 * resolution. A longer block is split into 20 ms blocks and reported as echo
 * only when every block is, so a whole segment works as a backstop without
 * discarding a turn that holds one genuine frame of user speech.
 * @module @deepseek-ai/dsh-voice-alive/client/audio/echo
 */
import { FRAME_SAMPLES, SAMPLE_RATE } from './vad.ts'

/** Guard held after the last reference block when the option is absent: 225 ms. */
const DEFAULT_TAIL_MS = 225

/** Shortest accepted tail guard: 200 ms. */
const MIN_TAIL_MS = 200

/** Longest accepted tail guard: 250 ms. */
const MAX_TAIL_MS = 250

/** Duration of one analysis block in milliseconds. */
const BLOCK_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000

/** Reference RMS at or above which playback is audible on the bus. */
const ACTIVE_LEVEL = 0.002

/** Silent blocks tolerated before the reference counts as drained. */
const DRAIN_BLOCKS = 2

/** Longest acoustic path delay modelled: 15 blocks (300 ms). */
const MAX_DELAY_BLOCKS = 15

/** Level-history blocks one path-delay correlation measures over. */
const DELAY_WINDOW = 20

/** Minimum normalized correlation before a delay replaces the current one. */
const DELAY_SCORE = 0.6

/** Reference level spread below which the path delay cannot be measured. */
const DELAY_SPREAD = 0.002

/** FFT size of the reference analyser. */
const REFERENCE_FFT = 1024

/** Gain the adaptive filter starts from, assuming no attenuation. */
const GAIN_START = 1

/** Fraction of the gain error corrected per suppressed block. */
const GAIN_RATE = 0.3

/** Lowest gain the adaptive filter can settle on. */
const GAIN_MIN = 0.02

/** Highest gain the adaptive filter can settle on. */
const GAIN_MAX = 1.5

/** Capture level multiple of predicted echo that counts as user speech. */
const BARGE_FACTOR = 1.8

/** Absolute margin over predicted echo that counts as user speech. */
const BARGE_FLOOR = 0.01

/** Content-token overlap at or above which a transcript counts as echo. */
const DEFAULT_THRESHOLD = 0.6

/** Spoken utterances retained for semantic comparison. */
const SPOKEN_HISTORY = 8

/** Longest token count that can still be a backchannel. */
const BACKCHANNEL_TOKENS = 3

/**
 * Tokens that carry no content of their own. Comparing them would reject a
 * genuine follow-up question that shares the reply's grammar ("what is the
 * time" against "what is the weather"), so only content tokens are compared.
 */
const FILLERS = new Set([
  'a', 'about', 'am', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he',
  'her', 'here', 'him', 'his', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'may',
  'me', 'might', 'must', 'my', 'of', 'or', 'our', 'shall', 'she', 'should', 'so',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'to', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'would', 'you', 'your',
])

/** Short replies a listener uses to interrupt; never treated as echo. */
const BACKCHANNELS = new Set([
  'alright', 'hey', 'hmm', 'huh', 'mm', 'no', 'nope', 'ok', 'okay', 'please',
  'right', 'stop', 'sure', 'thank', 'thanks', 'wait', 'yeah', 'yep', 'yes',
])

/** Digit words used to normalize numerals on both sides of the comparison. */
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

/** Runs of punctuation removed before token comparison. */
const PUNCTUATION = /\p{P}+/gu

/** One decimal digit replaced with its spoken word. */
const DIGIT = /\d/g

/** Runs of whitespace collapsed to one separator. */
const SPACES = /\s+/g

/** Options accepted by {@link createEchoGuard}. */
export interface EchoGuardOptions {
  /**
   * Guard held after the last reference block, in milliseconds. Values
   * outside 200-250 are clamped into the spec window. Defaults to 225.
   */
  tailMs?: number
  /**
   * Fraction of content tokens a transcript must share with a spoken
   * utterance before it is discarded as echo. Defaults to 0.6.
   */
  threshold?: number
  /**
   * Supplies utterances the caller knows are recent, for example the reply
   * queue that has not reached `noteSpoken` yet. Consulted on every `reject`.
   * @returns recent spoken utterances, any order.
   */
  recentText?: () => readonly string[]
}

/**
 * Keeps the orb's own voice out of capture.
 *
 * One guard belongs to one capture controller. `reset` clears the spoken
 * history and the filter, which is what mute and stop require.
 */
export interface EchoGuard {
  /**
   * Decide whether one block of captured audio is echo.
   * @param frame - 16 kHz mono signed 16-bit PCM; one 20 ms frame per call
   * keeps path-delay resolution. A longer block is evaluated frame by frame and
   * reported as echo only when every frame is.
   * @returns true when the block must be discarded as echo or guard tail.
   */
  suppress(frame: Int16Array): boolean
  /**
   * Record an utterance the orb just spoke.
   * @param text - text of one played chunk; empty text is ignored.
   */
  noteSpoken(text: string): void
  /**
   * Decide whether a candidate transcript is the orb's own speech.
   * @param transcript - recognized text of one closed segment.
   * @returns true when the transcript must be discarded as echo.
   */
  reject(transcript: string): boolean
  /**
   * Tap the playback bus as the echo reference.
   * @param reference - node from `createEchoReference()`, or null to stop
   * reading it. Attaching null also clears the filter state.
   */
  attach(reference: AudioNode | null): void
  /**
   * Clear the spoken history, reference history, path delay, gain, and tail.
   * Call it on mute and stop; the attached reference stays connected.
   */
  reset(): void
}

/**
 * Lowercase a text and split it into comparison tokens.
 * @param text - one utterance or transcript.
 * @returns tokens with case, punctuation, whitespace, and digits normalized.
 */
function normalizeText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(DIGIT, digit => ` ${DIGITS[Number(digit)]} `)
    .replace(PUNCTUATION, ' ')
    .replace(SPACES, ' ')
    .trim()
    .split(' ')
    .filter(token => token.length > 0)
}

/**
 * Remove function words so only meaning-bearing tokens are compared.
 * @param tokens - normalized tokens.
 * @returns the tokens that are not fillers.
 */
function contentTokens(tokens: readonly string[]): string[] {
  return tokens.filter(token => !FILLERS.has(token))
}

/**
 * Count tokens shared by two token lists, respecting repetition.
 * @param candidate - tokens of the candidate transcript.
 * @param spoken - tokens of one spoken utterance.
 * @returns shared tokens divided by the longer list length, in 0..1.
 */
function overlap(candidate: readonly string[], spoken: readonly string[]): number {
  const pool = new Map<string, number>()
  for (const token of spoken) pool.set(token, (pool.get(token) ?? 0) + 1)
  let matched = 0
  for (const token of candidate) {
    const left = pool.get(token) ?? 0
    if (left === 0) continue
    matched += 1
    pool.set(token, left - 1)
  }
  return matched / Math.max(candidate.length, spoken.length)
}

/**
 * Compare a candidate with one spoken utterance on content tokens.
 * @param candidate - normalized candidate tokens.
 * @param spoken - normalized tokens of the spoken utterance.
 * @returns content-token overlap, falling back to full tokens when either
 * side has no content left.
 */
function similarity(candidate: readonly string[], spoken: readonly string[]): number {
  const left = contentTokens(candidate)
  const right = contentTokens(spoken)
  if (left.length === 0 || right.length === 0) return overlap(candidate, spoken)
  return overlap(left, right)
}

/**
 * Whether a transcript is only a short interruption.
 * @param tokens - normalized candidate tokens.
 * @returns true for at most three tokens that are all backchannels.
 */
function isBackchannel(tokens: readonly string[]): boolean {
  return tokens.length <= BACKCHANNEL_TOKENS && tokens.every(token => BACKCHANNELS.has(token))
}

/**
 * Measure one block's normalized level.
 * @param frame - 16 kHz mono PCM samples.
 * @returns root-mean-square level, full scale 1.
 */
function frameLevel(frame: Int16Array): number {
  let sum = 0
  for (const sample of frame) {
    const value = sample / 32768
    sum += value * value
  }
  return Math.sqrt(sum / frame.length)
}

/** Reference analyser and the node it is connected to. */
interface ReferenceTap {
  /** Playback bus the analyser observes. */
  readonly node: AudioNode
  /** Analyser reading that bus. */
  readonly analyser: AnalyserNode
}

/** Echo guard implementation; the factory is its only constructor. */
class Guard implements EchoGuard {
  private tap: ReferenceTap | null = null
  private readonly samples = new Float32Array(REFERENCE_FFT)
  private readonly captureLevels: number[] = []
  private readonly referenceLevels: number[] = []
  private readonly spoken: string[] = []
  private readonly tailMs: number
  private readonly threshold: number
  private readonly recentText: (() => readonly string[]) | undefined
  private sounding = false
  private silentBlocks = 0
  private tail = 0
  private delay = 0
  private gain = GAIN_START

  /**
   * @param options - tail window, semantic threshold, and recent-text source.
   */
  constructor(options: EchoGuardOptions) {
    this.tailMs = Math.min(MAX_TAIL_MS, Math.max(MIN_TAIL_MS, options.tailMs ?? DEFAULT_TAIL_MS))
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD
    this.recentText = options.recentText
  }

  suppress(frame: Int16Array): boolean {
    if (frame.length === 0) return false
    let echoed = true
    for (let offset = 0; offset < frame.length; offset += FRAME_SAMPLES) {
      const block = frame.subarray(offset, offset + FRAME_SAMPLES)
      if (!this.suppressBlock(block)) echoed = false
    }
    return echoed
  }

  /**
   * Decide one analysis block. A block is only ever one 20 ms frame; the split
   * in `suppress` keeps the history and the tail on that clock.
   * @param frame - at most FRAME_SAMPLES of 16 kHz mono PCM.
   * @returns true when the block must be discarded as echo or guard tail.
   */
  private suppressBlock(frame: Int16Array): boolean {
    const level = frameLevel(frame)
    const reference = this.readReference()
    this.captureLevels.push(level)
    this.referenceLevels.push(reference)
    this.trimHistory()
    this.track(reference)
    if (this.tail > 0) {
      this.tail = Math.max(0, this.tail - Math.max(BLOCK_MS, (frame.length / SAMPLE_RATE) * 1000))
      return true
    }
    if (!this.sounding) return false
    this.estimateDelay()
    // `estimateDelay` only moves the delay once the history holds a full
    // DELAY_WINDOW plus MAX_DELAY_BLOCKS, so this read is always in range.
    /* v8 ignore next -- history depth is an invariant of the delay search. */
    const delayed = this.referenceLevels.at(-1 - this.delay) ?? 0
    const predicted = this.gain * delayed
    const margin = Math.max(predicted * (BARGE_FACTOR - 1), BARGE_FLOOR)
    if (level - predicted >= margin) return false
    this.adaptGain(level, delayed)
    return true
  }

  noteSpoken(text: string): void {
    if (normalizeText(text).length === 0) return
    this.spoken.push(text)
    if (this.spoken.length > SPOKEN_HISTORY) this.spoken.shift()
  }

  reject(transcript: string): boolean {
    const candidate = normalizeText(transcript)
    if (candidate.length === 0) return false
    if (isBackchannel(candidate)) return false
    const utterances: string[] = []
    if (this.recentText !== undefined) utterances.push(...this.recentText())
    utterances.push(...this.spoken)
    for (const utterance of utterances) {
      const tokens = normalizeText(utterance)
      if (tokens.length === 0) continue
      if (similarity(candidate, tokens) >= this.threshold) return true
    }
    return false
  }

  attach(reference: AudioNode | null): void {
    if (this.tap?.node === reference) return
    if (this.tap !== null) {
      this.tap.node.disconnect(this.tap.analyser)
      this.tap = null
    }
    this.clearReference()
    if (reference === null) return
    const analyser = reference.context.createAnalyser()
    analyser.fftSize = REFERENCE_FFT
    reference.connect(analyser)
    this.tap = { node: reference, analyser }
  }

  reset(): void {
    this.spoken.length = 0
    this.clearReference()
  }

  /**
   * Read the current reference level from the tap.
   * @returns root-mean-square level in 0..1, or 0 without a tap.
   */
  private readReference(): number {
    const tap = this.tap
    if (tap === null) return 0
    tap.analyser.getFloatTimeDomainData(this.samples)
    let sum = 0
    for (const sample of this.samples) sum += sample * sample
    const rms = Math.sqrt(sum / this.samples.length)
    return Number.isFinite(rms) ? Math.min(1, rms) : 0
  }

  /** Keep the level history at the depth the delay search needs. */
  private trimHistory(): void {
    if (this.captureLevels.length <= DELAY_WINDOW + MAX_DELAY_BLOCKS) return
    this.captureLevels.shift()
    this.referenceLevels.shift()
  }

  /**
   * Follow reference activity, the drain, and the tail window.
   * @param reference - current reference level.
   */
  private track(reference: number): void {
    if (reference >= ACTIVE_LEVEL) {
      this.sounding = true
      this.silentBlocks = 0
      this.tail = 0
      return
    }
    if (!this.sounding) return
    this.silentBlocks += 1
    if (this.silentBlocks <= DRAIN_BLOCKS) return
    this.sounding = false
    this.tail = this.tailMs
  }

  /** Pick the path delay whose reference history best correlates with capture. */
  private estimateDelay(): void {
    if (this.captureLevels.length < DELAY_WINDOW + MAX_DELAY_BLOCKS) return
    if (!this.varies()) return
    const capture = this.captureLevels.slice(-DELAY_WINDOW)
    let best = this.delay
    let bestScore = DELAY_SCORE
    for (let candidate = 0; candidate <= MAX_DELAY_BLOCKS; candidate += 1) {
      const score = this.correlation(capture, candidate)
      if (score <= bestScore) continue
      bestScore = score
      best = candidate
    }
    this.delay = best
  }

  /**
   * Whether the recent reference levels carry enough variation to time-align.
   * @returns true when the level spread reaches the measurement floor.
   */
  private varies(): boolean {
    let min = 1
    let max = 0
    for (const value of this.referenceLevels.slice(-DELAY_WINDOW)) {
      if (value < min) min = value
      if (value > max) max = value
    }
    return max - min >= DELAY_SPREAD
  }

  /**
   * Normalized cross-correlation of capture and delayed reference levels.
   * @param capture - capture level window, oldest first.
   * @param delay - candidate path delay in blocks.
   * @returns correlation in 0..1, or 0 when either window is silent.
   */
  private correlation(capture: readonly number[], delay: number): number {
    const end = this.referenceLevels.length - delay
    const start = end - capture.length
    let dot = 0
    let captureEnergy = 0
    let referenceEnergy = 0
    for (const [index, value] of capture.entries()) {
      /* v8 ignore next -- the caller holds DELAY_WINDOW + MAX_DELAY_BLOCKS. */
      const other = this.referenceLevels[start + index] ?? 0
      dot += value * other
      captureEnergy += value * value
      referenceEnergy += other * other
    }
    if (captureEnergy === 0 || referenceEnergy === 0) return 0
    return dot / Math.sqrt(captureEnergy * referenceEnergy)
  }

  /**
   * Move the adaptive gain toward the observed echo attenuation.
   * @param level - capture level of this block.
   * @param reference - delayed reference level that produced it.
   */
  private adaptGain(level: number, reference: number): void {
    if (reference < ACTIVE_LEVEL) return
    const observed = Math.min(GAIN_MAX, Math.max(GAIN_MIN, level / reference))
    this.gain = Math.min(GAIN_MAX, Math.max(GAIN_MIN, this.gain + (observed - this.gain) * GAIN_RATE))
  }

  /** Drop every reference-dependent measurement, keeping the tap connected. */
  private clearReference(): void {
    this.captureLevels.length = 0
    this.referenceLevels.length = 0
    this.sounding = false
    this.silentBlocks = 0
    this.tail = 0
    this.delay = 0
    this.gain = GAIN_START
  }
}

/**
 * Create one echo guard.
 *
 * Without `attach` the guard is a semantic gate only: every block passes,
 * because there is no known playback reference to cancel.
 * @param options - tail window, semantic threshold, and recent-text source.
 * @returns a guard that starts with no reference and empty history.
 */
export function createEchoGuard(options: EchoGuardOptions = {}): EchoGuard {
  return new Guard(options)
}
