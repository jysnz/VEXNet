// Match logic, shared by the API and the tests. Pure: no storage, no clock of its own.
//
// A match is a timeline. Once started it holds absolute timestamps ("GO is at T"), so any
// serverless instance can work out the phase, the clock and who is enabled at any moment.
import { randomInt } from 'node:crypto';

export const ALLIANCES = ['red', 'blue'];
export const COUNTDOWN_MS = 3000; // "3, 2, 1" before every START (robots stay disabled)
export const GO_SHOW_MS = 1000; // how long "GO!" stays up
export const ROBOT_STALE_S = 2; // a robot silent this long counts as "no reply"
export const RELAY_STALE_MS = 5000; // a relay silent this long is offline

const AUTO = { key: 'AUTO', title: 'AUTONOMOUS', robot: 'A', secs: 30, enabled: true };
const TRANSITION = { key: 'TRANSITION', title: 'DRIVER CONTROL STARTS', robot: 'D', secs: 3, enabled: false };
const DRIVER = { key: 'DRIVER', title: 'DRIVER CONTROL', robot: 'D', secs: 90, enabled: true };
const FULL_MATCH = [AUTO, TRANSITION, DRIVER];

// What can be created. slots: one per robot. Red slots first, then blue.
export const TYPES = {
  SKILLS_AUTO: {
    title: 'Skills Challenge - Autonomous',
    blurb: 'One robot, 60 s of autonomous.',
    slots: ['red1'],
    program: [{ ...AUTO, secs: 60 }],
  },
  SKILLS_DRIVER: {
    title: 'Skills Challenge - Driver Control',
    blurb: 'One robot, 60 s of driver control.',
    slots: ['red1'],
    program: [{ ...DRIVER, secs: 60 }],
  },
  M1V1: {
    title: '1 v 1',
    blurb: 'Red vs blue. Autonomous, then driver control.',
    slots: ['red1', 'blue1'],
    program: FULL_MATCH,
  },
  M2V2: {
    title: '2 v 2',
    blurb: 'Two robots a side, usually two laptops. Autonomous, then driver control.',
    slots: ['red1', 'red2', 'blue1', 'blue2'],
    program: FULL_MATCH,
  },
};

export const slotAlliance = (slot) => (slot.startsWith('red') ? 'red' : 'blue');
export const slotLabel = (slot) => `${slotAlliance(slot).toUpperCase()} ${slot.slice(-1)}`;

const GREEN = '#2ECC71';
const ORANGE = '#FF8C00';
const WHITE = '#e6e6e6';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
export const normalizeCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

export function createMatch(type, code, now) {
  if (!TYPES[type]) return null;
  return {
    code,
    type,
    createdAt: now,
    joined: [], // relay (laptop) names, in the order they joined
    assign: Object.fromEntries(TYPES[type].slots.map((s) => [s, null])), // slot -> {relay, port}
    startAt: null, // ms epoch of GO while counting down / running
    stoppedAt: null,
    overrides: { red: false, blue: false }, // referee disabled this alliance mid-match
    runBase: { red: 0, blue: 0 },
  };
}

