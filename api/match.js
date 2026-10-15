// Matches. GET /api/match?code=ABC123 is public (the code is the key); changes are POSTs.
//   {action: "create", type}                                   PIN   -> new match
//   {action: "join", code, relay}                              none  -> a laptop joins (the 2nd laptop)
//   {action: "leave"|"assign"|"autoassign"|"start"|"stop"|"reset"|"toggle"|"close", code, ...}   PIN
import { applyAction, createMatch, matchView, newCode, normalizeCode, TYPES } from './_engine.js';
import { deleteMatch, loadMatch, loadMatches, loadRelays, saveMatch } from './_data.js';
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
    const needsPin = action !== 'join';
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

    const relays = await loadRelays(now);
    const result = applyAction(m, body, relays, now);
    if (result.error) return send(res, 400, { error: result.error, blockers: result.blockers });
    await saveMatch(result.match);
    return send(res, 200, out(matchView(result.match, relays, now)));
  } catch (e) {
    send(res, 500, { error: String(e.message ?? e) });
  }
}
