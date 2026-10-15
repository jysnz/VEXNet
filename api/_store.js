// Storage for matches and relay reports.
// Upstash Redis over REST (add it from the Vercel Marketplace; it sets these variables).
// Without it the API falls back to memory, which only works on a single local process.
const REDIS_URL = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const memory = new Map(); // hash name -> Map(field -> string)

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

// A "hash" is a small table: field -> JSON value.
export async function hset(hash, field, value) {
  if (storageKind() === 'redis') return void (await redis(['HSET', hash, field, JSON.stringify(value)]));
  if (!memory.has(hash)) memory.set(hash, new Map());
  memory.get(hash).set(field, JSON.stringify(value));
}

export async function hget(hash, field) {
  if (storageKind() === 'redis') {
    const raw = await redis(['HGET', hash, field]);
    return raw ? JSON.parse(raw) : null;
  }
  const raw = memory.get(hash)?.get(field);
  return raw ? JSON.parse(raw) : null;
}

export async function hgetall(hash) {
  const out = {};
  if (storageKind() === 'redis') {
    const flat = (await redis(['HGETALL', hash])) ?? [];
    for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = JSON.parse(flat[i + 1]);
    return out;
  }
  for (const [k, v] of memory.get(hash) ?? []) out[k] = JSON.parse(v);
  return out;
}

export async function hdel(hash, field) {
  if (storageKind() === 'redis') return void (await redis(['HDEL', hash, field]));
  memory.get(hash)?.delete(field);
}
