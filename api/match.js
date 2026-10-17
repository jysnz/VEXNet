// Matches. GET /api/match?code=ABC123 is public (the code is the key); changes are POSTs.
//   {action: "create", type}                                   PIN   -> new match
//   {action: "join", code, relay, alliance?, robots?}          none  -> a laptop joins, as the red or blue alliance (one each)
//   {action: "leave", code, relay}                             none  -> a laptop gives up its place (before START)
//   {action: "check", code}                                    PIN   -> the match (proves the PIN)
//   {action: "claim", code, device, takeover?}                 PIN   -> this device becomes the one game master
//   {action: "unclaim"|"kick"|"assign"|"autoassign"|"start"|"next"|"pause"|"resume"|"stop"|"reset"|"toggle"|"end"|"close", code, device, ...}   PIN
//       once a game master has claimed the match, these also need its device
//   end finishes the match for good: robots released, every screen shows the result (close deletes it outright).
//   start takes skipAuto: true to go straight to waiting for driver control; next starts that period.
// Running the match takes the PIN: only the game master has it. The alliances join with the code alone.
import { applyAction, createMatch, matchView, newCode, normalizeCode, relayOnline, TYPES } from './_engine.js';
import { cleanRobots, deleteMatch, loadMatch, loadMatches, loadRelays, saveMatch, saveRelay } from './_data.js';
import { pinOk, readBody, send } from './_http.js';
import { storageKind } from './_store.js';

const out = (view) => ({ ...view, storage: storageKind() });

export default async function handler(req, res) {
  try {
    const now = Date.now();

    if (req.method === 'GET') {
      const code = normalizeCode(req.query?.code);
      const m = code && (await loadMatch(code));
      if (!m) return send(res, 404, { error: 'no match with that code' });
      return send(res, 200, out(matchView(m, await loadRelays(now), now)));
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    const body = readBody(req);
    const action = body.action;
    const needsPin = action !== 'join' && action !== 'leave';
    if (needsPin && !process.env.CONTROL_PIN) return send(res, 500, { error: 'CONTROL_PIN is not set on the server' });
    if (needsPin && !pinOk(req)) return send(res, 401, { error: 'pin' });

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
    const result = applyAction(m, body, relays, now);
    if (result.error) return send(res, 400, { error: result.error, blockers: result.blockers });
    await saveMatch(result.match);
    return send(res, 200, out(matchView(result.match, relays, now)));
  } catch (e) {
    send(res, 500, { error: String(e.message ?? e) });
  }
}
