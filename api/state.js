// GET /api/state -- the public snapshot every page polls (no PIN: it can't change anything).
import { loadReports, loadState, send, storageKind, view } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  try {
    const now = Date.now();
    const state = await loadState(now);
    send(res, 200, { ...view(state, await loadReports(), now), storage: storageKind() });
  } catch (e) {
    send(res, 500, { error: String(e.message ?? e) });
  }
}
