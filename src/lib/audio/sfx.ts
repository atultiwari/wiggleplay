/**
 * Procedural sound effects with the Web Audio API. No audio files needed,
 * so everything works offline and loads instantly.
 *
 * All sounds go through a master gain (user volume, up to 300 %) and a
 * limiter so "very loud" never turns into clipping.
 */
import { clamp } from '../math/vec'

export const MAX_EFFECTS_VOLUME = 3
export const DEFAULT_EFFECTS_VOLUME = 2

let audioContext: AudioContext | null = null
let masterGain: GainNode | null = null
let requestedVolume = DEFAULT_EFFECTS_VOLUME

const ensureGraph = (ctx: AudioContext): GainNode => {
  if (masterGain) return masterGain
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -10
  limiter.knee.value = 12
  limiter.ratio.value = 12
  limiter.attack.value = 0.002
  limiter.release.value = 0.15
  masterGain = ctx.createGain()
  masterGain.gain.value = requestedVolume
  masterGain.connect(limiter).connect(ctx.destination)
  return masterGain
}

/** Must be called from a user gesture (tap on the Play button) before any sound plays. */
export const unlockAudio = async (): Promise<boolean> => {
  try {
    audioContext ??= new AudioContext()
    if (audioContext.state === 'suspended') await audioContext.resume()
    ensureGraph(audioContext)
    return audioContext.state === 'running'
  } catch (error) {
    console.warn('[sfx] audio unavailable', error)
    return false
  }
}

/** 0 = mute, 1 = normal, 3 = very loud. Safe to call before audio is unlocked. */
export const setEffectsVolume = (volume: number): void => {
  requestedVolume = clamp(volume, 0, MAX_EFFECTS_VOLUME)
  if (masterGain && audioContext) {
    masterGain.gain.setTargetAtTime(requestedVolume, audioContext.currentTime, 0.02)
  }
}

export const getEffectsVolume = (): number => requestedVolume

interface ToneOptions {
  readonly from: number
  readonly to?: number
  readonly duration: number
  readonly type?: OscillatorType
  readonly gain?: number
  readonly delay?: number
}

const playTone = (ctx: AudioContext, options: ToneOptions): void => {
  const start = ctx.currentTime + (options.delay ?? 0)
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = options.type ?? 'sine'
  osc.frequency.setValueAtTime(options.from, start)
  if (options.to !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.to), start + options.duration)
  }
  const peak = options.gain ?? 0.35
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + options.duration)
  osc.connect(gain).connect(ensureGraph(ctx))
  osc.start(start)
  osc.stop(start + options.duration + 0.02)
}

const playNoise = (ctx: AudioContext, duration: number, filterFrequency: number, gainValue = 0.4): void => {
  const sampleCount = Math.floor(ctx.sampleRate * duration)
  const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < sampleCount; i += 1) data[i] = Math.random() * 2 - 1
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = filterFrequency
  filter.Q.value = 0.8
  const gain = ctx.createGain()
  const now = ctx.currentTime
  gain.gain.setValueAtTime(gainValue, now)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
  source.connect(filter).connect(gain).connect(ensureGraph(ctx))
  source.start(now)
}

const withContext = (play: (ctx: AudioContext) => void): void => {
  const ctx = audioContext
  if (!ctx || ctx.state !== 'running') return
  try {
    play(ctx)
  } catch (error) {
    console.warn('[sfx] failed to play', error)
  }
}

/** Bubble pop: quick downward chirp with a little click. */
export const playPop = (): void =>
  withContext((ctx) => {
    playTone(ctx, { from: 760, to: 160, duration: 0.14, gain: 0.5 })
    playNoise(ctx, 0.05, 2400, 0.25)
  })

/** Star catch: rising happy blip. */
export const playCatch = (): void =>
  withContext((ctx) => {
    playTone(ctx, { from: 520, to: 1040, duration: 0.18, type: 'triangle', gain: 0.45 })
    playTone(ctx, { from: 1040, to: 1560, duration: 0.14, type: 'triangle', delay: 0.12, gain: 0.3 })
  })

/** Sparkle: two tiny high blips. */
export const playSparkle = (): void =>
  withContext((ctx) => {
    playTone(ctx, { from: 1400, duration: 0.08, gain: 0.22 })
    playTone(ctx, { from: 2100, duration: 0.1, gain: 0.18, delay: 0.07 })
  })

/** Fruit slice: airy swish plus a wet thud. */
export const playSlice = (): void =>
  withContext((ctx) => {
    playNoise(ctx, 0.18, 1800, 0.55)
    playTone(ctx, { from: 220, to: 90, duration: 0.16, type: 'square', gain: 0.2 })
  })

