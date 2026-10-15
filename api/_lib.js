// Shared match logic + storage for the VEXNET field-control API.
//
// The clock is stateless: the stored state holds absolute timestamps ("GO is at T",
// "the period ends at T"), so any serverless instance can work out what the clock
// reads at any moment, and the website and relays always agree.
import { timingSafeEqual } from 'node:crypto';

// ─── Configuration ──────────────────────────────────────────────────────────
export const PERIODS = [
  { key: 'AUTO', title: 'AUTONOMOUS', robot: 'A', secs: 30, next: 'DRIVER' },
  { key: 'DRIVER', title: 'DRIVER CONTROL', robot: 'D', secs: 90, next: null },
  { key: 'DSKILLS', title: 'DRIVER SKILLS', robot: 'D', secs: 60, next: null },
  { key: 'PSKILLS', title: 'PROGRAMMING SKILLS', robot: 'A', secs: 60, next: null },
];
export const PERIOD_BY_KEY = Object.fromEntries(PERIODS.map((p) => [p.key, p]));
export const ALLIANCES = ['red', 'blue'];
export const COUNTDOWN_MS = 3000; // "3, 2, 1" before every START (robots stay disabled)
export const GO_SHOW_MS = 1000; // how long "GO!" stays up
const ROBOT_STALE_S = 2; // a robot silent this long is shown as "no reply"
const RELAY_STALE_MS = 4000; // a relay silent this long is shown as offline

const GREEN = '#2ECC71';
const ORANGE = '#FF8C00';
const WHITE = '#e6e6e6';

// ─── State ──────────────────────────────────────────────────────────────────
export function initialState(now = Date.now()) {
  // Seeded from the clock so a fresh deployment never reuses a run id a robot already ran.
  const seed = Math.floor(now / 1000) % 1000000;
  return {
    period: 'AUTO',
    secsLeft: PERIOD_BY_KEY.AUTO.secs, // remaining time while not running
    running: false,
    countdownEnd: null, // ms epoch of the GO moment while counting down
    goAt: 0, // ms epoch of the last GO
    runEnd: null, // ms epoch the running period ends
    released: false,
    enabled: { red: false, blue: false },
    inRun: { red: true, blue: true },
    runId: { red: seed, blue: seed },
    updatedAt: now,
  };
}

const fullSecs = (key) => PERIOD_BY_KEY[key].secs;

// Applies everything that has become due (countdown reached GO, period ran out).
// Returns [newState, changed].
export function advance(state, now) {
  const s = structuredClone(state);
  let changed = false;
  for (let i = 0; i < 4; i++) {
    if (s.countdownEnd && now >= s.countdownEnd) {
      const goAt = s.countdownEnd;
      s.countdownEnd = null;
      const starting = ALLIANCES.filter((a) => s.inRun[a]);
      if (starting.length) {
        for (const a of starting) {
          s.enabled[a] = true;
          s.runId[a] += 1;
        }
        s.running = true;
        s.goAt = goAt;
        s.runEnd = goAt + Math.round(s.secsLeft * 1000);
      }
      changed = true;
    } else if (s.running && s.runEnd !== null && now >= s.runEnd) {
      s.running = false;
      s.runEnd = null;
      for (const a of ALLIANCES) s.enabled[a] = false;
      const next = PERIOD_BY_KEY[s.period].next;
      if (next) {
        s.period = next;
        s.secsLeft = fullSecs(next);
      } else {
        s.secsLeft = 0;
      }
      changed = true;
    } else {
      break;
    }
  }
  if (changed) s.updatedAt = now;
  return [s, changed];
}

// ─── Commands (what the buttons do) ─────────────────────────────────────────
function stop(s, now) {
  if (s.running && s.runEnd !== null) s.secsLeft = Math.max(0, (s.runEnd - now) / 1000);
  s.running = false;
  s.runEnd = null;
  s.countdownEnd = null;
  s.goAt = 0;
  for (const a of ALLIANCES) s.enabled[a] = false;
}

export function applyCommand(state, cmd, now) {
  const [s] = advance(state, now);
  const a = cmd.alliance;
  switch (cmd.cmd) {
    case 'select':
      if (!PERIOD_BY_KEY[cmd.key]) return null;
      stop(s, now);
      s.period = cmd.key;
      s.secsLeft = fullSecs(cmd.key);
      break;
    case 'start':
      if (s.running || s.countdownEnd) break; // already busy
      if (!ALLIANCES.some((x) => s.inRun[x])) break;
      if (s.secsLeft <= 0) s.secsLeft = fullSecs(s.period);
      s.released = false;
      for (const x of ALLIANCES) s.enabled[x] = false; // robots held DISABLED through the countdown
      s.countdownEnd = now + COUNTDOWN_MS;
      break;
    case 'stop':
      stop(s, now);
      break;
    case 'reset':
      stop(s, now);
      s.secsLeft = fullSecs(s.period);
      break;
    case 'toggle':
      if (!ALLIANCES.includes(a)) return null;
      s.enabled[a] = !s.enabled[a];
      if (s.enabled[a]) {
        s.released = false;
        // With the clock stopped this is a fresh run (an autonomous period would start
        // the routine again); mid-period it is a re-enable and the routine isn't restarted.
        if (!s.running) s.runId[a] += 1;
      }
      break;
    case 'inrun':
      if (!ALLIANCES.includes(a)) return null;
      s.inRun[a] = Boolean(cmd.value);
      break;
    case 'release':
      stop(s, now);
      s.released = !s.released;
      break;
    default:
      return null;
  }
  s.updatedAt = now;
  return s;
}

