/** Small pure helpers for cooldowns and spawn timers in game state. */

export interface Cooldown {
  readonly remainingSec: number
}

export const tickCooldown = (cooldown: Cooldown, dtSec: number): Cooldown => ({
  remainingSec: Math.max(0, cooldown.remainingSec - dtSec),
})

export const isReady = (cooldown: Cooldown): boolean => cooldown.remainingSec <= 0

export const startCooldown = (seconds: number): Cooldown => ({ remainingSec: seconds })
