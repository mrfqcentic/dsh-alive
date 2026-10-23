/** Voice activity detection and the default word gate over synthetic 16 kHz PCM. */
import { describe, expect, it } from 'vitest'
import type { SpeechSegment } from '../src/client/audio/types.ts'
import {
  createSegmentDetector,
  energyWordGate,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  type SegmentDetector,
} from '../src/client/audio/vad.ts'

const FRAME = FRAME_SAMPLES

/**
 * Split normalized samples into 20 ms frames of signed 16-bit PCM.
 * @param samples - normalized source samples.
 * @returns one Int16Array per complete or partial 320-sample frame.
 */
function framesOf(samples: Float64Array): Int16Array[] {
  const frames: Int16Array[] = []
  for (let offset = 0; offset < samples.length; offset += FRAME) {
    const chunk = samples.subarray(offset, offset + FRAME)
    const frame = new Int16Array(chunk.length)
    for (const [index, value] of chunk.entries()) frame[index] = Math.round(value * 32767)
    frames.push(frame)
  }
  return frames
}

/**
 * Deterministic silence.
 * @param count - number of frames.
 * @returns silent frames.
 */
function silence(count: number): Int16Array[] {
  return framesOf(new Float64Array(count * FRAME))
}

/**
 * Deterministic sine tone.
 * @param count - number of frames.
 * @param frequency - tone frequency in hertz.
 * @param amplitude - peak normalized amplitude.
 * @returns tone frames.
 */
function tone(count: number, frequency: number, amplitude = 0.3): Int16Array[] {
  const samples = new Float64Array(count * FRAME)
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE)
  }
  return framesOf(samples)
}

/**
 * Deterministic broadband noise from a linear congruential generator.
 * @param count - number of frames.
 * @param amplitude - peak normalized amplitude.
 * @returns noise frames.
 */
function noise(count: number, amplitude: number): Int16Array[] {
  const samples = new Float64Array(count * FRAME)
  let state = 1
  for (let i = 0; i < samples.length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    samples[i] = ((state / 0x100000000) * 2 - 1) * amplitude
  }
  return framesOf(samples)
}

/**
 * Speech-like harmonic signal with a syllable envelope.
 * @param count - number of frames.
 * @param amplitude - peak normalized amplitude.
 * @returns speech-like frames.
 */
function speech(count: number, amplitude = 0.3): Int16Array[] {
  const samples = new Float64Array(count * FRAME)
  for (let i = 0; i < samples.length; i += 1) {
    const time = i / SAMPLE_RATE
    const envelope = 0.5 - 0.5 * Math.cos(2 * Math.PI * 3.5 * time)
    const carrier = 0.6 * Math.sin(2 * Math.PI * 180 * time)
      + 0.3 * Math.sin(2 * Math.PI * 360 * time)
      + 0.1 * Math.sin(2 * Math.PI * 540 * time)
    samples[i] = amplitude * envelope * carrier
  }
  return framesOf(samples)
}

/**
 * Linear chirp from 300 Hz to 3000 Hz.
 * @param count - number of frames.
 * @returns chirp frames.
 */
function chirp(count: number): Int16Array[] {
  const samples = new Float64Array(count * FRAME)
  let phase = 0
  for (let i = 0; i < samples.length; i += 1) {
    const time = i / (count * FRAME)
    phase += (2 * Math.PI * (300 + 2700 * time)) / SAMPLE_RATE
    samples[i] = 0.3 * Math.sin(phase)
  }
  return framesOf(samples)
}

/**
 * Feed frames and collect the segments they close.
 * @param detector - detector under test.
 * @param frames - frames in capture order.
 * @returns segments emitted while feeding.
 */
function feed(detector: SegmentDetector, frames: readonly Int16Array[]): SpeechSegment[] {
  const segments: SpeechSegment[] = []
  for (const frame of frames) segments.push(...detector.push(frame))
  return segments
}

/**
 * Estimate a segment's dominant frequency from its zero-crossing rate.
 * @param segment - segmented PCM.
 * @returns frequency in hertz for a single-tone signal.
 */
