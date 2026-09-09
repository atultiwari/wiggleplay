// One version string for the whole build: sortable UTC date + short commit.
// Shared by the web bundle packer, the desktop build and the mobile sync script.
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

export const buildVersion = () => {
  if (process.env.WIGGLE_BUILD_VERSION) return process.env.WIGGLE_BUILD_VERSION
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  let sha = 'local'
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    /* not a git checkout */
  }
  return `${stamp}-${sha}`
}
