/**
 * Procedural sound effects with the Web Audio API. No audio files needed,
 * so everything works offline and loads instantly.
 */
let audioContext: AudioContext | null = null

const getContext = (): AudioContext | null => audioContext

/** Must be called from a user gesture (tap on the Play button) before any sound plays. */
export const unlockAudio = async (): Promise<boolean> => {
  try {
    audioContext ??= new AudioContext()
    if (audioContext.state === 'suspended') await audioContext.resume()
    return audioContext.state === 'running'
  } catch (error) {
    console.warn('[sfx] audio unavailable', error)
    return false
  }
}

type OscType = OscillatorType

interface ToneOptions {
  readonly from: number
  readonly to?: number
  readonly duration: number
  readonly type?: OscType
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
  const peak = options.gain ?? 0.25
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + options.duration)
  osc.connect(gain).connect(ctx.destination)
  osc.start(start)
  osc.stop(start + options.duration + 0.02)
}

const playNoise = (ctx: AudioContext, duration: number, filterFrequency: number, gainValue = 0.3): void => {
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
  source.connect(filter).connect(gain).connect(ctx.destination)
  source.start(now)
}

const withContext = (play: (ctx: AudioContext) => void): void => {
  const ctx = getContext()
  if (!ctx || ctx.state !== 'running') return
  try {
    play(ctx)
  } catch (error) {
    console.warn('[sfx] failed to play', error)
  }
}

/** Bubble pop: quick downward chirp. */
export const playPop = (): void =>
  withContext((ctx) => playTone(ctx, { from: 700, to: 180, duration: 0.14, gain: 0.3 }))

/** Star catch: rising happy blip. */
export const playCatch = (): void =>
  withContext((ctx) => {
    playTone(ctx, { from: 520, to: 1040, duration: 0.18, type: 'triangle' })
    playTone(ctx, { from: 1040, to: 1560, duration: 0.14, type: 'triangle', delay: 0.12, gain: 0.18 })
  })

/** Sparkle: two tiny high blips. */
export const playSparkle = (): void =>
  withContext((ctx) => {
    playTone(ctx, { from: 1400, duration: 0.08, gain: 0.12 })
    playTone(ctx, { from: 2100, duration: 0.1, gain: 0.1, delay: 0.07 })
  })

/** Fruit slice: airy swish plus a wet thud. */
export const playSlice = (): void =>
  withContext((ctx) => {
    playNoise(ctx, 0.18, 1800, 0.35)
    playTone(ctx, { from: 220, to: 90, duration: 0.16, type: 'square', gain: 0.12 })
  })

/** Celebration arpeggio for milestones. */
export const playCheer = (): void =>
  withContext((ctx) => {
    const notes = [523.25, 659.25, 783.99, 1046.5]
    notes.forEach((frequency, i) =>
      playTone(ctx, { from: frequency, duration: 0.35, type: 'triangle', delay: i * 0.11, gain: 0.22 }),
    )
  })

/** Painting note: a soft tone whose pitch follows the brush. */
export const playNote = (frequency: number, duration = 0.12): void =>
  withContext((ctx) => playTone(ctx, { from: frequency, duration, type: 'sine', gain: 0.08 }))

/** Musical scale used by the paint brush (C major pentatonic, two octaves). */
export const PENTATONIC = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0]
