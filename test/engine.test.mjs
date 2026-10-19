import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createMatch, derive, fcLineFor, matchView, newCode, normalizeCode, fillAlliance, relayPorts, sortPorts, TYPES } from '../api/_engine.js';

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

test('full match: 3-2-1, autonomous 30 s, robots wait disabled, referee starts driver: 3-2-1, 90 s, ended', () => {
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

  // autonomous over: driver control does not start by itself, however long it waits
  for (const t of [go + 31_000, go + 300_000]) {
    d = derive(m, t);
    assert.equal(d.phase, 'waiting');
    assert.equal(d.seg.key, 'DRIVER');
    assert.deepEqual(d.enabled, { red: false, blue: false });
    assert.match(fcLineFor(m, 'red1', t), /^FC D 0 90 /);
  }
  assert.equal(matchView(m, relays, go + 31_000).canNext, true);
  assert.ok(applyAction(m, { action: 'next' }, relays, go + 10_000).error); // not during autonomous

  const at = go + 60_000;
  m = act(m, { action: 'next' }, relays, at);
  d = derive(m, at + 1000);
  assert.equal(d.phase, 'countdown');
  assert.equal(d.countdown, 2);
  assert.match(fcLineFor(m, 'red1', at + 1000), /^FC D 0 90 /);

  const go2 = at + 3000;
  d = derive(m, go2 + 100);
  assert.equal(d.go, true);
  assert.deepEqual(d.enabled, { red: true, blue: true });
  assert.match(fcLineFor(m, 'red1', go2 + 100), /^FC D 1 90 /);
  assert.match(fcLineFor(m, 'red1', go2 + 1000), /^FC D 1 89 /);

  d = derive(m, go2 + 91_000);
  assert.equal(d.phase, 'ended');
  assert.deepEqual(d.enabled, { red: false, blue: false });
  assert.match(fcLineFor(m, 'red1', go2 + 91_000), /^FC D 0 0 /);
});

test('skip autonomous: robots disabled until the referee starts driver control', () => {
  const relays = { A: rep(['COM3', 'COM6']) };
  const ready = readyMatch('M1V1', relays);
  assert.equal(matchView(ready, relays, T0).canSkipAuto, true);
  let m = act(ready, { action: 'start', skipAuto: true }, relays);
  let d = derive(m, T0 + 60_000);
  assert.equal(d.phase, 'waiting');
  assert.match(d.status, /AUTONOMOUS SKIPPED/);
  assert.deepEqual(d.enabled, { red: false, blue: false });
  assert.match(fcLineFor(m, 'red1', T0 + 60_000), /^FC D 0 90 /);

  m = act(m, { action: 'next' }, relays, T0 + 60_000);
  assert.equal(derive(m, T0 + 61_000).phase, 'countdown');
  assert.match(fcLineFor(m, 'red1', T0 + 63_500), /^FC D 1 90 /);

  // skills matches have nothing to skip
  const skills = readyMatch('SKILLS_DRIVER', { A: rep(['COM3']) });
  assert.equal(matchView(skills, { A: rep(['COM3']) }, T0).canSkipAuto, false);
  assert.ok(applyAction(skills, { action: 'start', skipAuto: true }, { A: rep(['COM3']) }, T0).error);
});