function measuredFrequency(segment: SpeechSegment): number {
  let crossings = 0
  let previous = 0
  for (const sample of segment.pcm) {
    if ((sample >= 0) !== (previous >= 0)) crossings += 1
    previous = sample
  }
  return ((crossings / segment.pcm.length) * SAMPLE_RATE) / 2
}

describe('noise floor', () => {
  it('is undefined during calibration and clamps pure silence to the minimum', () => {
    const detector = createSegmentDetector()
    expect(detector.noiseFloor()).toBeUndefined()
    expect(feed(detector, silence(10))).toEqual([])
    expect(detector.noiseFloor()).toBeUndefined()
    feed(detector, silence(5))
    expect(detector.noiseFloor()).toBeCloseTo(0.0015, 6)
  })

  it('rises toward sustained background noise and raises the speech threshold', () => {
    const detector = createSegmentDetector()
    feed(detector, silence(15))
    const quietFloor = detector.noiseFloor() ?? 0
    feed(detector, noise(200, 0.05))
    const loudFloor = detector.noiseFloor() ?? 0
    expect(loudFloor).toBeGreaterThan(quietFloor)
    expect(loudFloor).toBeLessThanOrEqual(0.03)
    // A quiet tone that would clear the silent-room threshold stays below the
    // raised one and produces nothing.
    expect(feed(detector, tone(30, 440, 0.03))).toEqual([])
    // A clearly louder utterance still opens a segment.
    expect(feed(detector, [...tone(30, 440, 0.3), ...silence(70)])).toHaveLength(1)
  })

  it('detects speech that begins during the calibration window', () => {
    const detector = createSegmentDetector()
    const segments = feed(detector, [...speech(40), ...silence(70)])
    expect(segments).toHaveLength(1)
    expect(segments[0]!.startedAt).toBeLessThan(300)
  })
})

describe('segment boundaries', () => {
  it('discards silence entirely', () => {
    const detector = createSegmentDetector()
    expect(feed(detector, silence(80))).toEqual([])
    expect(detector.flush()).toEqual([])
  })

  it('emits one segment for one utterance with pre-roll and trailing audio', () => {
    const detector = createSegmentDetector()
    const segments = feed(detector, [...silence(20), ...speech(40), ...silence(70)])
    expect(segments).toHaveLength(1)
    const segment = segments[0]!
    expect(segment.id).toBe(0)
    expect(segment.rms).toBeGreaterThan(0.01)
    expect(segment.peak).toBeGreaterThan(0.05)
    // 800 ms voiced, plus up to 100 ms pre-roll and 200 ms tail.
    expect(segment.endedAt - segment.startedAt).toBeGreaterThanOrEqual(1000)
    expect(segment.endedAt - segment.startedAt).toBeLessThanOrEqual(1150)
    expect(segment.pcm.length).toBe(((segment.endedAt - segment.startedAt) / 20) * FRAME)
  })

  it('splits two utterances separated by more than the hangover', () => {
    const detector = createSegmentDetector()
    const first = feed(detector, [...silence(20), ...speech(25), ...silence(70)])
    const second = feed(detector, [...speech(25)])
    const flushed = detector.flush()
    expect([...first, ...second, ...flushed]).toHaveLength(2)
    expect([...first, ...second, ...flushed].map(segment => segment.id)).toEqual([0, 1])
    expect([...first, ...second, ...flushed][1]!.startedAt).toBeGreaterThan(first[0]!.endedAt)
  })

  it('keeps one segment when the pause is shorter than the hangover', () => {
    const detector = createSegmentDetector()
    const segments = feed(detector, [...silence(20), ...speech(25), ...silence(30), ...speech(25), ...silence(70)])
    expect(segments).toHaveLength(1)
    expect(segments[0]!.endedAt - segments[0]!.startedAt).toBeGreaterThan(1400)
  })

  it('discards bursts shorter than the minimum speech duration', () => {
    const detector = createSegmentDetector()
    expect(feed(detector, [...silence(20), ...tone(3, 440), ...silence(70)])).toEqual([])
    const pending = createSegmentDetector()
    feed(pending, [...silence(20), ...tone(5, 440)])
    expect(pending.flush()).toEqual([])
  })

  it('rejects isolated clicks', () => {
    const detector = createSegmentDetector()
    const frames: Int16Array[] = silence(20)
    for (let index = 0; index < 20; index += 1) {
      const click = new Int16Array(FRAME)
      click[0] = 30000
      frames.push(click, ...silence(12))
    }
    expect(feed(detector, frames)).toEqual([])
    expect(detector.flush()).toEqual([])
  })

  it('rejects stationary broadband noise above the threshold', () => {
    const detector = createSegmentDetector()
    expect(feed(detector, [...silence(20), ...noise(120, 0.5)])).toEqual([])
  })

  it('accepts a chirp whose zero-crossing rate stays in the speech band', () => {
    const detector = createSegmentDetector()
    const segments = feed(detector, [...silence(20), ...chirp(50), ...silence(70)])
    expect(segments).toHaveLength(1)
    expect(measuredFrequency(segments[0]!)).toBeGreaterThan(150)
  })

  it('flushes the microphone data that is still open', () => {
    const detector = createSegmentDetector()
    feed(detector, [...silence(20), ...tone(30, 440)])
    const segments = detector.flush()
    expect(segments).toHaveLength(1)
    expect(segments[0]!.endedAt - segments[0]!.startedAt).toBe(35 * 20)
    expect(detector.flush()).toEqual([])
  })

  it('resets the floor, the open segment, and the segment ids', () => {
    const detector = createSegmentDetector()
    feed(detector, [...silence(20), ...tone(30, 440), ...silence(70)])
    expect(detector.noiseFloor()).toBeDefined()
    detector.reset()
    expect(detector.noiseFloor()).toBeUndefined()
    const segments = feed(detector, [...silence(20), ...tone(30, 440), ...silence(70)])
    expect(segments).toHaveLength(1)
    expect(segments[0]!.id).toBe(0)
  })
})

