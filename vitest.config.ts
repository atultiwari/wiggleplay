import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default mergeConfig(
  viteConfig({ mode: 'test', command: 'serve' }),
  defineConfig({
    test: {
      exclude: ['**/node_modules/**', 'desktop/**', 'mobile/**'],
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html'],
        include: ['src/lib/**/*.ts', 'src/games/**/logic.ts', 'src/config/**/*.ts', 'src/components/catalogue/**/*.tsx', 'src/components/game/HoldButton.tsx', 'src/components/game/Hud.tsx'],
        exclude: ['src/lib/hands/HandTracker.ts', 'src/lib/hands/useHandTracking.ts', 'src/lib/camera/useCamera.ts', 'src/lib/audio/sfx.ts', 'src/lib/audio/voice.ts', 'src/lib/assets/images.ts'],
        thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
      },
    },
  }),
)
