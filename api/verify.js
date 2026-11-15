import { db, storage } from "../lib/supabase.js";
import { send, fail, bad, readJson, isUuid } from "../lib/http.js";

const MAX_BYTES = 2.5 * 1024 * 1024;
const num = (v, min, max) => { const n = Number(v); return v !== null && v !== "" && Number.isFinite(n) && n >= min && n <= max ? n : null; };

function jpeg(dataUrl, label) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw bad(`Please add the ${label} photo.`);
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.length > MAX_BYTES) throw bad(`The ${label} photo is too large.`);
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) throw bad(`The ${label} photo must be an image.`);
  return bytes;
}

// POST /api/verify  { orderId, idImage, selfieImage }  — buyer submits ID + selfie when asked
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  try {
    const b = await readJson(req);
    if (!isUuid(b.orderId)) throw bad("Order not found", 404);
    const [o] = await db.select("orders", `id=eq.${b.orderId}&select=id,status`);
    if (!o) throw bad("Order not found", 404);
    if (o.status !== "verify_required") throw bad("This order doesn't need verification right now.", 409);

    const idBytes = jpeg(b.idImage, "ID card");
    const selfieBytes = jpeg(b.selfieImage, "selfie");
    const stamp = Date.now();
    const idPath = `${o.id}/id-${stamp}.jpg`;
    const selfiePath = `${o.id}/selfie-${stamp}.jpg`;
    await storage.upload("kyc", idPath, idBytes, "image/jpeg");
    await storage.upload("kyc", selfiePath, selfieBytes, "image/jpeg");

    // Optional location shared by the buyer at the ID step
    const g = b.gps && typeof b.gps === "object" ? b.gps : {};
    const lat = num(g.lat, -90, 90), lng = num(g.lng, -180, 180);
    const loc = g.status === "granted" && lat !== null && lng !== null
      ? { gps_status: "shared_at_id", gps_lat: lat, gps_lng: lng, gps_accuracy: num(g.accuracy, 0, 1e7) }
      : { verify_location: g.status === "declined" ? "declined" : "not_shared" };

    const rows = await db.update("orders", `id=eq.${o.id}&status=eq.verify_required`, {
      status: "verify_submitted", id_path: idPath, selfie_path: selfiePath, verify_submitted_at: new Date().toISOString(), ...loc,
    });
    if (!rows.length) throw bad("This order doesn't need verification right now.", 409);
    send(res, 200, { ok: true });
  } catch (e) { fail(res, e); }
}