/** Celebration arpeggio for milestones. */
export const playCheer = (): void =>
  withContext((ctx) => {
    const notes = [523.25, 659.25, 783.99, 1046.5]
    notes.forEach((frequency, i) =>
      playTone(ctx, { from: frequency, duration: 0.35, type: 'triangle', delay: i * 0.11, gain: 0.35 }),
    )
  })

/** Cat meow: a wobbly rising-then-falling tone. */
export const playMeow = (): void =>
  withContext((ctx) => {
    playTone(ctx, { from: 520, to: 880, duration: 0.18, type: 'sawtooth', gain: 0.14 })
    playTone(ctx, { from: 880, to: 480, duration: 0.3, type: 'sawtooth', gain: 0.16, delay: 0.16 })
    playTone(ctx, { from: 1040, to: 640, duration: 0.3, type: 'sine', gain: 0.12, delay: 0.16 })
  })

/** Bus horn: two short beeps. */
export const playHonk = (): void =>
  withContext((ctx) => {
    ;[0, 0.22].forEach((delay) => {
      playTone(ctx, { from: 330, duration: 0.16, type: 'square', gain: 0.22, delay })
      playTone(ctx, { from: 415, duration: 0.16, type: 'square', gain: 0.18, delay })
    })
  })

/** Aeroplane whoosh: a rising, airy sweep. */
export const playWhoosh = (): void =>
  withContext((ctx) => {
    playNoise(ctx, 0.5, 900, 0.45)
    playTone(ctx, { from: 180, to: 720, duration: 0.45, type: 'triangle', gain: 0.12 })
  })

/** Cow moo: low, slow slide with a breathy top. */
export const playMoo = (): void =>
  withContext((ctx) => {
    playTone(ctx, { from: 160, to: 130, duration: 0.7, type: 'sawtooth', gain: 0.18 })
    playTone(ctx, { from: 320, to: 260, duration: 0.7, type: 'triangle', gain: 0.12 })
    playNoise(ctx, 0.5, 600, 0.08)
  })

/** Pig oink: two quick nasal grunts. */
export const playOink = (): void =>
  withContext((ctx) => {
    ;[0, 0.18].forEach((delay) => {
      playTone(ctx, { from: 240, to: 380, duration: 0.09, type: 'square', gain: 0.14, delay })
      playNoise(ctx, 0.08, 1200, 0.2)
    })
  })

/** Sheep baa: a wobbly mid tone. */
export const playBaa = (): void =>
  withContext((ctx) => {
    ;[0, 0.1, 0.2, 0.3, 0.4].forEach((delay, i) =>
      playTone(ctx, { from: i % 2 ? 360 : 400, duration: 0.12, type: 'sawtooth', gain: 0.13, delay }),
    )
  })

/** Chicken cluck: short pecky blips. */
export const playCluck = (): void =>
  withContext((ctx) => {
    ;[0, 0.14, 0.28, 0.5].forEach((delay, i) =>
      playTone(ctx, { from: i === 3 ? 900 : 620, to: i === 3 ? 500 : 420, duration: i === 3 ? 0.25 : 0.08, type: 'square', gain: 0.12, delay }),
    )
  })

/** Duck quack: a buzzy honk that drops. */
export const playQuack = (): void =>
  withContext((ctx) => {
    ;[0, 0.22].forEach((delay) => {
      playTone(ctx, { from: 520, to: 300, duration: 0.18, type: 'sawtooth', gain: 0.16, delay })
      playNoise(ctx, 0.12, 1500, 0.12)
    })
  })

/** Horse neigh: a high whinny falling into a rumble. */
export const playNeigh = (): void =>
  withContext((ctx) => {
    playTone(ctx, { from: 900, to: 1300, duration: 0.2, type: 'sawtooth', gain: 0.1 })
    playTone(ctx, { from: 1300, to: 400, duration: 0.5, type: 'sawtooth', gain: 0.14, delay: 0.2 })
    playTone(ctx, { from: 220, to: 160, duration: 0.4, type: 'triangle', gain: 0.1, delay: 0.5 })
  })

/** Dog woof: a short bark. */
export const playWoof = (): void =>
  withContext((ctx) => {
    playTone(ctx, { from: 300, to: 180, duration: 0.14, type: 'square', gain: 0.18 })
    playNoise(ctx, 0.1, 800, 0.2)
  })

/** Apple thud: a soft bump when a fruit lands. */
export const playThud = (): void =>
  withContext((ctx) => {
    playTone(ctx, { from: 180, to: 90, duration: 0.12, type: 'sine', gain: 0.3 })
    playNoise(ctx, 0.04, 500, 0.15)
  })

/** Painting note: a soft tone whose pitch follows the brush. */
export const playNote = (frequency: number, duration = 0.12): void =>
  withContext((ctx) => playTone(ctx, { from: frequency, duration, type: 'sine', gain: 0.14 }))

/** Musical scale used by the paint brush (C major pentatonic, two octaves). */
export const PENTATONIC = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0]