// ─── Timeline ───────────────────────────────────────────────────────────────
export function derive(m, now) {
  const t = TYPES[m.type];
  const prog = t.program;
  const totalMs = prog.reduce((a, s) => a + s.secs, 0) * 1000;
  const ref = m.stoppedAt ?? now;
  let phase = 'ready';
  let index = 0;
  let secsLeft = prog[0].secs;
  let elapsed = 0;

  if (m.startAt) {
    elapsed = ref - m.startAt;
    if (elapsed < 0) {
      phase = 'countdown';
      secsLeft = prog[0].secs;
    } else if (elapsed >= totalMs) {
      phase = 'ended';
      index = prog.length - 1;
      secsLeft = 0;
    } else {
      phase = 'running';
      let acc = 0;
      for (let i = 0; i < prog.length; i++) {
        const end = acc + prog[i].secs * 1000;
        if (elapsed < end) {
          index = i;
          secsLeft = Math.ceil((end - elapsed) / 1000);
          break;
        }
        acc = end;
      }
    }
    if (m.stoppedAt && phase !== 'ended') phase = 'stopped';
  }

  const seg = prog[index];
  const countdown = phase === 'countdown' ? Math.max(1, Math.ceil(-elapsed / 1000)) : 0;
  const go = phase === 'running' && index === 0 && elapsed < GO_SHOW_MS;
  const enabled = Object.fromEntries(ALLIANCES.map((a) => [a, phase === 'running' && seg.enabled && !m.overrides[a]]));

  // What the robots are told: the period letter, and the seconds left in it
  // (during the transition, the full length of the period that follows).
  const robot = seg.robot;
  const robotSecs = phase === 'running' && !seg.enabled && prog[index + 1] ? prog[index + 1].secs : secsLeft;

  let clockText = `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}`;
  let clockColor = phase === 'running' ? (seg.enabled ? GREEN : ORANGE) : phase === 'ready' ? WHITE : ORANGE;
  if (countdown) [clockText, clockColor] = [String(countdown), ORANGE];
  else if (go) [clockText, clockColor] = ['GO!', GREEN];
  else if (phase === 'running' && !seg.enabled) clockColor = ORANGE;

  let status;
  if (phase === 'ready') status = `${t.title}`;
  else if (phase === 'countdown') status = 'GET READY';
  else if (phase === 'running') status = seg.title;
  else if (phase === 'stopped') status = 'MATCH STOPPED';
  else status = 'MATCH ENDED';

  const runId = Object.fromEntries(ALLIANCES.map((a) => [a, m.runBase[a] + index]));
  return { phase, index, seg, secsLeft, countdown, go, enabled, robot, robotSecs, clockText, clockColor, status, runId };
}

// The line the relay sends one robot, see field_control.hpp: FC <A|D> <0|1> <secsLeft> <runId>.
// null before the match starts: robots stay in practice mode until a match engages them.
export function fcLineFor(m, slot, now) {
  if (!m.startAt) return null;
  const d = derive(m, now);
  const a = slotAlliance(slot);
  return `FC ${d.robot} ${d.enabled[a] ? 1 : 0} ${d.robotSecs} ${d.runId[a]}`;
}

// ─── Robots and laptops ─────────────────────────────────────────────────────
function describeRobot(r) {
  if (!r) return 'no reply from robot';
  if (r.error) return `ERROR: ${r.error}`;
  if (r.age === null || r.age === undefined || r.age > ROBOT_STALE_S || !r.fcs) return 'no reply from robot';
  const parts = String(r.fcs).split('|');
  if (parts.length < 3) return '?';
  if (parts[0] === 'P') return 'program running - waiting for field control';
  const period = parts[0] === 'A' ? 'AUTO' : 'DRIVER';
  if (parts[1] !== '1') return `${period} - disabled`;
  return `${period} - ENABLED${parts[2] === '1' ? ' (auton running)' : ''}`;
}

const robotReady = (r) => Boolean(r) && !r.error && r.age != null && r.age <= ROBOT_STALE_S && Boolean(r.fcs);

export const relayOnline = (rep, now) => Boolean(rep) && now - rep.at <= RELAY_STALE_MS;

// Natural port order: COM3 < COM6 < COM10.
const portKey = (p) => [String(p).replace(/\d+/g, ''), Number(String(p).replace(/\D+/g, '')) || 0];
export function sortPorts(ports) {
  return [...ports].sort((a, b) => {
    const [ta, na] = portKey(a);
    const [tb, nb] = portKey(b);
    return ta === tb ? na - nb : ta < tb ? -1 : 1;
  });
}

// ─── What the pages see ─────────────────────────────────────────────────────
export function matchView(m, relays, now) {
  const t = TYPES[m.type];
  const d = derive(m, now);
  const online = Object.fromEntries(Object.entries(relays).filter(([, r]) => relayOnline(r, now)));

  const slots = t.slots.map((slot) => {
    const a = m.assign[slot];
    const rep = a ? online[a.relay] : null;
    const robot = rep?.robots?.find((r) => r.port === a?.port);
    return {
      slot,
      label: slotLabel(slot),
      alliance: slotAlliance(slot),
      relay: a?.relay ?? null,
      port: a?.port ?? null,
      relayOnline: Boolean(rep),
      ready: Boolean(a) && Boolean(rep) && robotReady(robot),
      status: !a ? 'no controller assigned' : !rep ? `laptop ${a.relay} is offline` : describeRobot(robot),
    };
  });

  const blockers = [];
  if (m.startAt && d.phase !== 'ended' && d.phase !== 'stopped') blockers.push('match in progress');
  for (const s of slots) {
    if (!s.relay) blockers.push(`${s.label}: no controller assigned`);
    else if (!s.ready) blockers.push(`${s.label}: ${s.status}`);
  }
  const started = Boolean(m.startAt);

  return {
    now,
    code: m.code,
    type: m.type,
    typeTitle: t.title,
    program: t.program.map(({ title, secs, enabled }) => ({ title, secs, enabled })),
    phase: d.phase,
    status: d.status,
    clockText: d.clockText,
    clockColor: d.clockColor,
    countdown: d.countdown,
    go: d.go,
    secs: d.secsLeft,
    segment: d.phase === 'running' ? d.seg.title : null,
    enabled: d.enabled,
    overrides: m.overrides,
    started,
    canStart: !started && blockers.length === 0,
    canReset: started,
    blockers: started ? [] : blockers,
    joined: m.joined,
    slots,
    // Laptops that are online, with their controllers, for joining and assigning.
    relays: Object.entries(online).map(([name, r]) => ({
      name,
      joined: m.joined.includes(name),
      ports: sortPorts((r.robots ?? []).map((x) => x.port)),
    })),
  };
}

