/**
 * Frame-based voice activity detection and the conservative default word gate.
 *
 * The detector works on consecutive 20 ms frames of 16 kHz mono PCM. It keeps
 * a noise floor calibrated on the first 300 ms, opens a segment only for
 * frames whose energy is above that floor and whose zero-crossing rate sits in
 * the range speech occupies, closes after 1.2 s without a voiced frame, and
 * cuts any segment at 15 s. All decisions are frame arithmetic, so the module
 * runs without Web Audio and is tested on synthetic PCM.
 * @module @deepseek-ai/dsh-voice-alive/client/audio/vad
 */
import type { SpeechSegment } from './types.ts'

/** Capture rate in hertz. */
export const SAMPLE_RATE = 16000

/** Samples in one 20 ms analysis frame. */
export const FRAME_SAMPLES = 320

/** Frame duration in milliseconds. */
const FRAME_MS = 20

/** Frames analyzed before the noise floor is fixed: 300 ms. */
const CALIBRATION_FRAMES = 15

/** Fraction of the calibration frames treated as the noise floor. */
const CALIBRATION_PERCENTILE = 0.2

/** Frames kept before speech starts and prepended to the segment: 100 ms. */
const PRE_ROLL_FRAMES = 5

/** Silent frames tolerated inside a segment before it closes: 1.2 s. */
const HANGOVER_FRAMES = 60

/** Frames of audio kept after the last voiced frame: 200 ms. */
const TAIL_FRAMES = 10

/** Voiced frames required before a segment is emitted: 200 ms. */
const MIN_VOICED_FRAMES = 10

/** Frame count at which a segment is forced closed: 15 s. */
const MAX_SEGMENT_FRAMES = 750

/** Lower bound of the adaptive noise floor, normalized RMS. */
const MIN_FLOOR = 0.0015

/** Upper bound of the adaptive noise floor, normalized RMS. */
const MAX_FLOOR = 0.03

/** A frame must exceed the floor by this factor to count as speech. */
const SPEECH_RATIO = 3

/** Absolute RMS below which no frame counts as speech. */
const MIN_SPEECH_RMS = 0.006

/** Zero-crossing rate below which a frame is rumble or direct current. */
const MIN_VOICED_ZCR = 0.01

/** Zero-crossing rate above which a frame is broadband noise or a click. */
const MAX_VOICED_ZCR = 0.42

/** Weight of the previous floor when following background noise. */
const FLOOR_DECAY = 0.98

/** Shortest segment the default gate accepts: 450 ms. */
const MIN_GATE_DURATION_MS = 450

/** Lowest segment RMS the default gate accepts. */
const MIN_GATE_RMS = 0.01

/** Lowest segment peak the default gate accepts. */
const MIN_GATE_PEAK = 0.05

/** Per-frame measurements used by the detector. */
interface FrameFeatures {
  /** Root-mean-square level normalized so full scale is 1. */
  readonly rms: number
  /** Largest absolute sample normalized so full scale is 1. */
  readonly peak: number
  /** Fraction of adjacent sample pairs whose sign changes. */
  readonly zcr: number
}

/** One segment while it is still receiving frames. */
interface OpenSegment {
  /** Capture frame index of the first (pre-roll) frame. */
  readonly startFrame: number
  /** Frames accumulated from the pre-roll to the current frame. */
  readonly frames: Int16Array[]
  /** Count of frames classified as voiced. */
  voicedFrames: number
  /** Capture frame index of the most recent voiced frame. */
  lastVoicedFrame: number
  /** Index in `frames` of the most recent voiced frame. */
  lastVoicedIndex: number
}

/** Streaming voice activity detector over consecutive 20 ms frames. */
export interface SegmentDetector {
  /**
   * Analyze one frame.
   * @param frame - 16 kHz mono PCM; capture supplies exactly 320 samples.
   * @returns segments closed by this frame, oldest first.
   */
  push(frame: Int16Array): SpeechSegment[]

  /**
   * Close the open segment at the end of capture.
   * @returns zero or one segment.
   */
  flush(): SpeechSegment[]

  /** Discard all state, including the noise floor and the next segment id. */
  reset(): void

  /**
   * Current adaptive noise floor.
   * @returns normalized RMS, or undefined during the 300 ms calibration.
   */
  noiseFloor(): number | undefined
}

/**
 * Measure one frame.
 * @param frame - 16 kHz mono PCM samples.
 * @returns its RMS, peak, and zero-crossing rate.
 */
function analyze(frame: Int16Array): FrameFeatures {
  let sum = 0
  let peak = 0
  let crossings = 0
  let previous = 0
  for (const sample of frame) {
    const value = sample / 32768
    sum += value * value
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
    if ((value >= 0) !== (previous >= 0)) crossings += 1
    previous = value
  }
  return { rms: Math.sqrt(sum / frame.length), peak, zcr: crossings / frame.length }
}

/**
 * Clamp a noise-floor estimate into the configured range.
 * @param value - normalized RMS estimate.
 * @returns the estimate bounded by the floor limits.
 */
function clampFloor(value: number): number {
  return Math.min(MAX_FLOOR, Math.max(MIN_FLOOR, value))
}

/**
 * Derive the noise floor from the calibration frames.
 * @param samples - normalized RMS of each calibration frame.
 * @returns the lower-fifth level, clamped to the floor limits.
 */
function calibrate(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const limit = sorted.length * CALIBRATION_PERCENTILE
  return clampFloor(sorted.reduce((lowest, value, index) => (index <= limit ? value : lowest), MIN_FLOOR))
}

/**
 * Decide whether one frame looks like voiced speech.
 * @param features - measurements for the frame.
 * @param threshold - RMS a frame must reach.
 * @returns true when the frame is loud enough and its zero-crossing rate is in
 * the speech range.
 */
