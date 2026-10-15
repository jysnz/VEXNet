// POST /api/cmd -- a button press from the control page. Needs the PIN (x-pin header).
//   {cmd: "select", key} | {cmd: "start"} | {cmd: "stop"} | {cmd: "reset"}
//   {cmd: "toggle", alliance} | {cmd: "inrun", alliance, value} | {cmd: "release"}
import { applyCommand, loadReports, loadState, pinOk, readBody, saveState, send, storageKind, view } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!process.env.CONTROL_PIN) return send(res, 500, { error: 'CONTROL_PIN is not set on the server' });
  if (!pinOk(req)) return send(res, 401, { error: 'pin' });
  try {
    const now = Date.now();
    const cmd = await readBody(req);
    const next = applyCommand(await loadState(now), cmd, now);
    if (!next) return send(res, 400, { error: 'bad command' });
    await saveState(next);
    send(res, 200, { ...view(next, await loadReports(), now), storage: storageKind() });
  } catch (e) {
    send(res, 500, { error: String(e.message ?? e) });
  }
}
