/** Central site identity. Used by the header, meta tags, README links and the manifest. */
export const SITE = {
  name: 'WigglePlay',
  tagline: 'Move, Play, Learn',
  title: 'WigglePlay — Move, Play, Learn',
  description:
    'Keyboard-free learning games for toddlers. WigglePlay uses the camera so little hands can paint in the air, pop bubbles, catch stars and slice fruit — turning screen time into wiggle time.',
  url: 'https://atultiwari.github.io/wiggleplay/',
  repo: 'https://github.com/atultiwari/wiggleplay',
  author: 'Atul Tiwari',
  minAgeYears: 2.5,
  themeColor: '#7c5cff',
} as const

export const SESSION = {
  /** Recommended play length per game before a gentle "bye bye" prompt. */
  suggestedMinutes: 5,
} as const
