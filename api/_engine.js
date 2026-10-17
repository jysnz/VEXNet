// Match logic, shared by the API and the tests. Pure: no storage, no clock of its own.
//
// A match is a list of periods (autonomous, driver control). The referee starts each one: START runs
// the first, and after it ends the robots wait disabled until START DRIVER CONTROL. A running period
// holds absolute timestamps ("GO is at T"), so any serverless instance can work out the phase, the
// clock and who is enabled at any moment.
import { randomInt } from 'node:crypto';

export const ALLIANCES = ['red', 'blue'];
export const COUNTDOWN_MS = 3000; // "3, 2, 1" before every START (robots stay disabled)
export const GO_SHOW_MS = 1000; // how long "GO!" stays up
export const ROBOT_STALE_S = 2; // a robot silent this long counts as "no reply"
export const RELAY_STALE_MS = 5000; // a relay silent this long is offline
export const GM_AWAY_MS = 15000; // a game master's page silent this long can be taken over by another device

const AUTO = { key: 'AUTO', title: 'AUTONOMOUS', robot: 'A', secs: 30 };
const DRIVER = { key: 'DRIVER', title: 'DRIVER CONTROL', robot: 'D', secs: 90 };
const FULL_MATCH = [AUTO, DRIVER];

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

export const allianceSlots = (type, alliance) => TYPES[type].slots.filter((s) => slotAlliance(s) === alliance);
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
    roles: {}, // relay -> 'red' | 'blue': the alliance a laptop joined as. A side takes one laptop per robot (2 in a 2v2).
    gm: null, // {device, at}: the one device running the match (it also needs the PIN)
    assign: Object.fromEntries(TYPES[type].slots.map((s) => [s, null])), // slot -> {relay, port}
    period: null, // index of the current period in the program; null before START
    startAt: null, // ms epoch of the current period's GO; null while it waits for the referee
    pausedAt: null, // driver control paused at this moment
    stoppedAt: null,
    endedAt: null, // the game master ended the match: robots released, every screen shows the result
    skippedAuto: false,
    overrides: { red: false, blue: false }, // referee disabled this alliance mid-match
    runBase: { red: 0, blue: 0 },
  };
}

// ─── Timeline ───────────────────────────────────────────────────────────────
const periodOf = (m) => m.period ?? (m.startAt ? 0 : null); // matches saved before periods existed
export const isStarted = (m) => periodOf(m) != null;
const hasAuto = (t) => t.program.length > 1 && t.program[0].key === 'AUTO';

// Phases: ready, countdown, running, paused, waiting (robots disabled until the referee starts the
// next period), stopped, ended.
export function derive(m, now) {
  const t = TYPES[m.type];
  const prog = t.program;
  const period = periodOf(m);
  let phase = 'ready';
  let index = 0;
  let secsLeft = prog[0].secs;
  let elapsed = 0;

  if (period != null) {
    index = period;
    secsLeft = prog[period].secs;
    if (m.startAt == null) phase = 'waiting';
    else {
      const len = prog[period].secs * 1000;
      elapsed = (m.pausedAt ?? m.stoppedAt ?? now) - m.startAt;
      if (elapsed < 0) phase = 'countdown';
      else if (elapsed >= len && period < prog.length - 1) {
        phase = 'waiting';
        index = period + 1;
        secsLeft = prog[index].secs;
      } else if (elapsed >= len) {
        phase = 'ended';
        secsLeft = 0;
      } else {
        phase = m.pausedAt ? 'paused' : 'running';
        secsLeft = Math.ceil((len - elapsed) / 1000);
      }
    }
    if (m.stoppedAt && phase !== 'ended') phase = 'stopped';
  }

  const seg = prog[index];
  const countdown = phase === 'countdown' ? Math.max(1, Math.ceil(-elapsed / 1000)) : 0;
  const go = phase === 'running' && elapsed < GO_SHOW_MS;
  const enabled = Object.fromEntries(ALLIANCES.map((a) => [a, phase === 'running' && !m.overrides[a]]));

  // What the robots are told: the period letter, and the seconds left in it
  // (while waiting, the full length of the period that comes next).
  const robot = seg.robot;
  const robotSecs = secsLeft;

  let clockText = `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}`;
  let clockColor = phase === 'running' ? GREEN : phase === 'ready' ? WHITE : ORANGE;
  if (countdown) [clockText, clockColor] = [String(countdown), ORANGE];
  else if (go) [clockText, clockColor] = ['GO!', GREEN];

  let status;
  if (phase === 'ready') status = `${t.title}`;
  else if (phase === 'countdown') status = index === 0 ? 'GET READY' : `GET READY - ${seg.title}`;
  else if (phase === 'running') status = seg.title;
  else if (phase === 'paused') status = `${seg.title} PAUSED`;
  else if (phase === 'waiting') {
    const before = m.skippedAuto && index === 1 ? 'AUTONOMOUS SKIPPED' : `${prog[index - 1].title} OVER`;
    status = `${before} - WAITING FOR ${seg.title}`;
  } else if (phase === 'stopped') status = 'MATCH STOPPED';
  else status = 'MATCH ENDED';

  const runId = Object.fromEntries(ALLIANCES.map((a) => [a, m.runBase[a] + index]));
  return { phase, index, seg, secsLeft, countdown, go, enabled, robot, robotSecs, clockText, clockColor, status, runId };
}

