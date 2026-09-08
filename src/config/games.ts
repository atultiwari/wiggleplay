export type GameCategory = 'camera' | 'touch' | 'voice' | 'motion'
export type AgeBand = '2-3' | '3-4' | '4-5'
export type Interest =
  | 'colours'
  | 'counting'
  | 'fruits'
  | 'movement'
  | 'drawing'
  | 'music'
  | 'animals'
  | 'shapes'
  | 'vehicles'
  | 'words'
export type GameStatus = 'ready' | 'soon'

export interface GameMeta {
  readonly id: string
  readonly title: string
  readonly blurb: string
  readonly howTo: string
  readonly category: GameCategory
  readonly ageBands: readonly AgeBand[]
  readonly interests: readonly Interest[]
  readonly skills: readonly string[]
  readonly emoji: string
  readonly accent: string
  readonly status: GameStatus
  /** How many hands the game makes use of; tracking fewer hands is faster. */
  readonly hands: 1 | 2
  /** The game needs full-body landmarks and always runs the pose model, whatever the interaction setting. */
  readonly requiresPose?: boolean
}

export const CATEGORIES: Readonly<Record<GameCategory, { label: string; emoji: string; blurb: string }>> = {
  camera: { label: 'Camera & Body', emoji: '📷', blurb: 'No keyboard, no mouse. Just wave, reach and wiggle in front of the camera.' },
  touch: { label: 'Touch & Tap', emoji: '👆', blurb: 'Big buttons and finger painting on a tablet.' },
  voice: { label: 'Voice & Sound', emoji: '🎤', blurb: 'Moo, clap, blow and sing to make things happen.' },
  motion: { label: 'Tilt & Shake', emoji: '📱', blurb: 'Tilt and shake the tablet to play.' },
}

export const AGE_BANDS: readonly { id: AgeBand; label: string }[] = [
  { id: '2-3', label: '2½ – 3 yrs' },
  { id: '3-4', label: '3 – 4 yrs' },
  { id: '4-5', label: '4 – 5 yrs' },
]

export const INTERESTS: Readonly<Record<Interest, { label: string; emoji: string }>> = {
  colours: { label: 'Colours', emoji: '🎨' },
  counting: { label: 'Counting', emoji: '🔢' },
  fruits: { label: 'Fruits', emoji: '🍎' },
  movement: { label: 'Movement', emoji: '🏃' },
  drawing: { label: 'Drawing', emoji: '✏️' },
  music: { label: 'Music', emoji: '🎵' },
  animals: { label: 'Animals', emoji: '🐄' },
  shapes: { label: 'Shapes', emoji: '🔺' },
  vehicles: { label: 'Vehicles', emoji: '🚌' },
  words: { label: 'First words', emoji: '💬' },
}

