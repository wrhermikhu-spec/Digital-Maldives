import crypto from "node:crypto";

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

export function fail(res, err) {
  if (!err.expose) console.error(err);
  send(res, err.expose ? err.status || 400 : 500,{ error: err.expose ? err.message : "Something went wrong. Please try again." });
}

export function bad(message, status = 400) {
  return Object.assign(new Error(message), { status, expose: true });
}

export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export const str = (v, max) => String(v ?? "").trim().slice(0, max);
export const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));

// ---- buyer network info from Vercel's edge headers (set by Vercel, not the browser) ----
export function clientInfo(req) {
  const h = req.headers;
  const dec = v => { try { return decodeURIComponent(v || ""); } catch { return v || ""; } };
  const ip = String(h["x-real-ip"] || String(h["x-forwarded-for"] || "").split(",")[0] || req.socket?.remoteAddress || "").trim();
  return {
    ip: ip.slice(0, 64),
    city: dec(h["x-vercel-ip-city"]).slice(0, 80),
    region: dec(h["x-vercel-ip-country-region"]).slice(0, 80),
    country: dec(h["x-vercel-ip-country"]).slice(0, 8),
    lat: h["x-vercel-ip-latitude"] ? Number(h["x-vercel-ip-latitude"]) : null,
    lng: h["x-vercel-ip-longitude"] ? Number(h["x-vercel-ip-longitude"]) : null,
    user_agent: String(h["user-agent"] || "").slice(0, 400),
  };
}

// ---- admin session tokens (HMAC-signed, no database needed) ----
const SECRET = () => process.env.ADMIN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";

export function makeToken(hours = 12) {
  const exp = Date.now() + hours * 3600e3;
  const sig = crypto.createHmac("sha256", SECRET()).update(String(exp)).digest("base64url");
  return `${exp}.${sig}`;
}

export function checkToken(req) {
  const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const [exp, sig] = t.split(".");
  if (!exp || !sig || Number(exp) < Date.now() || !SECRET()) return false;
  const good = crypto.createHmac("sha256", SECRET()).update(exp).digest("base64url");
  return good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig));
}

export function passwordOk(given) {
  const real = process.env.ADMIN_PASSWORD || "";
  if (!real) return false;
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(real).digest();
  return crypto.timingSafeEqual(a, b);
}
