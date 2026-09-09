import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toServerPath } from './paths.ts'

test('turns a file URI into the plain path the static server needs', () => {
  assert.equal(toServerPath('file:///var/mobile/Containers/Data/Application/ABC/Documents/web'), '/var/mobile/Containers/Data/Application/ABC/Documents/web')
  assert.equal(toServerPath('file:///data/user/0/in.atultiwari.wiggleplay/files/web/'), '/data/user/0/in.atultiwari.wiggleplay/files/web')
  assert.equal(toServerPath('file:///Users/me/My%20Docs/web'), '/Users/me/My Docs/web')
  assert.equal(toServerPath('/already/plain'), '/already/plain')
})
