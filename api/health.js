export default async function handler(req, res) {
  const rawUrl = process.env.SUPABASE_URL || "";
  const rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const url = rawUrl.trim().replace(/\/$/, "");
  const key = rawKey.trim();
  let keyType = "(missing)";
  if (key.startsWith("sb_secret_")) keyType = "secret key - correct";
  else if (key.startsWith("sb_publishable_")) keyType = "PUBLISHABLE key - WRONG, use the secret key";
  else if (key.startsWith("eyJ")) {
    try { keyType = "legacy key, role = " + JSON.parse(Buffer.from(key.split(".")[1], "base64").toString()).role + " (must be service_role)"; }
    catch { keyType = "legacy key (could not read)"; }
  } else if (key) keyType = "UNKNOWN key format";
  const out = {
    SUPABASE_URL: url || "(missing)",
    url_ok: /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url),
    url_has_extra_spaces: rawUrl !== rawUrl.trim(),
    key_type: keyType,
    key_has_extra_spaces: rawKey !== rawKey.trim(),
    ADMIN_PASSWORD_set: !!process.env.ADMIN_PASSWORD,
    ADMIN_SECRET_set: !!process.env.ADMIN_SECRET,
  };
  try {
    const headers = key.startsWith("sb_secret_") ? { apikey: key } : { apikey: key, Authorization: "Bearer " + key };
    const r = await fetch(url + "/rest/v1/card_stock?select=id&limit=1", { headers });
    out.supabase_status = r.status;
    out.supabase_says = (await r.text()).slice(0, 300);
  } catch (e) { out.supabase_error = String(e.message || e); }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(out, null, 2));
}