// ─── Derived values (what the screens and relays see) ───────────────────────
export function secsOf(s, now) {
  if (s.running && s.runEnd !== null) return Math.max(0, Math.ceil((s.runEnd - now) / 1000));
  return Math.max(0, Math.ceil(s.secsLeft));
}

export function countdownOf(s, now) {
  return s.countdownEnd ? Math.max(0, Math.ceil((s.countdownEnd - now) / 1000)) : 0;
}

// The line a relay sends to every robot on `alliance`, see field_control.hpp:
//   FC <A|D> <0|1> <secsLeft> <runId>      or     FC OFF
export function fcLine(s, alliance, now) {
  if (s.released) return 'FC OFF';
  const p = PERIOD_BY_KEY[s.period];
  return `FC ${p.robot} ${s.enabled[alliance] ? 1 : 0} ${secsOf(s, now)} ${s.runId[alliance]}`;
}

function describeRobot(r) {
  if (r.error) return `ERROR: ${r.error}`;
  if (r.age === null || r.age === undefined || r.age > ROBOT_STALE_S || !r.fcs) return 'no reply from robot';
  const parts = String(r.fcs).split('|');
  if (parts.length < 3) return '?';
  if (parts[0] === 'P') return 'program running - waiting for field control';
  const period = parts[0] === 'A' ? 'AUTO' : 'DRIVER';
  if (parts[1] !== '1') return `${period} - disabled`;
  return `${period} - ENABLED${parts[2] === '1' ? ' (auton running)' : ''}`;
}

export function robotLines(report, now) {
  if (!report || now - report.at > RELAY_STALE_MS) return ['no relay laptop connected'];
  const lines = [`laptop ${report.name}`];
  if (!report.robots.length) lines.push('   no controllers plugged in');
  for (const r of report.robots) lines.push(`   ${String(r.port ?? '?').padEnd(6)} ${describeRobot(r)}`);
  return lines;
}

// The public snapshot every page polls.
export function view(s, reports, now) {
  const p = PERIOD_BY_KEY[s.period];
  const secs = secsOf(s, now);
  const countdown = countdownOf(s, now);
  const go = s.running && now < s.goAt + GO_SHOW_MS;
  let clockText = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  let clockColor = s.running ? GREEN : secs === 0 ? ORANGE : WHITE;
  if (countdown) {
    clockText = String(countdown);
    clockColor = ORANGE;
  } else if (go) {
    clockText = 'GO!';
    clockColor = GREEN;
  }
  let status;
  if (s.released) status = 'RELEASED - robots in practice mode';
  else if (countdown) status = `${p.title}  -  GET READY`;
  else status = p.title + (s.running ? '' : '  (stopped)');
  return {
    now,
    periods: PERIODS.map(({ key, title, secs: t }) => ({ key, title, secs: t })),
    selected: s.period,
    title: p.title,
    status,
    clockText,
    clockColor,
    secs,
    countdown,
    go,
    running: s.running,
    released: s.released,
    enabled: s.enabled,
    inRun: s.inRun,
    robots: Object.fromEntries(ALLIANCES.map((a) => [a, robotLines(reports[a], now)])),
  };
}

// ─── Storage ────────────────────────────────────────────────────────────────
// Upstash Redis over REST (add it from the Vercel Marketplace; it sets these variables).
// Without it the API falls back to memory, which only works on a single local process.
const REDIS_URL = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const memory = new Map();

export const storageKind = () => (REDIS_URL() && REDIS_TOKEN() ? 'redis' : 'memory');

async function redis(command) {
  const res = await fetch(REDIS_URL(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function getJson(key) {
  if (storageKind() === 'redis') {
    const raw = await redis(['GET', key]);
    return raw ? JSON.parse(raw) : null;
  }
  const m = memory.get(key);
  return m && (!m.exp || m.exp > Date.now()) ? m.value : null;
}

async function setJson(key, value, ttlSeconds) {
  if (storageKind() === 'redis') {
    const cmd = ['SET', key, JSON.stringify(value)];
    if (ttlSeconds) cmd.push('EX', String(ttlSeconds));
    await redis(cmd);
    return;
  }
  memory.set(key, { value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
}

const STATE_KEY = 'vexnet:state';
const reportKey = (a) => `vexnet:robots:${a}`;

export async function loadState(now) {
  const stored = await getJson(STATE_KEY);
  const [s, changed] = advance(stored ?? initialState(now), now);
  if (changed || !stored) await setJson(STATE_KEY, s);
  return s;
}
export const saveState = (s) => setJson(STATE_KEY, s);
export const saveReport = (alliance, report) => setJson(reportKey(alliance), report, 10);
export async function loadReports() {
  const out = {};
  for (const a of ALLIANCES) out[a] = await getJson(reportKey(a));
  return out;
}

// ─── Auth + HTTP helpers ────────────────────────────────────────────────────
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
export const pinOk = (req) => Boolean(process.env.CONTROL_PIN) && safeEqual(req.headers['x-pin'], process.env.CONTROL_PIN);
export const relayOk = (req) => Boolean(process.env.RELAY_TOKEN) && safeEqual(req.headers['x-relay-token'], process.env.RELAY_TOKEN);

export function send(res, code, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(code).json(body);
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}
