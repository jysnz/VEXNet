// The relay laptops (the ones with controllers plugged in by USB) talk to this: relay.py with the
// x-relay-token header, or the website itself (Chrome / Edge over USB, public/usb-relay.js) with x-pin
// (the game master's laptop) or x-match-code (a laptop that joined that match as an alliance: it can only
// speak for itself in that one match, so the alliances never need the control PIN).
//   GET  /api/relay?relay=NAME  -> {now, ports: {COM3: {line, slot, label, code} ...}, clock}
//        line = what to send that controller's robot (null: nothing, e.g. before the match starts)
//   POST /api/relay             <- {relay, robots: [{port, fcs, age, error}]}   this laptop's controllers
import { fillAlliance, normalizeCode, relayPorts } from './_engine.js';
import { cleanRobots, loadMatch, loadMatches, saveMatch, saveRelay } from './_data.js';
import { pinOk, readBody, relayOk, send } from './_http.js';

export default async function handler(req, res) {
  if (!process.env.RELAY_TOKEN && !process.env.CONTROL_PIN) return send(res, 500, { error: 'RELAY_TOKEN / CONTROL_PIN are not set on the server' });
  try {
    const now = Date.now();
    const body = req.method === 'POST' ? readBody(req) : {};
    const name = String((req.method === 'GET' ? req.query?.relay : body.relay) ?? '').slice(0, 40);
    if (!name) return send(res, 400, { error: 'relay name required' });

    // Token or PIN: every match. Match code: only that match, and only for a laptop that joined it.
    let only = null;
    if (!relayOk(req) && !pinOk(req)) {
      const code = normalizeCode(req.headers['x-match-code']);
      const m = code && (await loadMatch(code));
      if (!m || !m.joined.includes(name)) return send(res, 401, { error: 'token' });
      only = m;
    }

    if (req.method === 'GET') {
      const matches = only ? [only] : Object.values(await loadMatches(now));
      return send(res, 200, { now, ...relayPorts(matches, name, now) });
    }
    if (req.method === 'POST') {
      if (!Array.isArray(body.robots)) return send(res, 400, { error: 'bad report' });
      const report = { robots: cleanRobots(body.robots), at: now };
      await saveRelay(name, report);
      // A laptop that joined as an alliance: controllers connected since then take its side's empty slots.
      const matches = only ? [only] : Object.values(await loadMatches(now)).filter((m) => m.roles?.[name]);
      for (const m of matches) {
        const filled = fillAlliance(m, name, report);
        if (filled) await saveMatch(filled);
      }
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    send(res, 500, { error: String(e.message ?? e) });
  }
}
