import appleUrl from './apple.webp'
import bananaUrl from './banana.webp'
import grapesUrl from './grapes.webp'
import mascotUrl from './mascot.webp'
import orangeUrl from './orange.webp'
import starUrl from './star.webp'
import strawberryUrl from './strawberry.webp'
import watermelonUrl from './watermelon.webp'

export const ART = {
  mascot: mascotUrl,
  star: starUrl,
  apple: appleUrl,
  banana: bananaUrl,
  orange: orangeUrl,
  watermelon: watermelonUrl,
  strawberry: strawberryUrl,
  grapes: grapesUrl,
} as const

export type ArtKey = keyof typeof ART
