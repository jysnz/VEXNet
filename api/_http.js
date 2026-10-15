// Auth + HTTP helpers shared by the API endpoints.
import { timingSafeEqual } from 'node:crypto';

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

export function readBody(req) {
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
