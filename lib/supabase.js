// Tiny Supabase client (REST + Storage) using fetch — no npm dependencies.
const BASE = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";

function authHeaders() {
  // New-style secret keys (sb_secret_…) go in `apikey` only; legacy service_role JWTs also as Bearer.
  return KEY.startsWith("sb_secret_") ? { apikey: KEY } : { apikey: KEY, Authorization: `Bearer ${KEY}` };
}

async function call(path, { method = "GET", body, headers = {} } = {}) {
  if (!BASE || !KEY) throw Object.assign(new Error("Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"), { status: 500 });
  const isRaw = body instanceof Uint8Array || typeof body === "string";
  const res = await fetch(BASE + path, {
    method,
    headers: { ...authHeaders(), ...(isRaw ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error || data.msg)) || `Supabase error ${res.status}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

export const db = {
  select: (table, query = "") => call(`/rest/v1/${table}?${query}`),
  insert: (table, row) => call(`/rest/v1/${table}`, { method: "POST", body: row, headers: { Prefer: "return=representation" } }),
  update: (table, query, patch) => call(`/rest/v1/${table}?${query}`, { method: "PATCH", body: patch, headers: { Prefer: "return=representation" } }),
  remove: (table, query) => call(`/rest/v1/${table}?${query}`, { method: "DELETE" }),
  upsert: (table, rows, onConflict) => call(`/rest/v1/${table}${onConflict ? `?on_conflict=${onConflict}` : ""}`, {
    method: "POST", body: rows, headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
  }),
  rpc: (fn, args) => call(`/rest/v1/rpc/${fn}`, { method: "POST", body: args }),
};

export const storage = {
  upload: (bucket, path, bytes, contentType) =>
    call(`/storage/v1/object/${bucket}/${path}`, { method: "POST", body: bytes, headers: { "Content-Type": contentType, "x-upsert": "false" } }),
  signedUrl: async (bucket, path, expiresIn = 3600) => {
    const r = await call(`/storage/v1/object/sign/${bucket}/${path}`, { method: "POST", body: { expiresIn } });
    const u = r.signedURL || r.signedUrl;
    return u.startsWith("http") ? u : `${BASE}/storage/v1${u}`;
  },
  remove: (bucket, paths) => call(`/storage/v1/object/${bucket}`, { method: "DELETE", body: { prefixes: paths } }),
};

export const enc = encodeURIComponent;