// The line the relay sends one robot, see field_control.hpp: FC <A|D> <0|1> <secsLeft> <runId>.
// null before the match starts: robots stay in practice mode until a match engages them.
export function fcLineFor(m, slot, now) {
  if (!isStarted(m) || m.endedAt) return null;
  const d = derive(m, now);
  const a = slotAlliance(slot);
  return `FC ${d.robot} ${d.enabled[a] ? 1 : 0} ${d.robotSecs} ${d.runId[a]}`;
}

// What one laptop's controllers should send, from every stored match: {ports: {port: {line, slot, label, code}}, clock}.
// A controller can be listed in more than one match (an earlier one that was never closed). It follows the match
// that is running, else the newest one, so a leftover match can't hand its robot a stale or empty line. Storage
// order (Redis hashes don't keep one) must not decide it.
export function relayPorts(matches, relay, now) {
  const live = (m) => isStarted(m) && !['ended', 'stopped'].includes(derive(m, now).phase);
  const ranked = [...matches].sort((a, b) => live(b) - live(a) || b.createdAt - a.createdAt);
  const ports = {};
  let clock = null;
  // An ended match is left out: its controllers have no entry, so the relays send FC OFF and release the robots.
  for (const m of ranked.filter((x) => !x.endedAt)) {
    for (const slot of TYPES[m.type].slots) {
      const a = m.assign[slot];
      if (!a || a.relay !== relay || ports[a.port]) continue;
      ports[a.port] = { line: fcLineFor(m, slot, now), slot, label: slotLabel(slot), code: m.code };
      if (!clock) {
        const d = derive(m, now);
        clock = { code: m.code, type: TYPES[m.type].title, phase: d.phase, status: d.status, clockText: d.clockText, clockColor: d.clockColor };
      }
    }
  }
  return { ports, clock };
}

// The laptops that joined as this side, in join order.
export const sideLaptops = (m, side) => m.joined.filter((r) => m.roles?.[r] === side);

// An alliance laptop's controllers take its side's empty slots, in port order, whenever they show up: at the
// join, or later when they are connected (relay reports). A laptop keeps one slot free for each other laptop on
// its side, so with two red laptops in a 2v2 each drives one robot; alone it can drive both.
// Returns the changed match, or null if nothing changed.
export function fillAlliance(m, relay, rep) {
  const side = m.roles?.[relay];
  if (!side || isStarted(m) || m.endedAt) return null;
  const t = TYPES[m.type];
  const slots = allianceSlots(m.type, side);
  const mine = slots.filter((s) => m.assign[s]?.relay === relay).length;
  const room = slots.length - (sideLaptops(m, side).length - 1) - mine;
  const used = (port) => t.slots.some((s) => m.assign[s]?.relay === relay && m.assign[s]?.port === port);
  const free = connectedPorts(rep).filter((p) => !used(p)).slice(0, Math.max(0, room));
  const open = slots.filter((s) => !m.assign[s]);
  if (!free.length || !open.length) return null;
  const next = structuredClone(m);
  open.forEach((s, i) => { if (free[i]) next.assign[s] = { relay, port: free[i] }; });
  return next;
}

