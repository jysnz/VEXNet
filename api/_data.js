// Loading and saving matches and relays (the storage calls the endpoints share).
import { RELAY_STALE_MS } from './_engine.js';
import { hdel, hget, hgetall, hset } from './_store.js';

const MATCHES = 'vexnet:matches';
const RELAYS = 'vexnet:relays';
const MATCH_TTL_MS = 12 * 60 * 60 * 1000;

export const loadMatch = (code) => hget(MATCHES, code);
export const saveMatch = (m) => hset(MATCHES, m.code, m);
export const deleteMatch = (code) => hdel(MATCHES, code);

export async function loadMatches(now) {
  const all = await hgetall(MATCHES);
  for (const [code, m] of Object.entries(all)) {
    if (now - m.createdAt > MATCH_TTL_MS) {
      delete all[code];
      await hdel(MATCHES, code);
    }
  }
  return all;
}

export const saveRelay = (name, report) => hset(RELAYS, name, report);

// A laptop's controller report as stored: at most 8 controllers, every field bounded.
export const cleanRobots = (robots) => robots.slice(0, 8).map((r) => ({
  port: String(r?.port ?? '?').slice(0, 12),
  fcs: r?.fcs == null ? null : String(r.fcs).slice(0, 40),
  age: typeof r?.age === 'number' ? r.age : null,
  error: r?.error ? String(r.error).slice(0, 120) : null,
}));

// Relays that have reported recently; long-silent ones are dropped from storage.
export async function loadRelays(now) {
  const all = await hgetall(RELAYS);
  for (const [name, r] of Object.entries(all)) {
    if (now - r.at > RELAY_STALE_MS * 12) {
      delete all[name];
      await hdel(RELAYS, name);
    }
  }
  return all;
}
