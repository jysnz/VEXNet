import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, applyCommand, fcLine, initialState, secsOf, view, robotLines } from '../api/_lib.js';

const T0 = 1_000_000_000_000;
const run = (s, cmd, now) => applyCommand(s, cmd, now);

test('START counts down 3 s with robots disabled, then GO enables everyone in the run', () => {
  let s = run(initialState(T0), { cmd: 'start' }, T0);
  assert.equal(view(s, {}, T0).countdown, 3);
  assert.deepEqual(s.enabled, { red: false, blue: false });
  assert.equal(fcLine(s, 'red', T0 + 1000).startsWith('FC A 0 30'), true);

  [s] = advance(s, T0 + 3000);
  assert.equal(s.running, true);
  assert.deepEqual(s.enabled, { red: true, blue: true });
  const v = view(s, {}, T0 + 3500);
  assert.equal(v.go, true);
  assert.equal(v.clockText, 'GO!');
  assert.equal(secsOf(s, T0 + 3000 + 10_000), 20);
});

test('autonomous ends after 30 s: everyone disabled, moves on to driver control (90 s)', () => {
  let s = run(initialState(T0), { cmd: 'start' }, T0);
  [s] = advance(s, T0 + 3000 + 30_000);
  assert.equal(s.running, false);
  assert.deepEqual(s.enabled, { red: false, blue: false });
  assert.equal(s.period, 'DRIVER');
  assert.equal(s.secsLeft, 90);
});

test('a late read still lands in the right state (no instance had to be awake)', () => {
  let s = run(initialState(T0), { cmd: 'start' }, T0);
  [s] = advance(s, T0 + 10 * 60_000);
  assert.equal(s.running, false);
  assert.equal(s.period, 'DRIVER');
});

test('STOP freezes the clock and disables; the next START resumes from there', () => {
  let s = run(initialState(T0), { cmd: 'start' }, T0);
  [s] = advance(s, T0 + 3000);
  s = run(s, { cmd: 'stop' }, T0 + 3000 + 12_000);
  assert.equal(s.running, false);
  assert.equal(Math.round(s.secsLeft), 18);
  assert.deepEqual(s.enabled, { red: false, blue: false });
});

test('periods: autonomous 30 s, driver control 90 s', () => {
  const s = initialState(T0);
  const v = view(s, {}, T0);
  assert.equal(v.periods.find((p) => p.key === 'AUTO').secs, 30);
  assert.equal(v.periods.find((p) => p.key === 'DRIVER').secs, 90);
});

test('toggle enables one alliance with a fresh run id; mid-period it does not restart the routine', () => {
  let s = initialState(T0);
  const before = s.runId.red;
  s = run(s, { cmd: 'toggle', alliance: 'red' }, T0);
  assert.equal(s.enabled.red, true);
  assert.equal(s.runId.red, before + 1);
  assert.equal(fcLine(s, 'red', T0), `FC A 1 30 ${before + 1}`);
  s = run(s, { cmd: 'toggle', alliance: 'red' }, T0);
  assert.equal(fcLine(s, 'red', T0).startsWith('FC A 0'), true);

  let m = run(initialState(T0), { cmd: 'start' }, T0);
  [m] = advance(m, T0 + 3000);
  const id = m.runId.blue;
  m = run(m, { cmd: 'toggle', alliance: 'blue' }, T0 + 4000); // disable mid-period
  m = run(m, { cmd: 'toggle', alliance: 'blue' }, T0 + 5000); // re-enable
  assert.equal(m.runId.blue, id);
});

test('unticked alliances are left out of the run', () => {
  let s = initialState(T0);
  s = run(s, { cmd: 'inrun', alliance: 'blue', value: false }, T0);
  s = run(s, { cmd: 'start' }, T0);
  [s] = advance(s, T0 + 3000);
  assert.deepEqual(s.enabled, { red: true, blue: false });
});

test('release sends FC OFF; START takes control back', () => {
  let s = run(initialState(T0), { cmd: 'release' }, T0);
  assert.equal(fcLine(s, 'red', T0), 'FC OFF');
  s = run(s, { cmd: 'start' }, T0);
  assert.notEqual(fcLine(s, 'red', T0), 'FC OFF');
});

test('driver period sends D, programming skills sends A', () => {
  let s = run(initialState(T0), { cmd: 'select', key: 'DRIVER' }, T0);
  assert.equal(fcLine(s, 'red', T0), `FC D 0 90 ${s.runId.red}`);
  s = run(s, { cmd: 'select', key: 'PSKILLS' }, T0);
  assert.equal(fcLine(s, 'red', T0).startsWith('FC A 0 60'), true);
});

test('bad commands are rejected', () => {
  const s = initialState(T0);
  assert.equal(run(s, { cmd: 'select', key: 'NOPE' }, T0), null);
  assert.equal(run(s, { cmd: 'toggle', alliance: 'green' }, T0), null);
  assert.equal(run(s, { cmd: 'explode' }, T0), null);
});

test('robot status lines', () => {
  const rep = { name: 'LAPTOP', at: T0, robots: [{ port: 'COM3', fcs: 'A|1|1|7', age: 0.3 }, { port: 'COM6', fcs: null, age: null }] };
  const lines = robotLines(rep, T0 + 500);
  assert.equal(lines[0], 'laptop LAPTOP');
  assert.match(lines[1], /AUTO - ENABLED \(auton running\)/);
  assert.match(lines[2], /no reply from robot/);
  assert.deepEqual(robotLines(rep, T0 + 60_000), ['no relay laptop connected']);
  assert.match(robotLines({ ...rep, robots: [{ port: 'COM3', fcs: 'P|0|0|0', age: 0.1 }] }, T0)[1], /program running/);
});
