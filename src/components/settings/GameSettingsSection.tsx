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
  WIGGLE_MIRROR_RANGES,
  type GameSettingsKey,
  type SliceTolerance,
} from '../../lib/settings/schema'
import { useSettings } from '../../lib/settings/context'
import { ChoiceField, SliderField, ToggleField } from './fields'
import { formatPixels, formatSeconds, formatTimes } from './format'

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
