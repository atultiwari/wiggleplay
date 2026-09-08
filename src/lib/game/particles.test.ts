import { createSeededRng } from './random'
import { drawParticles, spawnBurst, stepParticles } from './particles'

describe('particles', () => {
  it('spawns the requested number at the origin', () => {
    const burst = spawnBurst({ x: 10, y: 20 }, { count: 5, colors: ['#fff'] }, createSeededRng(1))
    expect(burst).toHaveLength(5)
    burst.forEach((p) => {
      expect(p.x).toBe(10)
      expect(p.y).toBe(20)
      expect(p.color).toBe('#fff')
      expect(p.life).toBe(p.maxLife)
    })
  })

  it('moves particles, applies gravity and removes dead ones', () => {
    const [p] = spawnBurst({ x: 0, y: 0 }, { count: 1, colors: ['#fff'], speed: [100, 100], life: [1, 1], gravity: 10 }, () => 0)
    const [moved] = stepParticles([p], 0.5)
    expect(moved.life).toBeCloseTo(0.5)
    expect(moved.vy).toBeCloseTo(p.vy + 5)
    expect(moved.x).toBeCloseTo(p.x + p.vx * 0.5)
    expect(stepParticles([moved], 1)).toHaveLength(0)
  })

  it('draws each particle as a circle with fading alpha', () => {
    const ctx = {
      globalAlpha: 1,
      fillStyle: '',
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
    } as unknown as CanvasRenderingContext2D
    const particles = spawnBurst({ x: 0, y: 0 }, { count: 3, colors: ['#abc'] }, createSeededRng(3))
    drawParticles(ctx, particles)
    expect(ctx.arc).toHaveBeenCalledTimes(3)
    expect(ctx.fill).toHaveBeenCalledTimes(3)
    expect(ctx.globalAlpha).toBe(1)
  })
})
