// The relay laptops (the ones with the controllers plugged in by USB) talk to this. x-relay-token header.
//   GET  /api/relay?alliance=red   -> {now, fc, clock}   fc = the line to send every robot on that alliance
//   POST /api/relay                <- {alliance, name, robots: [{port, fcs, age, error}]}   robot status
import { ALLIANCES, fcLine, loadState, readBody, relayOk, saveReport, send, view } from './_lib.js';

export default async function handler(req, res) {
  if (!process.env.RELAY_TOKEN) return send(res, 500, { error: 'RELAY_TOKEN is not set on the server' });
  if (!relayOk(req)) return send(res, 401, { error: 'token' });
  try {
    const now = Date.now();
    if (req.method === 'GET') {
      const alliance = String(req.query?.alliance ?? '');
      if (!ALLIANCES.includes(alliance)) return send(res, 400, { error: 'alliance must be red or blue' });
      const state = await loadState(now);
      const v = view(state, {}, now);
      const clock = {
        title: v.title,
        status: v.status,
        clockText: v.clockText,
        clockColor: v.clockColor,
        running: v.running,
        released: v.released,
        enabled: v.enabled[alliance],
        countdown: v.countdown,
        go: v.go,
      };
      return send(res, 200, { now, fc: fcLine(state, alliance, now), clock });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!ALLIANCES.includes(body.alliance) || !Array.isArray(body.robots)) return send(res, 400, { error: 'bad report' });
      const robots = body.robots.slice(0, 8).map((r) => ({
        port: String(r.port ?? '?').slice(0, 12),
        fcs: r.fcs == null ? null : String(r.fcs).slice(0, 40),
        age: typeof r.age === 'number' ? r.age : null,
        error: r.error ? String(r.error).slice(0, 120) : null,
      }));
      await saveReport(body.alliance, { name: String(body.name ?? '?').slice(0, 40), robots, at: now });
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    send(res, 500, { error: String(e.message ?? e) });
  }
}
