import appleUrl from './apple.webp'
import bananaUrl from './banana.webp'
import bunnyUrl from './bunny.webp'
import busUrl from './bus.webp'
import catBlackUrl from './cat-black.webp'
import catGreyUrl from './cat-grey.webp'
import catOrangeUrl from './cat-orange.webp'
import cloudUrl from './cloud.webp'
import dogUrl from './dog.webp'
import grapesUrl from './grapes.webp'
import mascotUrl from './mascot.webp'
import orangeUrl from './orange.webp'
import planeUrl from './plane.webp'
import starUrl from './star.webp'
import strawberryUrl from './strawberry.webp'
import watermelonUrl from './watermelon.webp'
import cowUrl from './cow.webp'
import pigUrl from './pig.webp'
import sheepUrl from './sheep.webp'
import chickenUrl from './chicken.webp'
import duckUrl from './duck.webp'
import horseUrl from './horse.webp'
import treeUrl from './tree.webp'
import barnUrl from './barn.webp'

export const ART = {
  mascot: mascotUrl,
  star: starUrl,
  apple: appleUrl,
  banana: bananaUrl,
  orange: orangeUrl,
  watermelon: watermelonUrl,
  strawberry: strawberryUrl,
  grapes: grapesUrl,
  catOrange: catOrangeUrl,
  catGrey: catGreyUrl,
  catBlack: catBlackUrl,
  plane: planeUrl,
  bus: busUrl,
  dog: dogUrl,
  bunny: bunnyUrl,
  cloud: cloudUrl,
  cow: cowUrl,
  pig: pigUrl,
  sheep: sheepUrl,
  chicken: chickenUrl,
  duck: duckUrl,
  horse: horseUrl,
  tree: treeUrl,
  barn: barnUrl,
} as const

export type ArtKey = keyof typeof ART
