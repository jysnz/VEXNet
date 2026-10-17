// Matches. GET /api/match?code=ABC123 is public (the code is the key); changes are POSTs.
//   {action: "create", type}                                   -> new match
//   {action: "join", code, relay, alliance?, robots?}          -> a laptop joins as the red or blue alliance (one per robot)
//   {action: "leave", code, relay}                             -> a laptop gives up its place (before START)
//   {action: "claim", code, device, takeover?}                 -> this device becomes the one game master
//   {action: "unclaim"|"kick"|"assign"|"autoassign"|"start"|"next"|"pause"|"resume"|"stop"|"reset"|"toggle"|"end"|"close", code, device, ...}
//       game master only: the device that claimed the match
//   GET with x-device: the game master's page checking in (a takeover needs it gone for GM_AWAY_MS).
// No PIN anywhere: the match code is the key, and the match is run from the one device that claimed it. The control
// PIN (x-pin), if sent, still counts as the game master and can take over at once.
//   end finishes the match for good: robots released, every screen shows the result (close deletes it outright).
//   start takes skipAuto: true to go straight to waiting for driver control; next starts that period.
import { applyAction, createMatch, matchView, newCode, normalizeCode, relayOnline, TYPES } from './_engine.js';
import { cleanRobots, deleteMatch, loadGmSeen, loadMatch, loadMatches, loadRelays, saveGmSeen, saveMatch, saveRelay } from './_data.js';
import { pinOk, readBody, send } from './_http.js';
import { storageKind } from './_store.js';

const out = (view) => ({ ...view, storage: storageKind() });
const GM_ONLY = ['unclaim', 'kick', 'assign', 'autoassign', 'start', 'next', 'pause', 'resume', 'stop', 'reset', 'toggle', 'end', 'close'];

export default async function handler(req, res) {
  try {
    const now = Date.now();

    if (req.method === 'GET') {
      const code = normalizeCode(req.query?.code);
      const m = code && (await loadMatch(code));
      if (!m) return send(res, 404, { error: 'no match with that code' });
      const device = String(req.headers['x-device'] ?? '');
      if (device && m.gm?.device === device) await saveGmSeen(code, now);   // the game master is still here
      return send(res, 200, out(matchView(m, await loadRelays(now), now)));
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    const body = readBody(req);
    const action = body.action;
    const admin = pinOk(req);   // optional: the control PIN still works, but nothing asks for it

    if (action === 'create') {
      if (!TYPES[body.type]) return send(res, 400, { error: 'unknown match type' });
      const existing = await loadMatches(now);
      let code = newCode();
      while (existing[code]) code = newCode();
      const m = createMatch(body.type, code, now);
      await saveMatch(m);
      return send(res, 200, out(matchView(m, await loadRelays(now), now)));
    }

    const code = normalizeCode(body.code);
    const m = code && (await loadMatch(code));
    if (!m) return send(res, 404, { error: 'no match with that code' });

    // The game master's controls: only from the device that claimed the match.
    if (GM_ONLY.includes(action) && !admin && (!m.gm || m.gm.device !== String(body.device ?? '')))
      return send(res, 403, { error: m.gm ? 'only the game master can do that' : 'pick Game master first' });

    if (action === 'close') {
      await deleteMatch(code);
      return send(res, 200, { closed: true });
    }

    if (action === 'check') return send(res, 200, out(matchView(m, await loadRelays(now), now)));

    // A browser joining as an alliance brings its controllers' status along: that puts the laptop online
    // without the PIN (from then on it reports with the match code, see relay.js). Only for a laptop that
    // isn't online already, so a join can't overwrite another laptop's report.
    let relays = await loadRelays(now);
    const name = String(body.relay ?? '').slice(0, 40);
    if (action === 'join' && Array.isArray(body.robots) && name && !relayOnline(relays[name], now)) {
      await saveRelay(name, { robots: cleanRobots(body.robots), at: now });
      relays = await loadRelays(now);
    }
    // admin and gmSeenAt come from the server only (a client sending admin: true gets it overwritten).
    const act = { ...body, admin, gmSeenAt: action === 'claim' ? await loadGmSeen(code) : undefined };
    const result = applyAction(m, act, relays, now);
    if (result.error) return send(res, 400, { error: result.error, blockers: result.blockers });
    await saveMatch(result.match);
    return send(res, 200, out(matchView(result.match, relays, now)));
  } catch (e) {
    send(res, 500, { error: String(e.message ?? e) });
  }
}
