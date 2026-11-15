import { db } from "../lib/supabase.js";
import { send, readJson, str, clientInfo } from "../lib/http.js";
import { parseUA } from "../lib/ua.js";

const BOT = /bot|crawl|spider|slurp|facebookexternalhit|preview|headless|lighthouse|vercel/i;

// POST /api/visit  — logs a store visitor (server IP + device + browser IP/ISP)
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  try {
    const net = clientInfo(req);
    if (BOT.test(net.user_agent)) return send(res, 204, {});
    const d = await readJson(req).catch(() => ({}));
    const visitorId = str(d.visitorId, 64);
    if (!visitorId) return send(res, 204, {});
    const ua = parseUA(net.user_agent);
    await db.rpc("log_visit", {
      v: {
        visitor_id: visitorId,
        ip: net.ip,
        city: net.city,
        region: net.region,
        country: net.country,
        ip_lat: Number.isFinite(net.lat) ? net.lat : null,
        ip_lng: Number.isFinite(net.lng) ? net.lng : null,
        browser_ip: str(d.browserIp, 64),
        browser_city: str(d.browserCity, 80),
        browser_country: str(d.browserCountry, 80),
        isp: str(d.isp, 120),
        device_model: str(d.model, 80) || ua.model || (/Mobi/.test(net.user_agent) ? "Phone (model hidden)" : ""),
        os: ua.os,
        browser: ua.browser,
        screen: str(d.screen, 40),
        language: str(d.language, 20),
        timezone: str(d.timezone, 60),
        user_agent: net.user_agent,
        last_path: str(d.path, 200),
        referrer: str(d.referrer, 300),
      },
    });
    send(res, 204, {});
  } catch (e) {
    console.error(e);
    send(res, 204, {}); // never break the store for visitors
  }
}