// What only the game master may do. Once a device has claimed the match, these need that device as well as the PIN.
const GM_ACTIONS = ['assign', 'autoassign', 'start', 'next', 'pause', 'resume', 'stop', 'reset', 'toggle', 'end', 'kick', 'unclaim'];

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
// The controllers a laptop has connected right now (an unplugged / switched-off one reports an error).
const connectedPorts = (rep) => sortPorts((rep?.robots ?? []).filter((r) => !r.error).map((r) => r.port));

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
  const started = isStarted(m);
  if (started && d.phase !== 'ended' && d.phase !== 'stopped') blockers.push('match in progress');
  for (const s of slots) {
    if (!s.relay) blockers.push(`${s.label}: no controller assigned`);
    else if (!s.ready) blockers.push(`${s.label}: ${s.status}`);
  }
  const ended = Boolean(m.endedAt);
  const canStart = !ended && !started && blockers.length === 0;

  return {
    now,
    code: m.code,
    type: m.type,
    typeTitle: t.title,
    program: t.program.map(({ key, title, secs }) => ({ key, title, secs })),
    phase: d.phase,
    status: d.status,
    clockText: d.clockText,
    clockColor: d.clockColor,
    countdown: d.countdown,
    go: d.go,
    secs: d.secsLeft,
    segment: d.phase === 'running' || d.phase === 'paused' ? d.seg.title : null,
    periodTitle: d.seg.title, // the current period, or while waiting the one that comes next
    skippedAuto: Boolean(m.skippedAuto),
    enabled: d.enabled,
    overrides: m.overrides,
    started,
    canStart,
    canSkipAuto: canStart && hasAuto(t),
    hasAuto: hasAuto(t),
    canNext: !ended && d.phase === 'waiting',
    canPause: !ended && d.phase === 'running' && d.seg.key === 'DRIVER',
    canResume: !ended && d.phase === 'paused',
    canReset: !ended && started,
    ended, // the game master ended it: final result, nothing more to do
    gmDevice: m.gm?.device ?? null,
    gmLaptop: m.gm?.laptop ?? null,
    // the laptops on each side, online or not (one that went away keeps its place until it leaves or is removed),
    // and how many each side takes: one per robot
    alliances: Object.fromEntries(ALLIANCES.map((a) => [a, sideLaptops(m, a)])),
    seats: Object.fromEntries(ALLIANCES.map((a) => [a, allianceSlots(m.type, a).length])),
    members: m.joined.map((name) => ({ name, alliance: m.roles?.[name] ?? null, online: Boolean(online[name]) })),
    endedAt: m.endedAt ?? null,
    blockers: started ? [] : blockers,
    joined: m.joined,
    slots,
    // Laptops that are online, with their controllers, for joining and assigning.
    relays: Object.entries(online).map(([name, r]) => ({
      name,
      joined: m.joined.includes(name),
      alliance: m.roles?.[name] ?? null,
      ports: sortPorts((r.robots ?? []).map((x) => x.port)),
      connected: connectedPorts(r), // the ones that can be assigned
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
  const editable = !isStarted(next); // slots and laptops are fixed once a match is running

  if (next.endedAt) return act.action === 'end' ? { match: next } : { error: 'this match has ended' };
  if (next.gm && GM_ACTIONS.includes(act.action) && act.device !== next.gm.device && !act.admin) return { error: 'only the game master can do that' };
  switch (act.action) {
    case 'end': // finish for good: everything stops where it is, the robots are released, nothing can restart it
      if (isStarted(next) && !next.stoppedAt && d.phase !== 'ended') next.stoppedAt = now;
      next.pausedAt = null;
      next.endedAt = now;
      return { match: next };
    case 'join': {
      // alliance 'red' | 'blue': one laptop per side. It needs no controller yet: whatever it has connected (now or
      // later, see fillAlliance) takes that side's empty slots.
      if (!online[act.relay]) return { error: 'that laptop is not online (is its relay running?)' };
      if (!editable) return { error: 'the match has already started' };
      next.roles ??= {};
      if (act.alliance != null) {
        if (!ALLIANCES.includes(act.alliance)) return { error: 'unknown alliance' };
        const mine = allianceSlots(next.type, act.alliance);
        if (!mine.length) return { error: `this match has no ${act.alliance} alliance` };
        // One laptop per robot on each side: a 1v1 side takes one laptop, a 2v2 side two.
        const others = sideLaptops(next, act.alliance).filter((r) => r !== act.relay);
        if (others.length >= mine.length) return { error: `the ${act.alliance} alliance is full (${others.join(', ')})` };
        // Switching sides: the laptop's controllers leave the other alliance's slots.
        for (const s of t.slots) if (!mine.includes(s) && next.assign[s]?.relay === act.relay) next.assign[s] = null;
        // Room for the newcomer: a laptop on this side driving more than one robot hands back its last one.
        for (const r of others) {
          const held = mine.filter((s) => next.assign[s]?.relay === r);
          if (held.length > 1 && !mine.some((s) => !next.assign[s])) next.assign[held.at(-1)] = null;
        }
        next.roles[act.relay] = act.alliance;
        if (!next.joined.includes(act.relay)) next.joined.push(act.relay);
        return { match: fillAlliance(next, act.relay, online[act.relay]) ?? next };
      }
      if (!next.joined.includes(act.relay)) next.joined.push(act.relay);
      return { match: next };
    }
    case 'claim': {
      // The game master's device: the first one to ask. takeover: replace one that left without letting go (closed
      // tab, flat laptop) - only once its page has been silent for GM_AWAY_MS (gmSeenAt: when it last asked for the
      // match), so nobody else with the code can grab a game master that is still there. admin (the PIN) can always.
      if (!act.device) return { error: 'device required' };
      if (next.gm && next.gm.device !== act.device) {
        if (!act.takeover) return { error: 'this match already has a game master' };
        const away = now - Math.max(act.gmSeenAt ?? 0, next.gm.at ?? 0);
        if (!act.admin && away < GM_AWAY_MS)
          return { error: `the game master is still here: another device can take over once it has been away for ${GM_AWAY_MS / 1000} s` };
      }
      // laptop: the name this browser's laptop goes by in matches, so the laptop list can show which one runs it.
      next.gm = { device: String(act.device).slice(0, 40), laptop: act.laptop ? String(act.laptop).slice(0, 40) : null, at: now };
      return { match: next };
    }
    case 'unclaim':
      next.gm = null;
      return { match: next };
    case 'kick': // the game master removes a laptop (e.g. one that holds a side and went away)
    case 'leave': {
      if (!editable) return { error: 'the match has already started' };
      next.joined = next.joined.filter((r) => r !== act.relay);
      if (next.roles) delete next.roles[act.relay];
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
      if (!connectedPorts(rep).includes(act.port)) return { error: 'that controller is not connected to its laptop' };
      for (const s of t.slots) if (next.assign[s]?.relay === act.relay && next.assign[s]?.port === act.port) next.assign[s] = null;
      next.assign[act.slot] = { relay: act.relay, port: act.port };
      if (!next.joined.includes(act.relay)) next.joined.push(act.relay);
      return { match: next };
    }
    case 'autoassign': {
      if (!editable) return { error: 'the match has already started' };
      // A laptop that joined as an alliance fills that alliance's slots; the others (joined without one), in
      // join order then port order, fill whatever is left: red1, red2, blue1, blue2...
      const roles = next.roles ?? {};
      const pool = (want) => next.joined.filter((name) => online[name] && (roles[name] ?? null) === want)
        .flatMap((name) => connectedPorts(online[name]).map((port) => ({ relay: name, port })));
      for (const s of t.slots) next.assign[s] = null;
      for (const a of ALLIANCES) allianceSlots(next.type, a).forEach((s, i) => (next.assign[s] = pool(a)[i] ?? null));
      const rest = pool(null);
      for (const s of t.slots) if (!next.assign[s] && rest.length) next.assign[s] = rest.shift();
      return { match: next };
    }
    case 'start': {
      // skipAuto: no autonomous, the robots wait disabled until the referee starts driver control.
      const view = matchView(next, relays, now);
      if (!view.canStart) return { error: view.blockers[0] ?? 'cannot start', blockers: view.blockers };
      if (act.skipAuto && !hasAuto(t)) return { error: 'this match has no autonomous to skip' };
      next.skippedAuto = Boolean(act.skipAuto);
      next.period = next.skippedAuto ? 1 : 0;
      next.startAt = next.skippedAuto ? null : now + COUNTDOWN_MS;
      next.pausedAt = null;
      next.stoppedAt = null;
      next.overrides = { red: false, blue: false };
      const base = (Math.floor(now / 1000) % 90000) * 10 + 10; // never reuses a run id a robot already ran
      next.runBase = { red: base, blue: base };
      return { match: next };
    }
    case 'next': // the referee starts the period the robots are waiting for: 3-2-1, then GO
      if (d.phase !== 'waiting') return { error: 'nothing is waiting to start' };
      next.period = d.index;
      next.startAt = now + COUNTDOWN_MS;
      next.pausedAt = null;
      return { match: next };
    case 'pause':
      if (d.phase !== 'running' || d.seg.key !== 'DRIVER') return { error: 'only driver control can be paused' };
      next.pausedAt = now;
      return { match: next };
    case 'resume': // the clock carries on from where it was paused
      if (d.phase !== 'paused') return { error: 'the match is not paused' };
      next.startAt += now - next.pausedAt;
      next.pausedAt = null;
      return { match: next };
    case 'stop':
      if (isStarted(next) && !next.stoppedAt && d.phase !== 'ended') next.stoppedAt = now;
      return { match: next };
    case 'reset':
      next.period = null;
      next.startAt = null;
      next.pausedAt = null;
      next.stoppedAt = null;
      next.skippedAuto = false;
      next.overrides = { red: false, blue: false };
      return { match: next };
    case 'toggle':
      if (!ALLIANCES.includes(act.alliance)) return { error: 'unknown alliance' };
      if (!['running', 'paused', 'waiting'].includes(d.phase)) return { error: 'only while the match is running' };
      next.overrides[act.alliance] = !next.overrides[act.alliance];
      return { match: next };
    default:
      return { error: 'unknown action' };
  }
}
