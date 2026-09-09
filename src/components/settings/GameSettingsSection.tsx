import { GAMES } from '../../config/games'
import {
  AIR_PAINT_RANGES,
  BEEP_MEOW_RANGES,
  BUS_DRIVER_RANGES,
  CAT_TICKLE_RANGES,
  CATCH_STARS_RANGES,
  FLY_HIGH_RANGES,
  FRUIT_SLICE_RANGES,
  GAME_SETTINGS_KEYS,
  SLICE_TOLERANCES,
  WAVE_POP_RANGES,
  ANIMAL_CALL_RANGES,
  SHAKE_TREE_RANGES,
  SIMON_SAYS_RANGES,
  TAP_FARM_RANGES,
  TOY_TOWN_RANGES,
  TRACE_RANGES,
  LETTER_ORDERS,
  type LetterOrder,
  WIGGLE_MIRROR_RANGES,
  type GameSettingsKey,
  type SliceTolerance,
} from '../../lib/settings/schema'
import { useSettings } from '../../lib/settings/context'
import { ChoiceField, SliderField, ToggleField } from './fields'
import { formatPercent, formatPixels, formatSeconds, formatTimes } from './format'

const TOLERANCE_LABELS: Readonly<Record<SliceTolerance, string>> = {
  fine: 'Fine',
  normal: 'Normal',
  generous: 'Near miss is OK',
}

const titleFor = (key: GameSettingsKey): string => {
  const game = GAMES.find((g) => GAME_SETTINGS_KEYS[g.id] === key)
  return game ? `${game.emoji} ${game.title}` : key
}

const WavePopFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.wavePop
  return (
    <>
      <SliderField id="wp-max" label="Bubbles on screen" value={v.maxBubbles} range={WAVE_POP_RANGES.maxBubbles} onChange={(maxBubbles) => updateGame('wavePop', { maxBubbles })} />
      <SliderField id="wp-interval" label="New bubble every" value={v.spawnIntervalSec} range={WAVE_POP_RANGES.spawnIntervalSec} format={formatSeconds} onChange={(spawnIntervalSec) => updateGame('wavePop', { spawnIntervalSec })} />
      <SliderField id="wp-size" label="Bubble size" value={v.bubbleSize} range={WAVE_POP_RANGES.bubbleSize} format={formatTimes} onChange={(bubbleSize) => updateGame('wavePop', { bubbleSize })} />
      <SliderField id="wp-speed" label="Rise speed" value={v.riseSpeed} range={WAVE_POP_RANGES.riseSpeed} format={formatTimes} onChange={(riseSpeed) => updateGame('wavePop', { riseSpeed })} />
    </>
  )
}

const FruitSliceFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.fruitSlice
  return (
    <>
      <SliderField id="fs-max" label="Fruit in the air" value={v.maxFruits} range={FRUIT_SLICE_RANGES.maxFruits} onChange={(maxFruits) => updateGame('fruitSlice', { maxFruits })} />
      <SliderField id="fs-interval" label="New fruit every" value={v.spawnIntervalSec} range={FRUIT_SLICE_RANGES.spawnIntervalSec} format={formatSeconds} onChange={(spawnIntervalSec) => updateGame('fruitSlice', { spawnIntervalSec })} />
      <SliderField id="fs-speed" label="Fruit speed" value={v.speed} range={FRUIT_SLICE_RANGES.speed} format={formatTimes} onChange={(speed) => updateGame('fruitSlice', { speed })} />
      <SliderField id="fs-size" label="Fruit size" value={v.fruitSize} range={FRUIT_SLICE_RANGES.fruitSize} format={formatTimes} onChange={(fruitSize) => updateGame('fruitSlice', { fruitSize })} />
      <ChoiceField
        label="Slice accuracy"
        value={v.tolerance}
        options={SLICE_TOLERANCES.map((value) => ({ value, label: TOLERANCE_LABELS[value] }))}
        onChange={(tolerance) => updateGame('fruitSlice', { tolerance })}
        hint="How close and how fast the hand must swipe to count as a slice."
      />
    </>
  )
}

const CatchStarsFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.catchStars
  return (
    <>
      <SliderField id="cs-speed" label="Fall speed" value={v.fallSpeed} range={CATCH_STARS_RANGES.fallSpeed} format={formatTimes} onChange={(fallSpeed) => updateGame('catchStars', { fallSpeed })} />
      <SliderField id="cs-interval" label="New star every" value={v.spawnIntervalSec} range={CATCH_STARS_RANGES.spawnIntervalSec} format={formatSeconds} onChange={(spawnIntervalSec) => updateGame('catchStars', { spawnIntervalSec })} />
      <SliderField id="cs-basket" label="Basket width" value={v.basketWidth} range={CATCH_STARS_RANGES.basketWidth} format={formatTimes} onChange={(basketWidth) => updateGame('catchStars', { basketWidth })} />
      <SliderField id="cs-size" label="Star size" value={v.starSize} range={CATCH_STARS_RANGES.starSize} format={formatTimes} onChange={(starSize) => updateGame('catchStars', { starSize })} />
    </>
  )
}

const AirPaintFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.airPaint
  return (
    <>
      <SliderField id="ap-brush" label="Brush size" value={v.brushSize} range={AIR_PAINT_RANGES.brushSize} format={formatPixels} onChange={(brushSize) => updateGame('airPaint', { brushSize })} />
      <SliderField id="ap-dwell" label="Hover time to pick a colour" value={v.dwellMs} range={AIR_PAINT_RANGES.dwellMs} format={(ms) => formatSeconds(ms / 1000)} onChange={(dwellMs) => updateGame('airPaint', { dwellMs })} />
      <ToggleField id="ap-fist" label="Making a fist lifts the brush" checked={v.fistLifts} onChange={(fistLifts) => updateGame('airPaint', { fistLifts })} hint="Turn off to paint whenever a hand is visible." />
    </>
  )
}

const CatTickleFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.catTickle
  return (
    <>
      <SliderField id="ct-max" label="Cats at once" value={v.maxCats} range={CAT_TICKLE_RANGES.maxCats} onChange={(maxCats) => updateGame('catTickle', { maxCats })} />
      <SliderField id="ct-interval" label="New cat every" value={v.appearIntervalSec} range={CAT_TICKLE_RANGES.appearIntervalSec} format={formatSeconds} onChange={(appearIntervalSec) => updateGame('catTickle', { appearIntervalSec })} />
      <SliderField id="ct-size" label="Cat size" value={v.catSize} range={CAT_TICKLE_RANGES.catSize} format={formatTimes} onChange={(catSize) => updateGame('catTickle', { catSize })} />
      <SliderField id="ct-stay" label="Cat waits for" value={v.stayForSec} range={CAT_TICKLE_RANGES.stayForSec} format={formatSeconds} onChange={(stayForSec) => updateGame('catTickle', { stayForSec })} />
    </>
  )
}

const FlyHighFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.flyHigh
  return (
    <>
      <SliderField id="fh-interval" label="New balloon every" value={v.balloonIntervalSec} range={FLY_HIGH_RANGES.balloonIntervalSec} format={formatSeconds} onChange={(balloonIntervalSec) => updateGame('flyHigh', { balloonIntervalSec })} />
      <SliderField id="fh-speed" label="Flying speed" value={v.speed} range={FLY_HIGH_RANGES.speed} format={formatTimes} onChange={(speed) => updateGame('flyHigh', { speed })} />
      <SliderField id="fh-size" label="Aeroplane size" value={v.planeSize} range={FLY_HIGH_RANGES.planeSize} format={formatTimes} onChange={(planeSize) => updateGame('flyHigh', { planeSize })} />
    </>
  )
}

const BusDriverFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.busDriver
  return (
    <>
      <SliderField id="bd-interval" label="New passenger every" value={v.passengerIntervalSec} range={BUS_DRIVER_RANGES.passengerIntervalSec} format={formatSeconds} onChange={(passengerIntervalSec) => updateGame('busDriver', { passengerIntervalSec })} />
      <SliderField id="bd-size" label="Bus size" value={v.busSize} range={BUS_DRIVER_RANGES.busSize} format={formatTimes} onChange={(busSize) => updateGame('busDriver', { busSize })} />
    </>
  )
}

const BeepMeowFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.beepMeow
  return (
    <>
      <SliderField id="bm-max" label="Things on screen" value={v.maxThings} range={BEEP_MEOW_RANGES.maxThings} onChange={(maxThings) => updateGame('beepMeow', { maxThings })} />
      <SliderField id="bm-speed" label="Speed" value={v.speed} range={BEEP_MEOW_RANGES.speed} format={formatTimes} onChange={(speed) => updateGame('beepMeow', { speed })} />
      <SliderField id="bm-size" label="Size" value={v.thingSize} range={BEEP_MEOW_RANGES.thingSize} format={formatTimes} onChange={(thingSize) => updateGame('beepMeow', { thingSize })} />
      <ToggleField id="bm-ask" label="Ask “Where is the…?” questions" checked={v.askQuestions} onChange={(askQuestions) => updateGame('beepMeow', { askQuestions })} hint="Gentle listening practice. There is no wrong answer." />
    </>
  )
}

const WiggleMirrorFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.wiggleMirror
  return (
    <>
      <SliderField id="wm-size" label="Monster size" value={v.puppetSize} range={WIGGLE_MIRROR_RANGES.puppetSize} format={formatTimes} onChange={(puppetSize) => updateGame('wiggleMirror', { puppetSize })} />
      <ToggleField id="wm-react" label="Hooray and jump reactions" checked={v.reactions} onChange={(reactions) => updateGame('wiggleMirror', { reactions })} hint="Confetti and cheers when both hands go up or the child jumps." />
      <ToggleField id="wm-skel" label="Show tracking skeleton" checked={v.showSkeleton} onChange={(showSkeleton) => updateGame('wiggleMirror', { showSkeleton })} hint="Draws the detected body over the camera picture (handy for set-up)." />
    </>
  )
}

const ToyTownFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.toyTown
  return (
    <>
      <SliderField id="tt-size" label="Toy size" value={v.propSize} range={TOY_TOWN_RANGES.propSize} format={formatTimes} onChange={(propSize) => updateGame('toyTown', { propSize })} />
      <SliderField id="tt-speed" label="Bus and plane speed" value={v.speed} range={TOY_TOWN_RANGES.speed} format={formatTimes} onChange={(speed) => updateGame('toyTown', { speed })} />
      <ToggleField id="tt-prompts" label="Ask “Where is the…?”" checked={v.prompts} onChange={(prompts) => updateGame('toyTown', { prompts })} hint="The voice asks for a toy every few seconds and cheers when the child finds it." />
      <ToggleField id="tt-cursor" label="Show the touch glow" checked={v.showCursor} onChange={(showCursor) => updateGame('toyTown', { showCursor })} hint="A soft glow follows the tracked hand or body so the child sees what they are touching." />
    </>
  )
}

const SimonSaysFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.simonSays
  return (
    <>
      <SliderField id="ss-gap" label="Pause between moves" value={v.gapSec} range={SIMON_SAYS_RANGES.gapSec} format={formatSeconds} onChange={(gapSec) => updateGame('simonSays', { gapSec })} />
      <ToggleField id="ss-hard" label="Harder moves (jump, one foot)" checked={v.harderMoves} onChange={(harderMoves) => updateGame('simonSays', { harderMoves })} hint="Adds jumping and standing on one foot for 3+ year olds." />
      <ToggleField id="ss-skel" label="Show tracking skeleton" checked={v.showSkeleton} onChange={(showSkeleton) => updateGame('simonSays', { showSkeleton })} hint="Draws the detected body over the camera picture (handy for set-up)." />
    </>
  )
}

const TapFarmFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.tapFarm
  return (
    <>
      <SliderField id="tf-count" label="Animals on the farm" value={v.animalCount} range={TAP_FARM_RANGES.animalCount} onChange={(animalCount) => updateGame('tapFarm', { animalCount })} />
      <SliderField id="tf-size" label="Animal size" value={v.animalSize} range={TAP_FARM_RANGES.animalSize} format={formatTimes} onChange={(animalSize) => updateGame('tapFarm', { animalSize })} />
      <ToggleField id="tf-ask" label="Ask “Where is the…?”" checked={v.askQuestions} onChange={(askQuestions) => updateGame('tapFarm', { askQuestions })} hint="The voice asks for an animal every few seconds and cheers when the child taps it." />
    </>
  )
}

const AnimalCallFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.animalCall
  return (
    <>
      <SliderField id="ac-loud" label="How loud to be" value={v.loudness} range={ANIMAL_CALL_RANGES.loudness} format={formatPercent} onChange={(loudness) => updateGame('animalCall', { loudness })} hint="Lower is easier: quiet rooms and shy children can go low." />
      <ToggleField id="ac-meter" label="Show the loudness meter" checked={v.showMeter} onChange={(showMeter) => updateGame('animalCall', { showMeter })} />
    </>
  )
}

const ShakeTreeFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.shakeTree
  return (
    <>
      <SliderField id="st-apples" label="Apples on the tree" value={v.appleCount} range={SHAKE_TREE_RANGES.appleCount} onChange={(appleCount) => updateGame('shakeTree', { appleCount })} />
      <SliderField id="st-shake" label="How hard to shake" value={v.shakeStrength} range={SHAKE_TREE_RANGES.shakeStrength} format={formatPercent} onChange={(shakeStrength) => updateGame('shakeTree', { shakeStrength })} hint="Lower is easier. On a laptop, dragging the tree works too." />
    </>
  )
}

const ORDER_LABELS: Readonly<Record<LetterOrder, string>> = { abc: 'A to Z', random: 'Mixed up' }

const AlphabetTrailFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.alphabetTrail
  return (
    <>
      <SliderField id="at-size" label="Diamond size" value={v.gemSize} range={TRACE_RANGES.gemSize} format={formatTimes} onChange={(gemSize) => updateGame('alphabetTrail', { gemSize })} hint="Bigger diamonds are spaced further apart and easier to hit." />
      <ChoiceField label="Letter order" value={v.order} options={LETTER_ORDERS.map((value) => ({ value, label: ORDER_LABELS[value] }))} onChange={(order) => updateGame('alphabetTrail', { order })} />
      <ToggleField id="at-words" label="Say a word for each letter" checked={v.sayWords} onChange={(sayWords) => updateGame('alphabetTrail', { sayWords })} hint="“A is for apple” after each letter." />
    </>
  )
}

const PathTracerFields = () => {
  const { settings, updateGame } = useSettings()
  const v = settings.pathTracer
  return (
    <>
      <SliderField id="pt-size" label="Ball size" value={v.gemSize} range={TRACE_RANGES.gemSize} format={formatTimes} onChange={(gemSize) => updateGame('pathTracer', { gemSize })} />
      <ToggleField id="pt-hard" label="Harder shapes (star, heart, spiral…)" checked={v.harderShapes} onChange={(harderShapes) => updateGame('pathTracer', { harderShapes })} />
    </>
  )
}

const FIELDS: Readonly<Record<GameSettingsKey, () => ReturnType<typeof WavePopFields>>> = {
  wavePop: WavePopFields,
  fruitSlice: FruitSliceFields,
  catchStars: CatchStarsFields,
  airPaint: AirPaintFields,
  catTickle: CatTickleFields,
  flyHigh: FlyHighFields,
  busDriver: BusDriverFields,
  beepMeow: BeepMeowFields,
  wiggleMirror: WiggleMirrorFields,
  toyTown: ToyTownFields,
  simonSays: SimonSaysFields,
  tapFarm: TapFarmFields,
  animalCall: AnimalCallFields,
  shakeTree: ShakeTreeFields,
  alphabetTrail: AlphabetTrailFields,
  pathTracer: PathTracerFields,
}

export const GameSettingsSection = ({ settingsKey, title }: { readonly settingsKey: GameSettingsKey; readonly title?: string }) => {
  const { resetGame } = useSettings()
  const Fields = FIELDS[settingsKey]
  return (
    <section className="settings__section" aria-label={title ?? titleFor(settingsKey)}>
      <div className="settings__section-head">
        <h3>{title ?? titleFor(settingsKey)}</h3>
        <button type="button" className="settings__reset" onClick={() => resetGame(settingsKey)}>
          Reset
        </button>
      </div>
      <Fields />
    </section>
  )
}
