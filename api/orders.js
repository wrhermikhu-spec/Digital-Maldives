import crypto from "node:crypto";
import { db, storage, enc } from "../lib/supabase.js";
import { send, fail, bad, readJson, str, isUuid, clientInfo } from "../lib/http.js";
import { parseUA } from "../lib/ua.js";

const MAX_SLIP_BYTES = 2.5 * 1024 * 1024;
const MAX_ORDERS_PER_IP = 5; // per 15 minutes

// POST /api/orders  { cardId, buyerName, contact, slip: "data:image/jpeg;base64,...", device: {...} }
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  try {
    const body = await readJson(req);
    const buyerName = str(body.buyerName, 80);
    const contact = str(body.contact, 120);
    if (!isUuid(body.cardId)) throw bad("Please choose a card.");
    if (!buyerName || !contact) throw bad("Please enter your name and phone/email.");

    // Slip: compressed JPEG from the browser
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.slip || ""));
    if (!m) throw bad("Please upload your transfer slip.");
    const bytes = Buffer.from(m[1], "base64");
    if (bytes.length > MAX_SLIP_BYTES) throw bad("Slip image is too large.");
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) throw bad("Slip must be an image.");

    // Network info comes from Vercel's edge, not from the browser.
    const net = clientInfo(req);
    const since = new Date(Date.now() - 15 * 60e3).toISOString();
    if (net.ip) {
      const recent = await db.select("orders", `ip=eq.${enc(net.ip)}&created_at=gte.${enc(since)}&select=id`);
      if (recent.length >= MAX_ORDERS_PER_IP) throw bad("Too many orders from your connection. Please wait a few minutes.", 429);
    }

    const cards = await db.select("card_stock", `id=eq.${body.cardId}&active=eq.true&select=id,name,price,stock`);
    const card = cards[0];
    if (!card) throw bad("That card isn't available any more.");
    if (card.stock <= 0) throw bad("Sorry, that card just sold out.");
    const [settings] = await db.select("settings", "id=eq.1&select=currency");

    const id = crypto.randomUUID();
    const slipPath = `${new Date().toISOString().slice(0, 7)}/${id}.jpg`;
    await storage.upload("slips", slipPath, bytes, "image/jpeg");

    const ua = parseUA(net.user_agent);
    const d = body.device && typeof body.device === "object" ? body.device : {};
    await db.insert("orders", {
      id,
      card_id: card.id,
      card_name: card.name,
      price: card.price,
      currency: settings?.currency || "MVR",
      buyer_name: buyerName,
      contact,
      slip_path: slipPath,
      ip: net.ip,
      city: net.city,
      region: net.region,
      country: net.country,
      user_agent: net.user_agent,
      os: ua.os,
      browser: ua.browser,
      // Real model from Android Client Hints if the browser sent it, else from the UA.
      device_model: str(d.model, 80) || ua.model || (/Mobi/.test(net.user_agent) ? "Phone (model hidden)" : "Unknown"),
      screen: str(d.screen, 40),
      language: str(d.language, 20),
      timezone: str(d.timezone, 60),
      visitor_id: str(d.visitorId, 64),
    });

    send(res, 201, { id });
  } catch (e) { fail(res, e); }
}