function isVoiced(features: FrameFeatures, threshold: number): boolean {
  return features.rms >= threshold && features.zcr >= MIN_VOICED_ZCR && features.zcr <= MAX_VOICED_ZCR
}

/** Detector implementation; `createSegmentDetector` is its only constructor. */
class Detector implements SegmentDetector {
  private calibration: number[] = []
  private floor: number | undefined
  private preRoll: Int16Array[] = []
  private open: OpenSegment | undefined
  private frameIndex = 0
  private nextId = 0

  push(frame: Int16Array): SpeechSegment[] {
    const features = analyze(frame)
    const index = this.frameIndex
    this.frameIndex += 1
    let floor = this.floor
    if (floor === undefined) {
      this.calibration.push(features.rms)
      this.remember(frame)
      if (this.calibration.length < CALIBRATION_FRAMES) return []
      floor = calibrate(this.calibration)
      this.floor = floor
    }
    const voiced = isVoiced(features, Math.max(floor * SPEECH_RATIO, MIN_SPEECH_RMS))
    const open = this.open
    if (open === undefined) {
      if (!voiced) {
        this.floor = clampFloor(floor * FLOOR_DECAY + features.rms * (1 - FLOOR_DECAY))
        this.remember(frame)
        return []
      }
      this.open = {
        startFrame: index - this.preRoll.length,
        frames: [...this.preRoll, frame],
        voicedFrames: 1,
        lastVoicedFrame: index,
        lastVoicedIndex: this.preRoll.length,
      }
      this.preRoll = []
      return []
    }
    open.frames.push(frame)
    if (voiced) {
      open.voicedFrames += 1
      open.lastVoicedFrame = index
      open.lastVoicedIndex = open.frames.length - 1
    }
    if (open.frames.length >= MAX_SEGMENT_FRAMES) {
      this.open = undefined
      // The current frame starts the continuation segment when it is voiced,
      // so the cut ends before it and no frame belongs to both segments.
      const cut = this.emit(open, open.frames.length - 1)
      if (voiced) {
        this.open = {
          startFrame: index,
          frames: [frame],
          voicedFrames: 1,
          lastVoicedFrame: index,
          lastVoicedIndex: 0,
        }
      }
      return cut
    }
    if (voiced || index - open.lastVoicedFrame < HANGOVER_FRAMES) return []
    this.open = undefined
    return this.emit(open)
  }

  flush(): SpeechSegment[] {
    const open = this.open
    this.open = undefined
    this.preRoll = []
    if (open === undefined) return []
    return this.emit(open)
  }

  reset(): void {
    this.calibration = []
    this.floor = undefined
    this.preRoll = []
    this.open = undefined
    this.frameIndex = 0
    this.nextId = 0
  }

  noiseFloor(): number | undefined {
    return this.floor
  }

  /**
   * Retain one silent frame for the pre-roll.
   * @param frame - the frame to remember.
   */
  private remember(frame: Int16Array): void {
    this.preRoll.push(frame)
    if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
  }

  /**
   * Emit an open segment when it holds enough speech.
   * @param open - segment whose frames are complete.
   * @param limit - frames to keep before trailing-silence trimming; the whole
   * segment unless a forced cut excludes its final frame.
   * @returns the delivered segment, or an empty list when the segment has less
   * than 200 ms of voiced audio.
   */
  private emit(open: OpenSegment, limit = open.frames.length): SpeechSegment[] {
    if (open.voicedFrames < MIN_VOICED_FRAMES) return []
    return [this.close(open, limit)]
  }

  /**
   * Build the delivered segment.
   * @param open - segment whose frames are complete.
   * @param limit - frames to keep before trailing-silence trimming.
   * @returns the segment with its statistics.
   */
  private close(open: OpenSegment, limit: number): SpeechSegment {
    const end = Math.min(limit, open.lastVoicedIndex + TAIL_FRAMES + 1)
    const frames = open.frames.slice(0, end)
    let length = 0
    for (const frame of frames) length += frame.length
    const pcm = new Int16Array(length)
    let offset = 0
    let peak = 0
    let sum = 0
    for (const frame of frames) {
      pcm.set(frame, offset)
      offset += frame.length
      for (const sample of frame) {
        const value = sample / 32768
        sum += value * value
        const magnitude = Math.abs(value)
        if (magnitude > peak) peak = magnitude
      }
    }
    const segment: SpeechSegment = {
      id: this.nextId,
      pcm,
      startedAt: open.startFrame * FRAME_MS,
      endedAt: (open.startFrame + end) * FRAME_MS,
      peak,
      rms: Math.sqrt(sum / length),
    }
    this.nextId += 1
    return segment
  }
}

/**
 * Create an independent streaming voice activity detector.
 * @returns a detector whose state, noise floor, and segment ids are its own.
 */
export function createSegmentDetector(): SegmentDetector {
  return new Detector()
}

/**
 * Conservative default word gate.
 *
 * It accepts a segment only when it is at least 450 ms long, has an RMS of at
 * least 0.01, and peaks at 0.05 or more. The rule relies on energy and
 * duration alone, so it rejects silence, clicks, and short noise bursts but
 * cannot tell a spoken word from music, a steady tone, or a loud machine that
 * stays inside the speech zero-crossing range. Ticket 11 replaces it with a
 * gate that decides on the recognized transcript; this default exists so the
 * controller is usable before recognition lands.
 * @param segment - closed segment with its level statistics.
 * @returns true when the segment is long and loud enough to plausibly hold words.
 */
export function energyWordGate(segment: SpeechSegment): boolean {
  return segment.endedAt - segment.startedAt >= MIN_GATE_DURATION_MS
    && segment.rms >= MIN_GATE_RMS
    && segment.peak >= MIN_GATE_PEAK
}