// ─── Actions ────────────────────────────────────────────────────────────────
// Returns {match} on success or {error}. `relays` is the (fresh) relay table.
export function applyAction(m, act, relays, now) {
  const t = TYPES[m.type];
  const next = structuredClone(m);
  const d = derive(next, now);
  const online = Object.fromEntries(Object.entries(relays).filter(([, r]) => relayOnline(r, now)));
  const editable = !next.startAt; // slots and laptops are fixed once a match is running

  switch (act.action) {
    case 'join': {
      if (!online[act.relay]) return { error: 'that laptop is not online (is its relay running?)' };
      if (!editable) return { error: 'the match has already started' };
      if (!next.joined.includes(act.relay)) next.joined.push(act.relay);
      return { match: next };
    }
    case 'leave': {
      if (!editable) return { error: 'the match has already started' };
      next.joined = next.joined.filter((r) => r !== act.relay);
      for (const s of t.slots) if (next.assign[s]?.relay === act.relay) next.assign[s] = null;
      return { match: next };
    }
    case 'assign': {
      if (!editable) return { error: 'the match has already started' };
      if (!t.slots.includes(act.slot)) return { error: 'unknown slot' };
      if (act.clear) {
        next.assign[act.slot] = null;
        return { match: next };
      }
      const rep = online[act.relay];
      if (!rep || !rep.robots?.some((r) => r.port === act.port)) return { error: 'that controller is not online' };
      for (const s of t.slots) if (next.assign[s]?.relay === act.relay && next.assign[s]?.port === act.port) next.assign[s] = null;
      next.assign[act.slot] = { relay: act.relay, port: act.port };
      if (!next.joined.includes(act.relay)) next.joined.push(act.relay);
      return { match: next };
    }
    case 'autoassign': {
      if (!editable) return { error: 'the match has already started' };
      // Controllers of the joined laptops, in join order then port order, fill red1, red2, blue1, blue2...
      const pool = [];
      for (const name of next.joined) {
        const rep = online[name];
        if (!rep) continue;
        for (const port of sortPorts((rep.robots ?? []).map((r) => r.port))) pool.push({ relay: name, port });
      }
      t.slots.forEach((s, i) => (next.assign[s] = pool[i] ?? null));
      return { match: next };
    }
    case 'start': {
      const view = matchView(next, relays, now);
      if (!view.canStart) return { error: view.blockers[0] ?? 'cannot start', blockers: view.blockers };
      next.startAt = now + COUNTDOWN_MS;
      next.stoppedAt = null;
      next.overrides = { red: false, blue: false };
      const base = (Math.floor(now / 1000) % 90000) * 10 + 10; // never reuses a run id a robot already ran
      next.runBase = { red: base, blue: base };
      return { match: next };
    }
    case 'stop':
      if (next.startAt && !next.stoppedAt && d.phase !== 'ended') next.stoppedAt = now;
      return { match: next };
    case 'reset':
      next.startAt = null;
      next.stoppedAt = null;
      next.overrides = { red: false, blue: false };
      return { match: next };
    case 'toggle':
      if (!ALLIANCES.includes(act.alliance)) return { error: 'unknown alliance' };
      if (d.phase !== 'running') return { error: 'only while the match is running' };
      next.overrides[act.alliance] = !next.overrides[act.alliance];
      return { match: next };
    default:
      return { error: 'unknown action' };
  }
}
