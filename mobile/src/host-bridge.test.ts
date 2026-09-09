import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bridgeScript, parseHostCall, replyScript, statusScript } from './host-bridge.ts'

test('parseHostCall accepts only well-formed bridge messages', () => {
  assert.deepEqual(parseHostCall('{"id":3,"method":"check"}'), { id: 3, method: 'check', url: undefined })
  assert.deepEqual(parseHostCall('{"id":0,"method":"open","url":"https://x"}'), { id: 0, method: 'open', url: 'https://x' })
  assert.equal(parseHostCall('{"id":"3","method":"check"}'), null)
  assert.equal(parseHostCall('{"id":3,"method":"rm -rf"}'), null)
  assert.equal(parseHostCall('not json'), null)
})

test('scripts embed values safely', () => {
  assert.match(bridgeScript('android', '0.1.0'), /kind: "android"/)
  assert.equal(replyScript(2, { ok: true }), 'window.__wiggleHostReply(2, {"ok":true}, null); true;')
  assert.equal(replyScript(2, undefined, 'x"y'), 'window.__wiggleHostReply(2, null, "x\\"y"); true;')
  assert.equal(statusScript({ state: 'idle' }), 'window.__wiggleHostStatus({"state":"idle"}); true;')
})
