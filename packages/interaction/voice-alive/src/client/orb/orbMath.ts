/**
 * Geometry, palette, and motion math for the voice orb.
 *
 * Pure functions only. The React component owns the canvas, the animation
 * clock, and browser visibility; this module turns one state snapshot into the
 * contour points and paint calls that reproduce the approved design.
 * @module @deepseek-ai/dsh-voice-alive/client/orb/orbMath
 */

/** The five orb states from the product state machine. */
export type OrbState = 'muted' | 'listening' | 'thinking' | 'speaking' | 'error'

/** Every orb state in product order. */
export const ORB_STATES: readonly OrbState[] = ['muted', 'listening', 'thinking', 'speaking', 'error']

/** Named motion family; each state owns exactly one. */
export type OrbMotion = 'still' | 'breathe' | 'orbit' | 'reactive' | 'pulse'

/** Motion family rendered for each state. */
export const ORB_MOTION: Readonly<Record<OrbState, OrbMotion>> = {
  muted: 'still',
  listening: 'breathe',
  thinking: 'orbit',
  speaking: 'reactive',
  error: 'pulse',
}

/** Contour resolution of the orb body. */
export const ORB_CONTOUR_POINTS = 128

/** Fallback accent when the page declares no `--accent` token. */
const DEFAULT_ACCENT = '#f5f5f5'

/**
 * Resolve the accent token from a computed style declaration.
 * @param style - computed style of the canvas element.
 * @returns the `--accent` value, or a neutral white when the token is absent.
 */
export function accentFrom(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): string {
  const value = style.getPropertyValue('--accent').trim()
  return value === '' ? DEFAULT_ACCENT : value
}

/** Colour ramp of the orb body for one state. */
export interface OrbPalette {
  /** Highlight at the upper-left of the body. */
  readonly light: string
  /** Middle tone that carries most of the body. */
  readonly mid: string
  /** Lower body falloff. */
  readonly deep: string
  /** Rim-most body tone. */
  readonly deeper: string
  /** Soft halo behind the body. */
  readonly glow: string
  /** One-pixel silhouette rim. */
  readonly rim: string
}

function parseHex(value: string): readonly [number, number, number] {
  const number = Number.parseInt(value.replace('#', ''), 16)
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}

function mix(from: string, to: string, ratio: number): string {
  const [r1, g1, b1] = parseHex(from)
  const [r2, g2, b2] = parseHex(to)
  const mixChannel = (a: number, b: number): number => Math.round(a + (b - a) * ratio)
  return `rgb(${mixChannel(r1, r2)}, ${mixChannel(g1, g2)}, ${mixChannel(b1, b2)})`
}

