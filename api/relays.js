// GET /api/relays -- the laptops (relays) that are online with their controllers, for the join screen.
import { relayOnline, sortPorts } from './_engine.js';
import { loadRelays } from './_data.js';
import { send } from './_http.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  try {
    const now = Date.now();
    const relays = Object.entries(await loadRelays(now))
      .filter(([, r]) => relayOnline(r, now))
      .map(([name, r]) => ({ name, ports: sortPorts((r.robots ?? []).map((x) => x.port)) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));   // storage keeps no order
    send(res, 200, { relays });
  } catch (e) {
    send(res, 500, { error: String(e.message ?? e) });
  }
}
