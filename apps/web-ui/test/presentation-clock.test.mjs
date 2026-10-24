import assert from 'node:assert/strict';
import test from 'node:test';
import { watchPresentationClock } from '../src/presentation-clock.ts';

test('presentation ticks stop while hidden, refresh on resume, and stop after cleanup', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const page = new EventTarget();
  page.hidden = false;
  let ticks = 0;
  const stop = watchPresentationClock(() => ticks++, page);
  assert.equal(ticks, 1);
  t.mock.timers.tick(3000);
  assert.equal(ticks, 4);
  page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(10000);
  assert.equal(ticks, 4);
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(ticks, 5);
  t.mock.timers.tick(2000);
  assert.equal(ticks, 7);
  stop();
  t.mock.timers.tick(10000);
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(ticks, 7);
});

test('an initially hidden document has no timer until shown', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const page = new EventTarget(); page.hidden = true;
  let ticks = 0;
  const stop = watchPresentationClock(() => ticks++, page);
  t.mock.timers.tick(10000);
  assert.equal(ticks, 0);
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(ticks, 1);
  stop();
});