function rgba(value: string, alpha: number): string {
  const [r, g, b] = parseHex(value)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Monochrome palette for one state, as approved in the orb design.
 * @param state - the state being drawn.
 * @returns the six body tones used by the painter.
 */
export function paletteFor(state: OrbState): OrbPalette {
  if (state === 'muted') {
    return {
      light: mix('#6e6e6e', '#ffffff', 0.42),
      mid: '#5a5a5a',
      deep: '#2a2a2a',
      deeper: '#101010',
      glow: 'rgba(255, 255, 255, 0.08)',
      rim: 'rgba(255, 255, 255, 0.10)',
    }
  }
  if (state === 'error') {
    return {
      light: '#ffffff',
      mid: '#e8e8e8',
      deep: '#4d4d4d',
      deeper: '#141414',
      glow: 'rgba(255, 255, 255, 0.2)',
      rim: 'rgba(255, 255, 255, 0.4)',
    }
  }
  const mid = state === 'thinking' ? '#bdbdbd' : '#cfcfcf'
  return {
    light: '#ffffff',
    mid,
    deep: mix(mid, '#111111', 0.72),
    deeper: '#0a0a0a',
    glow: 'rgba(255, 255, 255, 0.12)',
    rim: 'rgba(255, 255, 255, 0.18)',
  }
}

/** Amplitudes and speeds that shape one animation frame. */
export interface MotionProfile {
  /** Multiplier for the slow contour wobble. */
  readonly wobble: number
  /** Clock multiplier for idle motion. */
  readonly timeScale: number
  /** Multiplier for the loudness oscillation of each state. */
  readonly pulse: number
  /** Radians per second for the thinking ring. */
  readonly ringSpeed: number
}

/** Full motion, the default when the user makes no request. */
export const FULL_MOTION: MotionProfile = Object.freeze({ wobble: 1, timeScale: 1, pulse: 1, ringSpeed: 0.9 })

/** Calmer motion for `prefers-reduced-motion: reduce`; the orb still moves. */
export const CALM_MOTION: MotionProfile = Object.freeze({ wobble: 0.15, timeScale: 0.45, pulse: 0.35, ringSpeed: 0.2 })

/**
 * Choose the animation profile for the user's motion preference.
 * @param reduced - whether the document matches `prefers-reduced-motion: reduce`.
 * @returns the calm profile when reduced, otherwise full motion.
 */
export function motionProfile(reduced: boolean): MotionProfile {
  return reduced ? CALM_MOTION : FULL_MOTION
}

type IdleCurve = (time: number, pulse: number) => number

const IDLE_CURVES: Readonly<Record<OrbState, IdleCurve>> = {
  muted: () => 0,
  listening: (time, pulse) => 0.1 + Math.sin(time * 1.6) * 0.03 * pulse,
  thinking: (time, pulse) => 0.16 + Math.sin(time * 2.4) * 0.03 * pulse,
  speaking: (time, pulse) => 0.42 + (Math.sin(time * 9) * 0.18 + Math.sin(time * 15.7) * 0.1) * pulse,
  error: (time, pulse) => 0.07 + Math.sin(time * 1.1) * 0.02 * pulse,
}

/**
 * Idle loudness of a state when no external level is supplied.
 * @param state - the state being drawn.
 * @param time - accumulated animation seconds.
 * @param profile - motion profile of the current frame.
 * @returns a loudness in the 0..1 range.
 */
export function idleLevel(state: OrbState, time: number, profile: MotionProfile): number {
  return IDLE_CURVES[state](time, profile.pulse)
}

/**
 * Clamp an external loudness reading.
 * @param value - raw level from the audio pipeline.
 * @returns the level clamped to 0..1.
 */
export function normalizeLevel(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Ease a drawn level toward its target at the approved response rate.
 * @param current - level drawn in the previous frame.
 * @param target - level this frame wants to reach.
 * @param deltaSeconds - elapsed time since the previous frame.
 * @returns the smoothed level for this frame.
 */
export function smoothLevel(current: number, target: number, deltaSeconds: number): number {
  return current + (target - current) * Math.min(1, Math.max(0, deltaSeconds) * 9)
}

/**
 * Advance the animation clock; muted holds the clock so the body stays still.
 * @param time - accumulated animation seconds.
 * @param deltaSeconds - elapsed time since the previous frame.
 * @param state - the state being drawn.
 * @param profile - motion profile of the current frame.
 * @returns the clock value for this frame.
 */
export function advanceTime(time: number, deltaSeconds: number, state: OrbState, profile: MotionProfile): number {
  return state === 'muted' ? time : time + deltaSeconds * profile.timeScale
}

/** CSS and backing-store size of the canvas. */
export interface OrbCanvasSize {
  /** Drawing width in CSS pixels. */
  readonly width: number
  /** Drawing height in CSS pixels. */
  readonly height: number
  /** Device pixel ratio applied to the backing store, clamped to 1..2. */
  readonly ratio: number
}

/**
 * Size a canvas for crisp Retina drawing.
 * @param cssWidth - element width in CSS pixels.
 * @param cssHeight - element height in CSS pixels.
 * @param devicePixelRatio - display pixel ratio of the window.
 * @returns rounded CSS dimensions and the clamped ratio.
 */
export function canvasSize(cssWidth: number, cssHeight: number, devicePixelRatio: number): OrbCanvasSize {
  const usable = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  return {
    width: Math.max(1, Math.round(cssWidth)),
    height: Math.max(1, Math.round(cssHeight)),
    ratio: Math.min(Math.max(usable, 1), 2),
  }
}

/**
 * Radius of the undeformed body.
 * @param width - drawing width in CSS pixels.
 * @param height - drawing height in CSS pixels.
 * @returns the base radius in CSS pixels.
 */
function baseRadius(width: number, height: number): number {
  return Math.min(width, height) * (width < 180 ? 0.27 : 0.32)
}

function wobbleAt(angle: number, time: number, profile: MotionProfile): number {
  return (
    Math.sin(angle * 3 + time * 1.25) * 0.009
    + Math.sin(angle * 5 - time * 0.9) * 0.006
    + Math.sin(angle * 7 + time * 2.1) * 0.003
  ) * profile.wobble
}

function spectrumAt(angle: number, time: number): number {
  return 0.5 + 0.5 * Math.sin(angle * 2 + time * 5)
}

/** One contour point in CSS pixels. */
export type ContourPoint = readonly [number, number]

/** One animation frame of the orb. */
export interface OrbFrame {
  /** The state being drawn. */
  readonly state: OrbState
  /** Accumulated animation seconds. */
  readonly time: number
  /** Smoothed loudness in the 0..1 range. */
  readonly level: number
  /** Drawing width in CSS pixels. */
  readonly width: number
  /** Drawing height in CSS pixels. */
  readonly height: number
  /** Accent used by the thinking ring. */
  readonly accent: string
  /** Motion profile of the current frame. */
  readonly profile: MotionProfile
}

/**
 * Sample the deformed silhouette around the body.
 * @param frame - state, clock, loudness, size, and motion profile.
 * @returns 128 contour points ordered clockwise from angle zero.
 */
export function contourPoints(frame: OrbFrame): readonly ContourPoint[] {
  const centerX = frame.width / 2
  const centerY = frame.height / 2
  const base = baseRadius(frame.width, frame.height)
  const muted = frame.state === 'muted'
  const points: ContourPoint[] = []
  for (let index = 0; index < ORB_CONTOUR_POINTS; index += 1) {
    const angle = (index / ORB_CONTOUR_POINTS) * Math.PI * 2
    const wobble = wobbleAt(angle, frame.time, frame.profile)
    const sound = muted ? 0 : frame.level * 0.18 * spectrumAt(angle, frame.time)
    const radius = base * (1 + wobble + sound) * (muted ? 0.9 : 1)
    points.push([centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius])
  }
  return points
}

/** Gradient surface returned by a 2D context. */
export interface OrbGradient {
  /**
   * Add one colour stop to the gradient.
   * @param offset - position in the 0..1 range.
   * @param color - CSS colour of the stop.
   */
  addColorStop(offset: number, color: string): void
}

/**
 * The 2D context operations the orb painter uses.
 *
 * `CanvasRenderingContext2D` satisfies this surface structurally, while tests
 * can supply a recorder without owning a real canvas implementation.
 */
export interface Orb2DContext {
  /** Fill style assigned by the painter. */
  fillStyle: string | OrbGradient | CanvasPattern
  /** Stroke style assigned by the painter. */
  strokeStyle: string | OrbGradient | CanvasPattern
  /** Line width assigned by the painter. */
  lineWidth: number
  /** Shadow colour assigned by the painter. */
  shadowColor: string
  /** Shadow blur assigned by the painter. */
  shadowBlur: number
  /** Clear a rectangle. */
  clearRect(x: number, y: number, width: number, height: number): void
  /** Push the current drawing state. */
  save(): void
  /** Pop the previous drawing state. */
  restore(): void
  /** Start a path. */
  beginPath(): void
  /** Move the current point. */
  moveTo(x: number, y: number): void
  /** Append a cubic Bezier segment. */
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void
  /** Close the current path. */
  closePath(): void
  /** Append a circular arc. */
  arc(x: number, y: number, radius: number, start: number, end: number): void
  /** Fill the current path. */
  fill(): void
  /** Stroke the current path. */
  stroke(): void
  /** Clip to the current path. */
  clip(): void
  /** Fill a rectangle. */
  fillRect(x: number, y: number, width: number, height: number): void
  /** Translate the coordinate system. */
  translate(x: number, y: number): void
  /** Rotate the coordinate system. */
  rotate(angle: number): void
  /** Scale the coordinate system. */
  scale(x: number, y: number): void
  /** Replace the line dash pattern. */
  setLineDash(segments: number[]): void
  /** Create a radial gradient. */
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): OrbGradient
  /** Create a linear gradient. */
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): OrbGradient
  /** Replace the current transform. */
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
}

