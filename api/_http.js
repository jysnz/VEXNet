// Auth + HTTP helpers shared by the API endpoints.
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Stray spaces / newlines pasted into the Vercel value shouldn't make a correct PIN or token fail.
const secret = (name) => String(process.env[name] ?? '').trim();
const given = (req, header) => String(req.headers[header] ?? '').trim();

export const pinOk = (req) => Boolean(secret('CONTROL_PIN')) && safeEqual(given(req, 'x-pin'), secret('CONTROL_PIN'));
export const relayOk = (req) => Boolean(secret('RELAY_TOKEN')) && safeEqual(given(req, 'x-relay-token'), secret('RELAY_TOKEN'));

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
