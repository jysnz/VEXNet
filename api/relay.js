// The relay laptops (the ones with controllers plugged in by USB) talk to this: relay.py with the
// x-relay-token header, or the website itself (Chrome / Edge over USB, public/usb-relay.js) with x-pin.
//   GET  /api/relay?relay=NAME  -> {now, ports: {COM3: {line, slot, label, code} ...}, clock}
//        line = what to send that controller's robot (null: nothing, e.g. before the match starts)
//   POST /api/relay             <- {relay, robots: [{port, fcs, age, error}]}   this laptop's controllers
import { derive, fcLineFor, slotLabel, TYPES } from './_engine.js';
import { loadMatches, saveRelay } from './_data.js';
import { pinOk, readBody, relayOk, send } from './_http.js';

export default async function handler(req, res) {
  if (!process.env.RELAY_TOKEN && !process.env.CONTROL_PIN) return send(res, 500, { error: 'RELAY_TOKEN / CONTROL_PIN are not set on the server' });
  if (!relayOk(req) && !pinOk(req)) return send(res, 401, { error: 'token' });
  try {
    const now = Date.now();
    if (req.method === 'GET') {
      const name = String(req.query?.relay ?? '').slice(0, 40);
      if (!name) return send(res, 400, { error: 'relay name required' });
      const ports = {};
      let clock = null;
      for (const m of Object.values(await loadMatches(now))) {
        for (const slot of TYPES[m.type].slots) {
          const a = m.assign[slot];
          if (!a || a.relay !== name) continue;
          ports[a.port] = { line: fcLineFor(m, slot, now), slot, label: slotLabel(slot), code: m.code };
          if (!clock) {
            const d = derive(m, now);
            clock = { code: m.code, type: TYPES[m.type].title, phase: d.phase, status: d.status, clockText: d.clockText, clockColor: d.clockColor };
          }
        }
      }
      return send(res, 200, { now, ports, clock });
    }
    if (req.method === 'POST') {
      const body = readBody(req);
      const name = String(body.relay ?? '').slice(0, 40);
      if (!name || !Array.isArray(body.robots)) return send(res, 400, { error: 'bad report' });
      const robots = body.robots.slice(0, 8).map((r) => ({
        port: String(r.port ?? '?').slice(0, 12),
        fcs: r.fcs == null ? null : String(r.fcs).slice(0, 40),
        age: typeof r.age === 'number' ? r.age : null,
        error: r.error ? String(r.error).slice(0, 120) : null,
      }));
      await saveRelay(name, { robots, at: now });
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    send(res, 500, { error: String(e.message ?? e) });
  }
}