/**
 * Trace a closed Catmull-Rom contour through the sampled points.
 * @param ctx - 2D context that receives the path.
 * @param points - contour points in drawing order.
 */
export function traceContour(ctx: Orb2DContext, points: readonly ContourPoint[]): void {
  const count = points.length
  ctx.beginPath()
  if (count === 0) return
  // `contourPoints` always samples ORB_CONTOUR_POINTS entries; indexing the
  // closed ring below cannot leave the array.
  const first = points[0] as ContourPoint
  ctx.moveTo(first[0], first[1])
  for (let index = 0; index < count; index += 1) {
    const p0 = points[(index - 1 + count) % count] as ContourPoint
    const p1 = points[index] as ContourPoint
    const p2 = points[(index + 1) % count] as ContourPoint
    const p3 = points[(index + 2) % count] as ContourPoint
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1])
  }
  ctx.closePath()
}

/**
 * Paint one full orb frame.
 *
 * The painter is a faithful port of the approved reference: soft glow only
 * for live states, radial body gradient, clipped top highlight, specular dot,
 * bottom shade, edge falloff, and a one-pixel rim.
 * @param ctx - 2D context that receives the frame.
 * @param frame - state, clock, loudness, size, accent, and motion profile.
 */
export function drawOrb(ctx: Orb2DContext, frame: OrbFrame): void {
  const { state, time, level, width, height, accent, profile } = frame
  const centerX = width / 2
  const centerY = height / 2
  const base = baseRadius(width, height)
  const colors = paletteFor(state)
  const muted = state === 'muted'
  const points = contourPoints(frame)

  ctx.clearRect(0, 0, width, height)

  if (state === 'thinking') {
    ctx.save()
    ctx.translate(centerX, centerY)
    ctx.rotate(time * profile.ringSpeed)
    ctx.beginPath()
    ctx.arc(0, 0, base * 1.24, 0, Math.PI * 2)
    ctx.setLineDash([2, 12])
    ctx.lineWidth = 2
    ctx.strokeStyle = rgba(accent, 0.55)
    ctx.stroke()
    ctx.restore()
  }

  if (!muted) {
    ctx.save()
    traceContour(ctx, points)
    ctx.shadowColor = colors.glow
    ctx.shadowBlur = width < 180 ? 8 : 16 + level * 20
    ctx.fillStyle = colors.mid
    ctx.fill()
    ctx.restore()
  }

  traceContour(ctx, points)
  const body = ctx.createRadialGradient(
    centerX - base * 0.34, centerY - base * 0.38, base * 0.04,
    centerX, centerY, base * 1.16,
  )
  body.addColorStop(0, colors.light)
  body.addColorStop(0.16, '#ececec')
  body.addColorStop(0.46, colors.mid)
  body.addColorStop(0.76, colors.deep)
  body.addColorStop(1, colors.deeper)
  ctx.fillStyle = body
  ctx.fill()

  ctx.save()
  traceContour(ctx, points)
  ctx.clip()

  ctx.save()
  ctx.translate(centerX - base * 0.28, centerY - base * 0.36)
  ctx.scale(1, 0.62)
  const shine = ctx.createRadialGradient(0, 0, 0, 0, 0, base * 0.34)
  shine.addColorStop(0, 'rgba(255, 255, 255, 0.45)')
  shine.addColorStop(0.5, 'rgba(255, 255, 255, 0.08)')
  shine.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = shine
  ctx.fillRect(-base, -base, base * 2, base * 2)
  ctx.restore()

  const dot = ctx.createRadialGradient(
    centerX - base * 0.31, centerY - base * 0.38, 0,
    centerX - base * 0.31, centerY - base * 0.38, base * 0.075,
  )
  dot.addColorStop(0, 'rgba(255, 255, 255, 0.75)')
  dot.addColorStop(0.5, 'rgba(255, 255, 255, 0.25)')
  dot.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = dot
  ctx.beginPath()
  ctx.arc(centerX - base * 0.31, centerY - base * 0.38, base * 0.075, 0, Math.PI * 2)
  ctx.fill()

  const shade = ctx.createLinearGradient(centerX, centerY - base, centerX, centerY + base)
  shade.addColorStop(0, 'rgba(0, 0, 0, 0)')
  shade.addColorStop(0.55, 'rgba(0, 0, 0, 0.04)')
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.55)')
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, width, height)

  const edge = ctx.createRadialGradient(centerX, centerY, base * 0.62, centerX, centerY, base * 1.02)
  edge.addColorStop(0, 'rgba(0, 0, 0, 0)')
  edge.addColorStop(0.82, 'rgba(0, 0, 0, 0.16)')
  edge.addColorStop(1, 'rgba(0, 0, 0, 0.55)')
  ctx.fillStyle = edge
  ctx.fillRect(0, 0, width, height)
  ctx.restore()

  traceContour(ctx, points)
  ctx.lineWidth = 1.2
  ctx.strokeStyle = colors.rim
  ctx.stroke()
}
