import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createMatch, derive, fcLineFor, matchView, newCode, normalizeCode, sortPorts, TYPES } from '../api/_engine.js';

const T0 = 1_700_000_000_000;
const rep = (ports, at = T0) => ({ at, robots: ports.map((p) => ({ port: p, fcs: 'P|0|0|0', age: 0.2, error: null })) });
const act = (m, a, relays, now = T0) => {
  const r = applyAction(m, a, relays, now);
  assert.equal(r.error, undefined, r.error);
  return r.match;
};

test('match types: skills are one robot, 1v1 two, 2v2 four', () => {
  assert.deepEqual(TYPES.SKILLS_AUTO.slots, ['red1']);
  assert.deepEqual(TYPES.SKILLS_DRIVER.slots, ['red1']);
  assert.deepEqual(TYPES.M1V1.slots, ['red1', 'blue1']);
  assert.deepEqual(TYPES.M2V2.slots, ['red1', 'red2', 'blue1', 'blue2']);
  assert.equal(createMatch('NOPE', 'ABC123', T0), null);
});

test('codes are 6 characters, upper case, without look-alikes; input is cleaned up', () => {
  for (let i = 0; i < 50; i++) assert.match(newCode(), /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(normalizeCode(' ab-c 123xyz '), 'ABC123');
});

test('ports sort naturally', () => {
  assert.deepEqual(sortPorts(['COM10', 'COM3', 'COM6']), ['COM3', 'COM6', 'COM10']);
});

test('2v2: two laptops join, auto-assign puts laptop A on red and laptop B on blue', () => {
  const relays = { A: rep(['COM6', 'COM3']), B: rep(['COM4', 'COM5']) };
  let m = createMatch('M2V2', 'ABC123', T0);
  m = act(m, { action: 'join', relay: 'A' }, relays);
  m = act(m, { action: 'join', relay: 'B' }, relays);
  m = act(m, { action: 'autoassign' }, relays);
  assert.deepEqual(m.assign.red1, { relay: 'A', port: 'COM3' });
  assert.deepEqual(m.assign.red2, { relay: 'A', port: 'COM6' });
  assert.deepEqual(m.assign.blue1, { relay: 'B', port: 'COM4' });
  assert.deepEqual(m.assign.blue2, { relay: 'B', port: 'COM5' });
  const v = matchView(m, relays, T0);
  assert.equal(v.canStart, true);
  assert.deepEqual(v.joined, ['A', 'B']);
});

test('1v1 works on one laptop with two controllers, or on two laptops with one each', () => {
  let m = createMatch('M1V1', 'ABC123', T0);
  let relays = { A: rep(['COM3', 'COM6']) };
  m = act(act(m, { action: 'join', relay: 'A' }, relays), { action: 'autoassign' }, relays);
  assert.deepEqual([m.assign.red1.port, m.assign.blue1.port], ['COM3', 'COM6']);

  m = createMatch('M1V1', 'ABC123', T0);
  relays = { A: rep(['COM3']), B: rep(['COM4']) };
  m = act(act(act(m, { action: 'join', relay: 'A' }, relays), { action: 'join', relay: 'B' }, relays), { action: 'autoassign' }, relays);
  assert.deepEqual([m.assign.red1.relay, m.assign.blue1.relay], ['A', 'B']);
});

test('cannot join with an offline laptop; START is blocked until every slot is ready', () => {
  const relays = { A: rep(['COM3']), B: rep(['COM4'], T0 - 60_000) };
  let m = createMatch('M1V1', 'ABC123', T0);
  assert.equal(applyAction(m, { action: 'join', relay: 'B' }, relays, T0).error?.includes('not online'), true);
  m = act(m, { action: 'join', relay: 'A' }, relays);
  m = act(m, { action: 'autoassign' }, relays);
  const r = applyAction(m, { action: 'start' }, relays, T0);
  assert.ok(r.error);
  assert.ok(r.blockers.some((b) => b.startsWith('BLUE 1')));
});

test('a robot that is not replying blocks START', () => {
  const quiet = { A: { at: T0, robots: [{ port: 'COM3', fcs: null, age: null, error: null }] } };
  let m = createMatch('SKILLS_DRIVER', 'ABC123', T0);
  m = act(act(m, { action: 'join', relay: 'A' }, quiet), { action: 'autoassign' }, quiet);
  assert.equal(matchView(m, quiet, T0).canStart, false);
  assert.match(matchView(m, quiet, T0).blockers[0], /no reply from robot/);
});

function readyMatch(type, relays) {
  let m = createMatch(type, 'ABC123', T0);
  for (const name of Object.keys(relays)) m = act(m, { action: 'join', relay: name }, relays);
  return act(m, { action: 'autoassign' }, relays);
}

test('full match: 3-2-1 countdown, autonomous 30 s, 3 s transition, driver 90 s, ended', () => {
  const relays = { A: rep(['COM3', 'COM6']) };
  let m = act(readyMatch('M1V1', relays), { action: 'start' }, relays);
  const go = m.startAt;
  assert.equal(go, T0 + 3000);

  let d = derive(m, T0 + 1000);
  assert.equal(d.phase, 'countdown');
  assert.equal(d.countdown, 2);
  assert.deepEqual(d.enabled, { red: false, blue: false });
  assert.match(fcLineFor(m, 'red1', T0 + 1000), /^FC A 0 30 /);

  d = derive(m, go + 500);
  assert.equal(d.go, true);
  assert.equal(d.clockText, 'GO!');
  assert.equal(d.seg.key, 'AUTO');
  assert.deepEqual(d.enabled, { red: true, blue: true });
  assert.match(fcLineFor(m, 'blue1', go + 500), /^FC A 1 30 /);

  d = derive(m, go + 12_000);
  assert.equal(d.secsLeft, 18);

  d = derive(m, go + 31_000); // transition: robots disabled, told the driver period is next
  assert.equal(d.seg.key, 'TRANSITION');
  assert.deepEqual(d.enabled, { red: false, blue: false });
  assert.match(fcLineFor(m, 'red1', go + 31_000), /^FC D 0 90 /);

  d = derive(m, go + 33_000); // the moment driver control begins
  assert.equal(d.seg.key, 'DRIVER');
  assert.deepEqual(d.enabled, { red: true, blue: true });
  assert.match(fcLineFor(m, 'red1', go + 33_000), /^FC D 1 90 /);
  assert.match(fcLineFor(m, 'red1', go + 34_000), /^FC D 1 89 /);

  d = derive(m, go + 124_000);
  assert.equal(d.phase, 'ended');
  assert.deepEqual(d.enabled, { red: false, blue: false });
  assert.match(fcLineFor(m, 'red1', go + 124_000), /^FC D 0 0 /);
});

test('autonomous run id stays the same through AUTO and changes for the next match', () => {
  const relays = { A: rep(['COM3', 'COM6']) };
  const ready = readyMatch('M1V1', relays);
  const m1 = act(ready, { action: 'start' }, relays, T0);
  const id = (m, now) => fcLineFor(m, 'red1', now).split(' ')[4];
  assert.equal(id(m1, T0 + 3500), id(m1, T0 + 20_000));
  const later = { A: rep(['COM3', 'COM6'], T0 + 200_000) }; // the laptop kept reporting
  const m2 = act(act(m1, { action: 'reset' }, later, T0 + 200_000), { action: 'start' }, later, T0 + 201_000);
  assert.notEqual(id(m1, T0 + 3500), id(m2, T0 + 205_000));
});

test('skills matches are a single 60 s period', () => {
  const relays = { A: rep(['COM3']) };
  const auto = act(readyMatch('SKILLS_AUTO', relays), { action: 'start' }, relays);
  assert.equal(derive(auto, auto.startAt + 100).secsLeft, 60);
  assert.match(fcLineFor(auto, 'red1', auto.startAt + 100), /^FC A 1 60 /);
  assert.equal(derive(auto, auto.startAt + 61_000).phase, 'ended');
  const drv = act(readyMatch('SKILLS_DRIVER', relays), { action: 'start' }, relays);
  assert.match(fcLineFor(drv, 'red1', drv.startAt + 100), /^FC D 1 60 /);
});

test('before START the robots get nothing (practice mode); STOP disables and freezes', () => {
  const relays = { A: rep(['COM3', 'COM6']) };
  const ready = readyMatch('M1V1', relays);
  assert.equal(fcLineFor(ready, 'red1', T0), null);
  let m = act(ready, { action: 'start' }, relays);
  const at = m.startAt + 10_000;
  m = act(m, { action: 'stop' }, relays, at);
  assert.equal(derive(m, at + 50_000).phase, 'stopped');
  assert.match(fcLineFor(m, 'red1', at + 50_000), /^FC A 0 20 /);
  m = act(m, { action: 'reset' }, relays, at + 60_000);
  assert.equal(derive(m, at + 60_000).phase, 'ready');
});

test('referee can disable one alliance mid-match; not before it runs', () => {
  const relays = { A: rep(['COM3', 'COM6']) };
  let m = act(readyMatch('M1V1', relays), { action: 'start' }, relays);
  assert.ok(applyAction(m, { action: 'toggle', alliance: 'red' }, relays, T0 + 1000).error);
  m = act(m, { action: 'toggle', alliance: 'red' }, relays, m.startAt + 5000);
  const d = derive(m, m.startAt + 6000);
  assert.deepEqual(d.enabled, { red: false, blue: true });
  assert.match(fcLineFor(m, 'red1', m.startAt + 6000), /^FC A 0 /);
});

test('slots and laptops are locked once the match has started; START cannot run twice', () => {
  const relays = { A: rep(['COM3', 'COM6']) };
  const m = act(readyMatch('M1V1', relays), { action: 'start' }, relays);
  assert.ok(applyAction(m, { action: 'autoassign' }, relays, T0 + 10).error);
  assert.ok(applyAction(m, { action: 'start' }, relays, T0 + 10).error);
  assert.ok(applyAction(m, { action: 'explode' }, relays, T0 + 10).error);
});

test('assigning a controller that is already used moves it; clearing a slot works', () => {
  const relays = { A: rep(['COM3', 'COM6']) };
  let m = createMatch('M1V1', 'ABC123', T0);
  m = act(m, { action: 'assign', slot: 'red1', relay: 'A', port: 'COM3' }, relays);
  m = act(m, { action: 'assign', slot: 'blue1', relay: 'A', port: 'COM3' }, relays);
  assert.equal(m.assign.red1, null);
  assert.deepEqual(m.assign.blue1, { relay: 'A', port: 'COM3' });
  m = act(m, { action: 'assign', slot: 'blue1', clear: true }, relays);
  assert.equal(m.assign.blue1, null);
  assert.ok(applyAction(m, { action: 'assign', slot: 'red1', relay: 'A', port: 'COM99' }, relays, T0).error);
});
