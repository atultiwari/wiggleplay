/**
 * Friendly spoken prompts via the browser's speech synthesis.
 * Everything here degrades silently when speech is unavailable.
 */
export interface SpeakOptions {
  readonly rate?: number
  readonly pitch?: number
  /** Cancel anything currently being spoken. Defaults to true. */
  readonly interrupt?: boolean
}

const PREFERRED_VOICE_NAMES = [
  'Samantha',
  'Karen',
  'Moira',
  'Google US English',
  'Google UK English Female',
  'Microsoft Aria',
  'Microsoft Zira',
]

const isSpeechAvailable = (): boolean =>
  typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window

let cachedVoice: SpeechSynthesisVoice | null = null

export interface VoiceConfig {
  readonly enabled: boolean
  /** 0..1 */
  readonly volume: number
}

let voiceConfig: VoiceConfig = { enabled: true, volume: 1 }

export const configureVoice = (patch: Partial<VoiceConfig>): void => {
  voiceConfig = { ...voiceConfig, ...patch }
  if (!voiceConfig.enabled) stopSpeaking()
}

export const getVoiceConfig = (): VoiceConfig => voiceConfig

const pickVoice = (): SpeechSynthesisVoice | null => {
  if (cachedVoice) return cachedVoice
  const voices = window.speechSynthesis.getVoices()
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'))
  const preferred = PREFERRED_VOICE_NAMES.map((name) => english.find((v) => v.name.includes(name))).find(Boolean)
  cachedVoice = preferred ?? english[0] ?? voices[0] ?? null
  return cachedVoice
}

/** Warm up the voice list; browsers load voices asynchronously. */
export const primeVoices = (): void => {
  if (!isSpeechAvailable()) return
  pickVoice()
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    cachedVoice = null
    pickVoice()
  })
}

export const say = (text: string, options: SpeakOptions = {}): boolean => {
  if (!isSpeechAvailable() || !voiceConfig.enabled) return false
  try {
    if (options.interrupt ?? true) window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    const voice = pickVoice()
    if (voice) utterance.voice = voice
    utterance.rate = options.rate ?? 0.95
    utterance.pitch = options.pitch ?? 1.15
    utterance.volume = Math.min(1, Math.max(0, voiceConfig.volume))
    window.speechSynthesis.speak(utterance)
    return true
  } catch (error) {
    console.warn('[voice] failed to speak', error)
    return false
  }
}

export const stopSpeaking = (): void => {
  if (isSpeechAvailable()) window.speechSynthesis.cancel()
}

/**
 * A speaker that ignores requests arriving within `cooldownMs` of the last one,
 * so fast games do not turn into a wall of chatter.
 */
export const createThrottledSpeaker = (cooldownMs: number, now: () => number = () => Date.now()) => {
  let lastSpokenAt = -Infinity
  return (text: string, options?: SpeakOptions): boolean => {
    const current = now()
    if (current - lastSpokenAt < cooldownMs) return false
    lastSpokenAt = current
    return say(text, options)
  }
}
