import crypto from "node:crypto";
import { db, storage, enc } from "../lib/supabase.js";
import { send, fail, bad, readJson, str, isUuid, clientInfo } from "../lib/http.js";
import { parseUA } from "../lib/ua.js";
import { readDocuments, evaluate } from "../lib/autocheck.js";

const num = (v, min, max) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const GPS_STATES = ["granted", "not_granted", "unavailable", "timeout"];
const MAX_IMG_BYTES = 2.5 * 1024 * 1024;
const MAX_ORDERS_PER_IP = 5; // per 15 minutes

// ---- signed checkout-start time (so the 30-minute window can't be faked) ----
const SECRET = () => process.env.ADMIN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const signStart = ms => `${ms}.${crypto.createHmac("sha256", SECRET()).update("start:" + ms).digest("base64url")}`;
function verifyStart(token) {
  const [ms, sig] = String(token || "").split(".");
  if (!ms || !sig) return null;
  const good = signStart(ms).split(".")[1];
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  const t = Number(ms);
  return Number.isFinite(t) && t <= Date.now() + 5000 && Date.now() - t < 6 * 3600e3 ? t : null;
}

function jpeg(dataUrl, label) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw bad(`Please upload your ${label}.`);
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.length > MAX_IMG_BYTES) throw bad(`Your ${label} image is too large.`);
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) throw bad(`Your ${label} must be an image.`);
  return { bytes, b64: m[1] };
}

