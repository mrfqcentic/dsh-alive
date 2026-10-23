/** Recording 2D context used by the orb tests; jsdom has no canvas backend. */
import type { Orb2DContext, OrbGradient } from '../src/client/orb/orbMath.ts'

/** Gradient that records every colour stop added by the painter. */
export class RecordingGradient implements OrbGradient {
  readonly stops: Array<{ offset: number; color: string }> = []

  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset, color })
  }
}

/** Minimal 2D context that records the calls and style writes of one frame. */
export class RecordingContext implements Orb2DContext {
  private fillValue: string | OrbGradient | CanvasPattern = ''
  private strokeValue: string | OrbGradient | CanvasPattern = ''

  get fillStyle(): string | OrbGradient | CanvasPattern { return this.fillValue }
  set fillStyle(value: string | OrbGradient | CanvasPattern) {
    this.fillValue = value
    this.fillStyles.push(value)
  }

  get strokeStyle(): string | OrbGradient | CanvasPattern { return this.strokeValue }
  set strokeStyle(value: string | OrbGradient | CanvasPattern) {
    this.strokeValue = value
    this.strokeStyles.push(value)
  }

  lineWidth = 0
  shadowColor = ''
  shadowBlur = 0

  readonly fillStyles: Array<string | OrbGradient | CanvasPattern> = []
  readonly strokeStyles: Array<string | OrbGradient | CanvasPattern> = []
  readonly gradients: RecordingGradient[] = []
  readonly moveToCalls: Array<readonly [number, number]> = []
  readonly bezierCalls: Array<readonly [number, number, number, number, number, number]> = []
  readonly arcCalls: Array<readonly [number, number, number, number, number]> = []
  readonly transforms: Array<readonly [number, number, number, number, number, number]> = []
  readonly lineDashes: number[][] = []
  readonly rotations: number[] = []
  readonly clearRects: Array<readonly [number, number, number, number]> = []
  saves = 0
  restores = 0
  fills = 0
  strokes = 0
  clips = 0
  fillRects = 0

  clearRect(x: number, y: number, width: number, height: number): void {
    this.clearRects.push([x, y, width, height])
  }

  save(): void { this.saves += 1 }
  restore(): void { this.restores += 1 }
  beginPath(): void { /* the painter's path starts are implicit in the calls */ }
  moveTo(x: number, y: number): void { this.moveToCalls.push([x, y]) }

  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    this.bezierCalls.push([cp1x, cp1y, cp2x, cp2y, x, y])
  }

  closePath(): void { /* no state to record */ }
  arc(x: number, y: number, radius: number, start: number, end: number): void {
    this.arcCalls.push([x, y, radius, start, end])
  }

  fill(): void { this.fills += 1 }
  stroke(): void { this.strokes += 1 }
  clip(): void { this.clips += 1 }
  fillRect(): void { this.fillRects += 1 }
  translate(): void { /* translation is not asserted by the orb tests */ }
  rotate(angle: number): void { this.rotations.push(angle) }
  scale(): void { /* scale is not asserted by the orb tests */ }

  setLineDash(segments: number[]): void { this.lineDashes.push(segments) }

  private recordGradient(): RecordingGradient {
    const gradient = new RecordingGradient()
    this.gradients.push(gradient)
    return gradient
  }

  createRadialGradient(): OrbGradient { return this.recordGradient() }
  createLinearGradient(): OrbGradient { return this.recordGradient() }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transforms.push([a, b, c, d, e, f])
  }
}