describe('maximum segment length', () => {
  it('cuts continuous speech at 15 seconds and continues without overlap', () => {
    const detector = createSegmentDetector()
    const segments = feed(detector, [...silence(20), ...tone(800, 440)])
    expect(segments).toHaveLength(1)
    const first = segments[0]!
    expect(first.endedAt - first.startedAt).toBe(14980)
    const rest = detector.flush()
    expect(rest).toHaveLength(1)
    expect(rest[0]!.startedAt).toBe(first.endedAt)
    expect(rest[0]!.id).toBe(1)
  })

  it('cuts on an unvoiced frame and begins the next segment at the next word', () => {
    const detector = createSegmentDetector()
    const frames: Int16Array[] = silence(20)
    const voicedFrames = tone(1, 440)
    for (let index = 20; index < 820; index += 1) {
      frames.push(index % 59 === 20 ? voicedFrames[0]! : new Int16Array(FRAME))
    }
    const segments = feed(detector, frames)
    expect(segments).toHaveLength(1)
    // The forced cut happens on a silent frame, so trailing-silence trimming
    // ends the segment at the last voiced frame plus its 200 ms tail.
    expect(segments[0]!.endedAt - segments[0]!.startedAt).toBe(14480)
    expect(detector.flush()).toEqual([])
  })
})

describe('default word gate', () => {
  const segment: SpeechSegment = {
    id: 0,
    pcm: new Int16Array(FRAME * 30),
    startedAt: 0,
    endedAt: 600,
    peak: 0.3,
    rms: 0.1,
  }

  it('accepts a long, loud segment', () => {
    expect(energyWordGate(segment)).toBe(true)
  })

  it('rejects a short segment', () => {
    expect(energyWordGate({ ...segment, endedAt: 300 })).toBe(false)
  })

  it('rejects a quiet segment', () => {
    expect(energyWordGate({ ...segment, rms: 0.001 })).toBe(false)
  })

  it('rejects a segment whose peak is too low', () => {
    expect(energyWordGate({ ...segment, rms: 0.02, peak: 0.02 })).toBe(false)
  })
})