test('driver control pauses (robots disabled, clock frozen) and resumes where it was', () => {
  const relays = { A: rep(['COM3', 'COM6']) };
  let m = act(readyMatch('M1V1', relays), { action: 'start', skipAuto: true }, relays);
  m = act(m, { action: 'next' }, relays, T0);
  const go = T0 + 3000;
  assert.ok(applyAction(m, { action: 'pause' }, relays, T0 + 1000).error); // not in the countdown

  m = act(m, { action: 'pause' }, relays, go + 20_000);
  for (const t of [go + 21_000, go + 200_000]) {
    const d = derive(m, t);
    assert.equal(d.phase, 'paused');
    assert.equal(d.secsLeft, 70);
    assert.deepEqual(d.enabled, { red: false, blue: false });
    assert.match(fcLineFor(m, 'red1', t), /^FC D 0 70 /);
  }
  assert.ok(applyAction(m, { action: 'pause' }, relays, go + 30_000).error);

  m = act(m, { action: 'resume' }, relays, go + 200_000);
  let d = derive(m, go + 200_000);
  assert.equal(d.phase, 'running');
  assert.equal(d.secsLeft, 70);
  assert.match(fcLineFor(m, 'red1', go + 200_000), /^FC D 1 70 /);
  assert.equal(derive(m, go + 270_000).phase, 'ended');

  // autonomous cannot be paused
  const auto = act(readyMatch('M1V1', relays), { action: 'start' }, relays);
  assert.ok(applyAction(auto, { action: 'pause' }, relays, auto.startAt + 5000).error);
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

test('only controllers connected to their laptop can be assigned', () => {
  const relays = { A: { at: T0, robots: [
    { port: 'COM3', fcs: 'P|0|0|0', age: 0.2, error: null },
    { port: 'COM6', fcs: null, age: null, error: 'unplugged' },
  ] } };
  let m = createMatch('M1V1', 'ABC123', T0);
  assert.ok(applyAction(m, { action: 'assign', slot: 'red1', relay: 'A', port: 'COM6' }, relays, T0).error);
  m = act(act(m, { action: 'join', relay: 'A' }, relays), { action: 'autoassign' }, relays);
  assert.deepEqual(m.assign.red1, { relay: 'A', port: 'COM3' });
  assert.equal(m.assign.blue1, null);
  assert.deepEqual(matchView(m, relays, T0).relays[0].connected, ['COM3']);
});

test("joining as an alliance puts that laptop's controllers in that alliance's slots", () => {
  const relays = { A: rep(['COM3']), B: rep(['COM4', 'COM5']) };
  let m = createMatch('M2V2', 'ABC123', T0);
  m = act(m, { action: 'join', relay: 'B', alliance: 'blue' }, relays);   // blue joins first: still blue
  m = act(m, { action: 'join', relay: 'A', alliance: 'red' }, relays);
  assert.deepEqual(m.assign.blue1, { relay: 'B', port: 'COM4' });
  assert.deepEqual(m.assign.blue2, { relay: 'B', port: 'COM5' });
  assert.deepEqual(m.assign.red1, { relay: 'A', port: 'COM3' });
  assert.equal(m.assign.red2, null);
  assert.deepEqual(m.roles, { B: 'blue', A: 'red' });
  const v = matchView(m, relays, T0);
  assert.equal(v.relays.find((r) => r.name === 'B').alliance, 'blue');
  // auto-assign keeps every laptop on its own side
  m = act(m, { action: 'autoassign' }, relays);
  assert.deepEqual([m.assign.red1.relay, m.assign.blue1.relay, m.assign.blue2.relay], ['A', 'B', 'B']);
});

test('alliance joins: one laptop per side, missing side, switching sides', () => {
  const relays = { A: rep(['COM3']), B: rep(['COM4']) };
  let m = createMatch('M1V1', 'ABC123', T0);
  m = act(m, { action: 'join', relay: 'A', alliance: 'red' }, relays);
  assert.match(applyAction(m, { action: 'join', relay: 'B', alliance: 'red' }, relays, T0).error, /red alliance is full \(A\)/);
  assert.match(applyAction(createMatch('SKILLS_AUTO', 'ABC123', T0), { action: 'join', relay: 'A', alliance: 'blue' }, relays, T0).error, /no blue/);
  m = act(m, { action: 'join', relay: 'A', alliance: 'blue' }, relays);   // changed their mind: red is free again
  assert.equal(m.assign.red1, null);
  assert.deepEqual(m.assign.blue1, { relay: 'A', port: 'COM3' });
  m = act(m, { action: 'join', relay: 'B', alliance: 'red' }, relays);
  assert.deepEqual(matchView(m, relays, T0).alliances, { red: ['B'], blue: ['A'] });
  // leaving frees the side
  m = act(m, { action: 'leave', relay: 'B' }, relays);
  assert.deepEqual(matchView(m, relays, T0).alliances, { red: [], blue: ['A'] });
});

test('an alliance joins before its controllers: they take its slots when they connect', () => {
  let relays = { A: rep([]) };
  let m = createMatch('M2V2', 'ABC123', T0);
  m = act(m, { action: 'join', relay: 'A', alliance: 'red' }, relays);   // no controller: no prompt, no error
  assert.deepEqual([m.assign.red1, m.assign.red2], [null, null]);
  relays = { A: rep(['CTRL1']) };
  m = fillAlliance(m, 'A', relays.A);
  assert.deepEqual(m.assign.red1, { relay: 'A', port: 'CTRL1' });
  relays = { A: rep(['CTRL1', 'CTRL2']) };
  m = fillAlliance(m, 'A', relays.A);
  assert.deepEqual(m.assign.red2, { relay: 'A', port: 'CTRL2' });
  assert.equal(fillAlliance(m, 'A', relays.A), null);   // nothing new: no write
  assert.equal(m.assign.blue1, null);                    // never the other side
  const running = { ...m, assign: { ...m.assign, red2: null }, period: 0, startAt: T0 };
  assert.equal(fillAlliance(running, 'A', relays.A), null);   // nothing moves once the match has started
});

test('one game master: the first device claims it, others need a takeover; controls follow that device', () => {
  const relays = { A: rep(['COM3']), B: rep(['COM4']) };
  let m = createMatch('M1V1', 'ABC123', T0);
  m = act(m, { action: 'claim', device: 'dev-1' }, relays);
  assert.match(applyAction(m, { action: 'claim', device: 'dev-2' }, relays, T0).error, /already has a game master/);
  m = act(m, { action: 'join', relay: 'A', alliance: 'red' }, relays);
  m = act(m, { action: 'join', relay: 'B', alliance: 'blue' }, relays);
  assert.match(applyAction(m, { action: 'start', device: 'dev-2' }, relays, T0).error, /only the game master/);
  assert.match(applyAction(m, { action: 'start' }, relays, T0).error, /only the game master/);
  assert.equal(applyAction(m, { action: 'start', device: 'dev-1' }, relays, T0).error, undefined);
  // dev-1 is still here (its page checked in 5 s ago): no takeover without the PIN
  assert.match(applyAction(m, { action: 'claim', device: 'dev-2', takeover: true, gmSeenAt: T0 + 10_000 }, relays, T0 + 15_000).error, /still here/);
  assert.equal(applyAction(m, { action: 'claim', device: 'dev-2', takeover: true, admin: true, gmSeenAt: T0 + 10_000 }, relays, T0 + 15_000).error, undefined);
  m = act(m, { action: 'claim', device: 'dev-2', takeover: true, gmSeenAt: T0 + 10_000 }, relays, T0 + 26_000);   // dev-1 went away 16 s ago
  assert.equal(matchView(m, relays, T0).gmDevice, 'dev-2');
  assert.match(applyAction(m, { action: 'start', device: 'dev-1' }, relays, T0).error, /only the game master/);
  m = act(m, { action: 'kick', relay: 'A', device: 'dev-2' }, relays);
  assert.deepEqual(m.joined, ['B']);
  m = act(m, { action: 'unclaim', device: 'dev-2' }, relays);
  assert.equal(m.gm, null);
});

test('1v1 on two laptops: a laptop left in an older match still follows the match it is playing', () => {
  // B tried a Skills run first and nobody closed it; then the 1v1 started. Storage order must not matter.
  const relays = { A: rep(['CTRL1']), B: rep(['CTRL1']) };
  let old = createMatch('SKILLS_DRIVER', 'OLD111', T0 - 600_000);
  old = act(old, { action: 'join', relay: 'B', alliance: 'red' }, relays, T0 - 600_000);
  let m = createMatch('M1V1', 'NEW222', T0);
  m = act(m, { action: 'join', relay: 'A', alliance: 'red' }, relays);
  m = act(m, { action: 'join', relay: 'B', alliance: 'blue' }, relays);
  m = act(m, { action: 'start' }, relays);
  const now = T0 + 3_000 + 5_000;   // autonomous, 5 s in
  for (const order of [[old, m], [m, old]]) {
    assert.match(relayPorts(order, 'B', now).ports.CTRL1.line, /^FC A 1 25 /);
    assert.equal(relayPorts(order, 'B', now).ports.CTRL1.code, 'NEW222');
    assert.match(relayPorts(order, 'A', now).ports.CTRL1.line, /^FC A 1 25 /);
  }
  // with nothing running, the newest match wins
  const idle = act(m, { action: 'reset' }, relays, now);
  assert.equal(relayPorts([idle, old], 'B', now).ports.CTRL1.code, 'NEW222');
});

test('END MATCH: final time kept, robots released, nothing can restart or join it', () => {
  const relays = { A: rep(['CTRL1']), B: rep(['CTRL1']) };
  let m = createMatch('M1V1', 'END111', T0);
  m = act(m, { action: 'join', relay: 'A', alliance: 'red' }, relays);
  m = act(m, { action: 'join', relay: 'B', alliance: 'blue' }, relays);
  m = act(m, { action: 'start' }, relays);
  const at = T0 + 3_000 + 12_000;   // autonomous, 12 s in
  assert.ok(relayPorts([m], 'A', at).ports.CTRL1.line);
  m = act(m, { action: 'end' }, relays, at);
  const v = matchView(m, relays, at + 60_000);
  assert.equal(v.ended, true);
  assert.equal(v.clockText, '0:18');   // frozen where it was ended
  assert.equal(v.status, 'MATCH STOPPED');
  assert.deepEqual([v.canStart, v.canReset, v.canNext, v.canPause], [false, false, false, false]);
  // no entry for its controllers: the relays send FC OFF and hand the robots back
  assert.deepEqual(relayPorts([m], 'A', at + 1).ports, {});
  assert.equal(fcLineFor(m, 'red1', at + 1), null);
  for (const a of [{ action: 'reset' }, { action: 'start' }, { action: 'join', relay: 'A', alliance: 'red' }])
    assert.match(applyAction(m, a, relays, at + 1).error, /has ended/);
  assert.equal(act(m, { action: 'end' }, relays, at + 5).endedAt, at);   // ending twice changes nothing
  // a lobby that never started can be ended too
  assert.equal(matchView(act(createMatch('M1V1', 'END222', T0), { action: 'end' }, relays), relays, T0).ended, true);
});

test('the game master claim names its laptop, so the laptop list can mark it', () => {
  const relays = { A: rep(['COM3']) };
  let m = createMatch('M1V1', 'ABC123', T0);
  m = act(m, { action: 'join', relay: 'A' }, relays);
  m = act(m, { action: 'claim', device: 'dev-1', laptop: 'A' }, relays);
  assert.equal(matchView(m, relays, T0).gmLaptop, 'A');
  m = act(m, { action: 'claim', device: 'dev-2', takeover: true }, relays, T0 + 20_000);   // a phone or tablet: no laptop
  assert.equal(matchView(m, relays, T0).gmLaptop, null);
});

test('2v2: two laptops per side, one robot each; a third is turned away', () => {
  const relays = { R1: rep(['CTRL1']), R2: rep(['CTRL1']), B1: rep(['CTRL1']), B2: rep(['CTRL1']), X: rep(['CTRL1']) };
  let m = createMatch('M2V2', 'ABC123', T0);
  for (const [relay, alliance] of [['R1', 'red'], ['B1', 'blue'], ['R2', 'red'], ['B2', 'blue']]) m = act(m, { action: 'join', relay, alliance }, relays);
  assert.deepEqual(['red1', 'red2', 'blue1', 'blue2'].map((s) => m.assign[s].relay), ['R1', 'R2', 'B1', 'B2']);
  const v = matchView(m, relays, T0);
  assert.deepEqual(v.alliances, { red: ['R1', 'R2'], blue: ['B1', 'B2'] });
  assert.deepEqual(v.seats, { red: 2, blue: 2 });
  assert.equal(v.canStart, true);
  assert.match(applyAction(m, { action: 'join', relay: 'X', alliance: 'red' }, relays, T0).error, /red alliance is full \(R1, R2\)/);
  // 1v1 still takes one laptop per side
  const one = act(createMatch('M1V1', 'ABC123', T0), { action: 'join', relay: 'R1', alliance: 'red' }, relays);
  assert.match(applyAction(one, { action: 'join', relay: 'R2', alliance: 'red' }, relays, T0).error, /full/);
});

test('2v2: a red laptop with both controllers drives both robots until a second red laptop brings a controller', () => {
  let relays = { A: rep(['CTRL1', 'CTRL2']), B: rep([]) };
  let m = createMatch('M2V2', 'ABC123', T0);
  m = act(m, { action: 'join', relay: 'A', alliance: 'red' }, relays);
  const both = [{ relay: 'A', port: 'CTRL1' }, { relay: 'A', port: 'CTRL2' }];
  assert.deepEqual([m.assign.red1, m.assign.red2], both);
  m = act(m, { action: 'join', relay: 'B', alliance: 'red' }, relays);   // B has no controller: A keeps both
  assert.deepEqual([m.assign.red1, m.assign.red2], both);
  assert.equal(fillAlliance(m, 'B', relays.B), null);
  relays = { ...relays, B: rep(['CTRL1']) };
  m = fillAlliance(m, 'B', relays.B);   // B connects one: it takes RED 2 back from A
  assert.deepEqual([m.assign.red1, m.assign.red2], [{ relay: 'A', port: 'CTRL1' }, { relay: 'B', port: 'CTRL1' }]);
  assert.equal(fillAlliance(m, 'A', relays.A), null);   // A doesn't take it back while B drives it
  assert.equal(fillAlliance(m, 'B', relays.B), null);
  m = act(m, { action: 'leave', relay: 'B' }, relays);   // B leaves: A's second controller takes RED 2 again
  m = fillAlliance(m, 'A', relays.A);
  assert.deepEqual([m.assign.red1, m.assign.red2], both);
});

test('2v2: the second controller of a red laptop plugged in after another red laptop joined still gets RED 2', () => {
  let relays = { A: rep(['CTRL1']), B: rep([]) };
  let m = createMatch('M2V2', 'ABC123', T0);
  m = act(m, { action: 'join', relay: 'A', alliance: 'red' }, relays);
  m = act(m, { action: 'join', relay: 'B', alliance: 'red' }, relays);   // a second red laptop with nothing plugged in
  relays = { ...relays, A: rep(['CTRL1', 'CTRL2']) };
  m = fillAlliance(m, 'A', relays.A);
  assert.deepEqual([m.assign.red1, m.assign.red2], [{ relay: 'A', port: 'CTRL1' }, { relay: 'A', port: 'CTRL2' }]);
});

test('2v2 auto-assign: the laptops on a side take turns, one robot each before a second', () => {
  const relays = { A: rep(['CTRL1', 'CTRL2']), B: rep(['CTRL1']) };
  let m = createMatch('M2V2', 'ABC123', T0);
  m = act(m, { action: 'join', relay: 'A', alliance: 'red' }, relays);
  m = act(m, { action: 'join', relay: 'B', alliance: 'red' }, relays);
  m = act(m, { action: 'autoassign' }, relays);
  assert.deepEqual([m.assign.red1, m.assign.red2], [{ relay: 'A', port: 'CTRL1' }, { relay: 'B', port: 'CTRL1' }]);
});

test('a pulled-out controller shows as UNPLUGGED (not waiting); a gone laptop as OFFLINE; a dead one as ERROR', () => {
  let relays = { A: rep(['CTRL1']), B: rep(['CTRL1']) };
  let m = createMatch('M1V1', 'ABC123', T0);
  m = act(m, { action: 'join', relay: 'A', alliance: 'red' }, relays);
  m = act(m, { action: 'join', relay: 'B', alliance: 'blue' }, relays);
  const slot = (v, s) => v.slots.find((x) => x.slot === s);
  assert.equal(slot(matchView(m, relays, T0), 'red1').problem, null);
  relays = { ...relays, A: rep([]) };   // CTRL1 pulled out: laptop A still reports, without it
  let v = matchView(m, relays, T0);
  assert.equal(slot(v, 'red1').problem, 'unplugged');
  assert.match(slot(v, 'red1').status, /CTRL1 is unplugged from A/);
  assert.equal(v.canStart, false);
  assert.deepEqual(m.assign.red1, { relay: 'A', port: 'CTRL1' });   // kept: plugging it back in restores it
  assert.equal(slot(matchView(m, { ...relays, A: rep(['CTRL1']) }, T0), 'red1').problem, null);
  relays = { A: rep(['CTRL1'], T0 - 60_000), B: { at: T0, robots: [{ port: 'CTRL1', fcs: null, age: null, error: 'controller not answering (turned off?)' }] } };
  v = matchView(m, relays, T0);
  assert.deepEqual([slot(v, 'red1').problem, slot(v, 'blue1').problem], ['offline', 'error']);
});

test('the laptop list keeps one order whatever order storage returns: red, blue, others in the match, the rest', () => {
  const base = { A: rep(['CTRL1']), B: rep(['CTRL1']), GM: rep(['CTRL1']), Z: rep(['CTRL1']), C: rep(['CTRL1']) };
  let m = createMatch('M2V2', 'ABC123', T0);
  m = act(m, { action: 'join', relay: 'B', alliance: 'blue' }, base);   // blue joined first
  m = act(m, { action: 'join', relay: 'GM' }, base);
  m = act(m, { action: 'join', relay: 'A', alliance: 'red' }, base);
  const names = (relays) => matchView(m, relays, T0).laptops.map((l) => l.name);
  const reversed = Object.fromEntries(Object.entries(base).reverse());
  assert.deepEqual(names(base), ['A', 'B', 'GM', 'C', 'Z']);
  assert.deepEqual(names(reversed), ['A', 'B', 'GM', 'C', 'Z']);
  // B drops out for a moment: it keeps its row, marked offline
  const { B, ...withoutB } = base;
  const v = matchView(m, withoutB, T0);
  assert.deepEqual(v.laptops.map((l) => [l.name, l.online]), [['A', true], ['B', false], ['GM', true], ['C', true], ['Z', true]]);
});
