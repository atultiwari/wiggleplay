import type { Point } from '../math/vec'
import { pickOne, randomBetween, type Rng } from './random'

export interface Particle {
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly life: number
  readonly maxLife: number
  readonly size: number
  readonly color: string
  readonly gravity: number
}

export interface BurstOptions {
  readonly count: number
  readonly colors: readonly string[]
  readonly speed?: readonly [number, number]
  readonly size?: readonly [number, number]
  readonly life?: readonly [number, number]
  readonly gravity?: number
}

export const spawnBurst = (origin: Point, options: BurstOptions, rng: Rng = Math.random): Particle[] => {
  const [speedMin, speedMax] = options.speed ?? [80, 320]
  const [sizeMin, sizeMax] = options.size ?? [4, 10]
  const [lifeMin, lifeMax] = options.life ?? [0.5, 1.1]
  return Array.from({ length: options.count }, () => {
    const angle = randomBetween(0, Math.PI * 2, rng)
    const speed = randomBetween(speedMin, speedMax, rng)
    const life = randomBetween(lifeMin, lifeMax, rng)
    return {
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      maxLife: life,
      size: randomBetween(sizeMin, sizeMax, rng),
      color: pickOne(options.colors, rng),
      gravity: options.gravity ?? 500,
    }
  })
}

export const stepParticles = (particles: readonly Particle[], dtSec: number): Particle[] =>
  particles
    .map((p) => ({
      ...p,
      x: p.x + p.vx * dtSec,
      y: p.y + p.vy * dtSec,
      vy: p.vy + p.gravity * dtSec,
      life: p.life - dtSec,
    }))
    .filter((p) => p.life > 0)

export const drawParticles = (ctx: CanvasRenderingContext2D, particles: readonly Particle[]): void => {
  for (const p of particles) {
    const alpha = Math.max(0, p.life / p.maxLife)
    ctx.globalAlpha = alpha
    ctx.fillStyle = p.color
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * alpha), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}