// GET  /api/orders           → { start } signed checkout-start token
// POST /api/orders  { cardId, buyerName, contact, slip, device, mode?: "instant", idImage?, start? }
export default async function handler(req, res) {
  if (req.method === "GET") return send(res, 200, { start: signStart(Date.now()) });
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  try {
    const body = await readJson(req);
    const buyerName = str(body.buyerName, 80);
    const contact = str(body.contact, 120);
    const instant = body.mode === "instant";
    if (!isUuid(body.cardId)) throw bad("Please choose a card.");
    if (!buyerName || !contact) throw bad("Please enter your name and phone/email.");
    const slip = jpeg(body.slip, "transfer slip");
    const idImg = instant ? jpeg(body.idImage, "ID card photo") : null;

    // Network info comes from Vercel's edge, not from the browser.
    const net = clientInfo(req);
    const d = body.device && typeof body.device === "object" ? body.device : {};
    if (net.ip) {
      const since = new Date(Date.now() - 15 * 60e3).toISOString();
      const recent = await db.select("orders", `ip=eq.${enc(net.ip)}&created_at=gte.${enc(since)}&select=id`);
      if (recent.length >= MAX_ORDERS_PER_IP) throw bad("Too many orders from your connection. Please wait a few minutes.", 429);
    }

    const [card] = await db.select("card_stock", `id=eq.${body.cardId}&active=eq.true&select=id,name,price,stock`);
    if (!card) throw bad("That card isn't available any more.");
    if (card.stock <= 0) throw bad("Sorry, that card just sold out.");
    const [settings = {}] = await db.select("settings", "id=eq.1&select=*");

    // ---- instant eligibility ----
    let startedAt = null;
    if (instant) {
      if (!settings.instant_enabled || !process.env.ANTHROPIC_API_KEY) throw bad("Instant delivery isn't available right now. Please use standard checkout.");
      if (Number(card.price) > Number(settings.instant_max_price ?? 0)) throw bad("This card is too expensive for instant delivery. Please use standard checkout.");
      startedAt = verifyStart(body.start);
      if (!startedAt) throw bad("Your checkout session expired. Please refresh and try again.");
      const dayAgo = new Date(Date.now() - 864e5).toISOString();
      const vid = str(d.visitorId, 64);
      const q = v => `"${String(v).replace(/["\\]/g, "")}"`;
      const ors = [net.ip && `ip.eq.${q(net.ip)}`, vid && `visitor_id.eq.${q(vid)}`].filter(Boolean).join(",");
      if (ors) {
        const mine = await db.select("orders", `instant=eq.true&created_at=gte.${enc(dayAgo)}&or=(${enc(ors)})&select=id`);
        if (mine.length >= Number(settings.instant_daily_limit ?? 2)) throw bad("You've reached today's instant delivery limit. Please use standard checkout.");
      }
    }

    const id = crypto.randomUUID();
    const month = new Date().toISOString().slice(0, 7);
    const slipPath = `${month}/${id}.jpg`;
    await storage.upload("slips", slipPath, slip.bytes, "image/jpeg");
    let idPath = null;
    if (idImg) { idPath = `${id}/id-${Date.now()}.jpg`; await storage.upload("kyc", idPath, idImg.bytes, "image/jpeg"); }

    const ua = parseUA(net.user_agent);
    const gps = d.gps && typeof d.gps === "object" ? d.gps : {};
    const gpsOk = gps.status === "granted";
    await db.insert("orders", {
      id, card_id: card.id, card_name: card.name, price: card.price, currency: settings.currency || "MVR",
      buyer_name: buyerName, contact, slip_path: slipPath,
      ip: net.ip, city: net.city, region: net.region, country: net.country,
      ip_lat: num(net.lat, -90, 90), ip_lng: num(net.lng, -180, 180),
      user_agent: net.user_agent, os: ua.os, browser: ua.browser,
      device_model: str(d.model, 80) || ua.model || (/Mobi/.test(net.user_agent) ? "Phone (model hidden)" : "Unknown"),
      screen: str(d.screen, 40), language: str(d.language, 20), timezone: str(d.timezone, 60), visitor_id: str(d.visitorId, 64),
      browser_ip: str(d.browserIp, 64), browser_city: str(d.browserCity, 80), browser_region: str(d.browserRegion, 80),
      browser_country: str(d.browserCountry, 80), isp: str(d.isp, 120),
      gps_status: GPS_STATES.includes(gps.status) ? gps.status : "not_granted",
      gps_lat: gpsOk ? num(gps.lat, -90, 90) : null, gps_lng: gpsOk ? num(gps.lng, -180, 180) : null,
      gps_accuracy: gpsOk ? num(gps.accuracy, 0, 1e7) : null,
      instant, started_at: startedAt ? new Date(startedAt).toISOString() : null, id_path: idPath,
    });

    if (!instant) return send(res, 201, { id });

    // ---- instant: read documents + run checks ----
    let result;
    try {
      const data = await readDocuments(slip.b64, idImg.b64);
      const ref = str(data?.slip?.reference, 80);
      let refUsed = false;
      if (ref) refUsed = (await db.select("orders", `slip_ref=eq.${enc(ref)}&id=neq.${id}&select=id`)).length > 0;
      result = evaluate({ data, order: { price: Number(card.price), currency: settings.currency || "MVR" }, settings, startedAt, refUsed });
      await db.update("orders", `id=eq.${id}`, {
        slip_ref: ref || null, slip_time: str(data?.slip?.datetime, 20) || null,
        slip_sender: str(data?.slip?.sender_name, 120) || null, id_name: str(data?.id?.full_name, 120) || null,
        auto_check: result,
      });
    } catch (e) {
      console.error("autocheck failed", e);
      await db.update("orders", `id=eq.${id}`, { auto_check: { passed: false, error: "Automatic check failed: " + String(e.message || e).slice(0, 200), checks: [] } });
      return send(res, 201, { id, instant: "manual" });
    }

    if (!result.passed) return send(res, 201, { id, instant: "manual" });
    try {
      await db.rpc("approve_order", { p_order: id });
      await db.update("orders", `id=eq.${id}`, { auto_approved: true });
      return send(res, 201, { id, instant: "approved" });
    } catch (e) {
      console.error("auto-approve failed", e);
      return send(res, 201, { id, instant: "manual" });
    }
  } catch (e) { fail(res, e); }
}