export const GAMES: readonly GameMeta[] = [
  {
    id: 'air-paint',
    title: 'Air Painting',
    blurb: 'Wave a finger in the air and watch colourful paint appear on screen.',
    howTo: 'Move to paint! Hold still over a colour at the top to pick it.',
    category: 'camera',
    ageBands: ['2-3', '3-4', '4-5'],
    interests: ['colours', 'drawing'],
    skills: ['Colour names', 'Fine motor', 'Creativity'],
    emoji: '🖌️',
    accent: '#ff7ab6',
    status: 'ready',
    hands: 1,
  },
  {
    id: 'catch-stars',
    title: 'Catch the Stars',
    blurb: 'Move your hand left and right to catch falling stars in a basket. Count them out loud!',
    howTo: 'Move left and right. The basket follows you. Catch the stars and we count together up to ten.',
    category: 'camera',
    ageBands: ['2-3', '3-4'],
    interests: ['counting', 'movement'],
    skills: ['Counting to 10', 'Tracking', 'Gross motor'],
    emoji: '⭐',
    accent: '#ffc531',
    status: 'ready',
    hands: 1,
  },
  {
    id: 'wave-pop',
    title: 'Wave to Pop',
    blurb: 'Bubbles float over your picture. Wave your hands to pop them and hear their colours.',
    howTo: 'Wiggle anywhere on the screen. Touch a bubble to pop it and hear its colour.',
    category: 'camera',
    ageBands: ['2-3', '3-4'],
    interests: ['colours', 'movement'],
    skills: ['Cause and effect', 'Colour names', 'Gross motor'],
    emoji: '🫧',
    accent: '#5cc8ff',
    status: 'ready',
    hands: 2,
  },
  {
    id: 'fruit-slice',
    title: 'Fruit Slice',
    blurb: 'Swipe your hand through the air to slice flying fruit. Learn every fruit name.',
    howTo: 'Swish across the screen to slice the fruit. No bombs, just yummy fruit!',
    category: 'camera',
    ageBands: ['2-3', '3-4', '4-5'],
    interests: ['fruits', 'movement', 'colours'],
    skills: ['Fruit names', 'Hand-eye coordination', 'Colours'],
    emoji: '🍉',
    accent: '#7ae582',
    status: 'ready',
    hands: 2,
  },
  {
    id: 'wiggle-mirror',
    title: 'Wiggle Mirror',
    blurb: 'The WigglePlay monster copies you! Wave, wiggle, jump and it does the same. Lift both hands for a hooray.',
    howTo: 'Stand back so I can see you. The monster copies everything you do. Put both hands up high for a hooray!',
    category: 'camera',
    ageBands: ['2-3', '3-4', '4-5'],
    interests: ['movement', 'music'],
    skills: ['Body awareness', 'Imitation', 'Gross motor'],
    emoji: '🪞',
    accent: '#b58cf0',
    status: 'ready',
    hands: 2,
    requiresPose: true,
  },
  {
    id: 'cat-tickle',
    title: 'Tickle the Cat',
    blurb: 'Cats pop up all over the screen. Tickle one and it meows, purrs and says its colour.',
    howTo: 'Cats are hiding everywhere! Touch a cat to tickle it and hear it meow.',
    category: 'camera',
    ageBands: ['2-3', '3-4'],
    interests: ['animals', 'colours', 'movement'],
    skills: ['Animal sounds', 'Colour names', 'Cause and effect'],
    emoji: '🐱',
    accent: '#fdba74',
    status: 'ready',
    hands: 2,
  },
  {
    id: 'toy-town',
    title: '3D Toy Town',
    blurb: 'A little 3D town in your room: touch the bus, the aeroplane and the cat with any part of your body to make them beep, whoosh and meow.',
    howTo: 'The toys live in your room! Reach out and touch the bus, the aeroplane or the cat. When the voice asks “Where is the cat?”, find it!',
    category: 'camera',
    ageBands: ['2-3', '3-4', '4-5'],
    interests: ['vehicles', 'animals', 'words', 'movement'],
    skills: ['First words', 'Listening', 'Reaching and pointing'],
    emoji: '🏘️',
    accent: '#a7f3d0',
    status: 'ready',
    hands: 1,
  },
  {
    id: 'fly-high',
    title: 'Fly High',
    blurb: 'Move up and down to fly the aeroplane through the clouds and collect balloons.',
    howTo: 'Move up and down to fly the aeroplane. Fly into the balloons and we count them together!',
    category: 'camera',
    ageBands: ['2-3', '3-4', '4-5'],
    interests: ['vehicles', 'counting', 'colours', 'movement'],
    skills: ['Up and down', 'Counting to 10', 'Colour names'],
    emoji: '✈️',
    accent: '#93c5fd',
    status: 'ready',
    hands: 1,
  },
  {
    id: 'bus-driver',
    title: 'Bus Driver',
    blurb: 'Drive the bus left and right to pick up cats, dogs and bunnies waiting at the bus stop.',
    howTo: 'You are the bus driver! Move left and right to pick up the passengers. Beep beep!',
    category: 'camera',
    ageBands: ['2-3', '3-4'],
    interests: ['vehicles', 'animals', 'counting'],
    skills: ['Left and right', 'Counting to 10', 'Animal names'],
    emoji: '🚌',
    accent: '#fde047',
    status: 'ready',
    hands: 1,
  },
  {
    id: 'beep-meow-whoosh',
    title: 'Beep Meow Whoosh',
    blurb: 'Aeroplanes, buses and cats cross the screen. Touch them to hear their sounds and names, then find the one we ask for.',
    howTo: 'Touch the aeroplanes, buses and cats to hear them. Listen out: sometimes we will ask you to find one!',
    category: 'camera',
    ageBands: ['2-3', '3-4'],
    interests: ['vehicles', 'animals', 'words', 'movement'],
    skills: ['First words', 'Listening', 'Sounds'],
    emoji: '🚍',
    accent: '#c4b5fd',
    status: 'ready',
    hands: 2,
  },
  {
    id: 'simon-says',
    title: 'Simon Says Mirror',
    blurb: 'Touch your nose, jump, clap! The camera checks your moves.',
    howTo: 'Coming soon.',
    category: 'camera',
    ageBands: ['3-4', '4-5'],
    interests: ['movement'],
    skills: ['Body parts', 'Listening'],
    emoji: '🪞',
    accent: '#c084fc',
    status: 'soon',
    hands: 2,
  },
  {
    id: 'tap-farm',
    title: 'Tap the Farm',
    blurb: 'Tap the animals to hear their sounds, then find the one we ask for.',
    howTo: 'Coming soon.',
    category: 'touch',
    ageBands: ['2-3', '3-4'],
    interests: ['animals'],
    skills: ['Animal names', 'Animal sounds'],
    emoji: '🐄',
    accent: '#fbbf24',
    status: 'soon',
    hands: 1,
  },
  {
    id: 'animal-call',
    title: 'Animal Call',
    blurb: 'What does the cow say? Moo back and make the cow dance.',
    howTo: 'Coming soon.',
    category: 'voice',
    ageBands: ['2-3', '3-4'],
    interests: ['animals', 'music'],
    skills: ['Animal sounds', 'Speaking confidence'],
    emoji: '🐮',
    accent: '#f97316',
    status: 'soon',
    hands: 1,
  },
  {
    id: 'shake-tree',
    title: 'Shake the Tree',
    blurb: 'Shake the tablet, apples fall, and we count them together.',
    howTo: 'Coming soon.',
    category: 'motion',
    ageBands: ['2-3', '3-4'],
    interests: ['counting', 'fruits'],
    skills: ['Counting', 'Cause and effect'],
    emoji: '🌳',
    accent: '#4ade80',
    status: 'soon',
    hands: 1,
  },
]

export const findGame = (id: string | undefined): GameMeta | undefined =>
  GAMES.find((game) => game.id === id)

export interface GameFilter {
  readonly category: GameCategory | 'all'
  readonly ageBand: AgeBand | 'all'
  readonly interest: Interest | 'all'
}

export const DEFAULT_FILTER: GameFilter = { category: 'all', ageBand: 'all', interest: 'all' }

export const filterGames = (games: readonly GameMeta[], filter: GameFilter): GameMeta[] =>
  games.filter(
    (game) =>
      (filter.category === 'all' || game.category === filter.category) &&
      (filter.ageBand === 'all' || game.ageBands.includes(filter.ageBand)) &&
      (filter.interest === 'all' || game.interests.includes(filter.interest)),
  )
