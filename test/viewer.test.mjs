import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, cleanOutput } from '../viewer.mjs';

test('separates kubectl timestamp and structured Pino message without discarding fields', () => {
  const entry = parseLog('2026-11-10T12:03:04.123456789Z {"level":50,"msg":"Database timeout","requestId":"req-42"}', 7);
  assert.equal(entry.time, '12:03:04');
  assert.equal(entry.level, 'error');
  assert.equal(entry.message, 'Database timeout');
  assert.equal(entry.index, 8);
  assert.equal(entry.json.requestId, 'req-42');
});
test('plain multiline traces and malformed JSON remain readable', () => {
  assert.equal(parseLog('    at Database.connect (app.js:12)').message, '    at Database.connect (app.js:12)');
  assert.equal(parseLog('{broken json').message, '{broken json');
  assert.equal(parseLog('2026-11-10T12:03:04Z WARNING reconnecting').level, 'warn');
  assert.equal(parseLog('2026-11-10T12:03:04Z INFO Request complete').message, 'Request complete');
  assert.equal(parseLog('{"severity":"ERROR","message":{"reason":"refused"}}').message, '{"reason":"refused"}');
});
test('terminal colors are removed without changing message contents', () => {
  assert.equal(cleanOutput('\x1b[31mERROR\x1b[0m <script>alert(1)</script>\r\n'), 'ERROR <script>alert(1)</script>\n');
});
