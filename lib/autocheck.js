// Instant verification: read slip + ID text with free OCR, then run strict checks in code.

// Free OCR (OCR.space): reads the raw text of each image; all parsing + decisions happen here.
const WINDOW_MIN = 30; // transfer must happen within 30 min of starting checkout
const TZ = "+05:00";   // Maldives time on slips

async function ocr(b64) {
  const key = process.env.OCR_SPACE_API_KEY;
  if (!key) throw new Error("OCR_SPACE_API_KEY not set");
  const form = new URLSearchParams({ apikey: key, base64Image: "data:image/jpeg;base64," + b64, language: "eng", OCREngine: "2", scale: "true", detectOrientation: "true" });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch("https://api.ocr.space/parse/image", { method: "POST", body: form, signal: ctrl.signal });
    const j = await res.json();
    if (!res.ok || j.IsErroredOnProcessing) throw new Error([].concat(j.ErrorMessage || `OCR error ${res.status}`).join(" "));
    return (j.ParsedResults || []).map(r => r.ParsedText || "").join("\n");
  } finally { clearTimeout(timer); }
}

// ---------- slip text parsing ----------
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad = n => String(n).padStart(2, "0");
function to24(h, ap) { h = Number(h); if (!ap) return h; ap = ap.toUpperCase(); if (ap === "PM" && h < 12) return h + 12; if (ap === "AM" && h === 12) return 0; return h; }

export function findDates(t) {
  const out = [];
  const add = (y, m, d) => { y = Number(y); if (y < 100) y += 2000; m = Number(m); d = Number(d); if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2020 && y <= 2100) out.push(`${y}-${pad(m)}-${pad(d)}`); };
  for (const m of t.matchAll(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/g)) add(m[3], m[2], m[1]);            // 15/11/2026 (day first)
  for (const m of t.matchAll(/\b(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})\b/g)) add(m[1], m[2], m[3]);               // 2026-11-15
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([A-Za-z]{3,9})[,\s\-]+(\d{4})\b/g)) { const mo = MONTHS[m[2].slice(0, 4).toUpperCase()] || MONTHS[m[2].slice(0, 3).toUpperCase()]; if (mo) add(m[3], mo, m[1]); } // 15 Nov 2026
  for (const m of t.matchAll(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/g)) { const mo = MONTHS[m[1].slice(0, 3).toUpperCase()]; if (mo) add(m[3], mo, m[2]); } // Nov 15, 2026
  return [...new Set(out)];
}
export function findTimes(t) {
  const out = [];
  for (const m of t.matchAll(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?\b/g)) {
    const h = to24(m[1], m[3]), mi = Number(m[2]);
    if (h <= 23 && mi <= 59) out.push(`${pad(h)}:${pad(mi)}`);
  }
  return [...new Set(out)];
}
export function findAmounts(t) {
  const out = [];
  const cur = "(MVR|MRF|Rf\\.?|RF|USD|US\\$|\\$)";
  const num = "(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)";
  for (const m of t.matchAll(new RegExp(cur + "\\s*" + num, "gi"))) out.push({ cur: m[1], v: Number(m[2].replace(/,/g, "")) });
  for (const m of t.matchAll(new RegExp(num + "\\s*" + cur, "gi"))) out.push({ cur: m[2], v: Number(m[1].replace(/,/g, "")) });
  // "Amount" label followed by a number on the same or next line
  for (const m of t.matchAll(/amount[^\n\d]{0,20}\n?\s*([\d,]+\.\d{2})/gi)) out.push({ cur: "", v: Number(m[1].replace(/,/g, "")) });
  return out;
}
function lineAfter(lines, re) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const rest = lines[i].slice(m.index + m[0].length).replace(/^[\s:\-]+/, "").trim();
    if (rest && /[A-Za-z]{2,}/.test(rest)) return rest;
    if (lines[i + 1] && /[A-Za-z]{2,}/.test(lines[i + 1])) return lines[i + 1].trim();
  }
  return null;
}
export function parseSlip(text) {
  const t = String(text || "");
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const dates = findDates(t), times = findTimes(t);
  const datetimes = [];
  for (const d of dates) for (const tm of times) datetimes.push(`${d} ${tm}`);
  let reference = null;
  const r1 = t.match(/(?:ref(?:erence)?|transaction\s*(?:id|no|number|ref)|txn\s*(?:id|no)?|trx\s*(?:id|no)?)\s*(?:no\.?|number|#|id)?\s*[:\-]?\s*\n?\s*([A-Z0-9][A-Z0-9\-]{5,})/i);
  if (r1) reference = r1[1].toUpperCase();
  else { const r2 = t.match(/\b[A-Z]{2,6}\d{6,}\b/); if (r2) reference = r2[0]; }
  return {
    text: t,
    is_bank_receipt: /transfer|transaction|receipt|payment|remittance|debit|credit/i.test(t) && (dates.length > 0 || times.length > 0),
    successful: /success|successful|completed|approved|done|sent/i.test(t) && !/failed|declined|rejected|unsuccessful|pending/i.test(t),
    sender_name: lineAfter(lines, /\b(from|sender|sent by|debit(?:ed)? from|from account(?: name)?|payer)\b/i),
    recipient_name: lineAfter(lines, /\b(to|beneficiary|recipient|credit(?:ed)? to|to account(?: name)?|payee)\b/i),
    amounts: findAmounts(t),
    datetimes,
    reference,
  };
}

// ---------- ID text parsing ----------
const ID_WORDS = /REPUBLIC|MALDIVES|DHIVEHI|IDENTITY|NATIONAL|CARD|SEX|GENDER|DATE|BIRTH|EXPIR|ISSUE|VALID|ADDRESS|SIGNATURE|NATIONALITY|PERMANENT|PASSPORT|NUMBER|NAME|ATOLL|ISLAND|MALE|FEMALE|DEPARTMENT/;
export function parseId(text) {
  const t = String(text || "");
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let name = lineAfter(lines, /\b(full name|name|surname and given names)\b/i);
  if (name && ID_WORDS.test(name.toUpperCase())) name = null;
  if (!name) {
    const cands = lines.filter(l => /^[A-Za-z][A-Za-z .'\-]{4,}$/.test(l) && l.split(/\s+/).length >= 2 && l.split(/\s+/).length <= 6 && !ID_WORDS.test(l.toUpperCase()));
    name = cands.sort((a, b) => b.length - a.length)[0] || null;
  }
  const idNo = (t.match(/\b[A-Z]\d{6}\b/) || [])[0] || null;
  let expiry = null;
  const ex = t.match(/(?:expiry|expires|date of expiry|valid until|valid thru)[^\n\d]{0,20}\n?\s*([^\n]{6,20})/i);
  if (ex) expiry = findDates(ex[1])[0] || null;
  return {
    is_id_document: /MALDIVES|IDENTITY|NATIONAL ID|ID CARD|PASSPORT|DRIVING/i.test(t) || !!idNo,
    full_name: name,
    id_number: idNo,
    expiry,
  };
}

export async function readDocuments(slipB64, idB64) {
  const [slipText, idText] = await Promise.all([ocr(slipB64), ocr(idB64)]);
  return { slip: parseSlip(slipText), id: parseId(idText) };
}

// ---------- name matching ----------
const STOP = new Set(["MR", "MRS", "MS", "MISS", "DR", "BIN", "BINT", "BINTH", "IBN"]);
const ALIAS = { MOHD: "MOHAMED", MOHAMMED: "MOHAMED", MUHAMMAD: "MOHAMED", MUHAMMED: "MOHAMED", MOHAMMAD: "MOHAMED", AHMAD: "AHMED", ABDUL: "ABDUL", IBRAHEEM: "IBRAHIM", HASAN: "HASSAN", HUSAIN: "HUSSAIN", HUSSEIN: "HUSSAIN" };
export function nameTokens(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z\s.]/g, " ").replace(/\./g, " ").split(/\s+/)
    .filter(Boolean).filter(t => !STOP.has(t)).map(t => ALIAS[t] || t);
}
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Slip names are often shortened ("AHMED N"). Every slip token must match an ID token
// (exact, 1 typo for long words, or an initial), and at least 2 tokens must match (or the
// single full word if the slip shows only one long name).
export function namesMatch(slipName, idName) {
  const s = nameTokens(slipName), id = nameTokens(idName);
  if (!s.length || !id.length) return false;
  let full = 0, initials = 0;
  for (const t of s) {
    const hit = id.find(x => x === t
      || (t.length >= 5 && x.length >= 5 && lev(t, x) <= 1)
      || (t.length >= 5 && x.length >= 5 && (x.startsWith(t) || t.startsWith(x))));
    if (hit) { full++; continue; }
    if (t.length === 1 && id.some(x => x[0] === t)) { initials++; continue; }
    return false; // a word on the slip that isn't on the ID → no match
  }
  return full >= 2 || (full >= 1 && initials >= 1) || (full === 1 && s.length === 1 && s[0].length >= 4 && id.length <= 2);
}

const digits = s => String(s || "").replace(/\D/g, "");

// ---------- the rules ----------
const cur = c => { const u = String(c || "").toUpperCase().replace(/[^A-Z$]/g, ""); return ["MVR", "MRF", "RF", "RUFIYAA", "RUFIYA"].includes(u) ? "MVR" : ["$", "USD", "US", "US$"].includes(u) ? "USD" : u; };

export function evaluate({ data, order, settings, startedAt, now = Date.now(), refUsed }) {
  const slip = data?.slip || {}, id = data?.id || {};
  const checks = [];
  const add = (key, ok, detail) => checks.push({ key, ok: !!ok, detail });
  const text = String(slip.text || "");

  add("slip_readable", slip.is_bank_receipt && slip.successful, slip.is_bank_receipt ? (slip.successful ? "Looks like a successful transfer receipt" : "Couldn't find \"successful\" on the receipt") : "Doesn't look like a bank receipt");
  add("id_readable", id.is_id_document && id.full_name, id.is_id_document ? `ID name: ${id.full_name || "unreadable"}` : "Doesn't look like an ID card");
  if (id.expiry) add("id_not_expired", new Date(id.expiry) >= new Date(new Date(now).toDateString()), `Expiry ${id.expiry}`);

  // Name: use the "From/Sender" line if found; otherwise require 2+ ID name words to appear on the slip
  // (ignoring words that are part of our own account name).
  const ours = new Set(nameTokens(settings.account_name));
  let nameOk = false, nameDetail;
  if (slip.sender_name && id.full_name) {
    nameOk = namesMatch(slip.sender_name, id.full_name);
    nameDetail = `Slip sender "${slip.sender_name}" vs ID "${id.full_name}"`;
  }
  if (!nameOk && id.full_name) {
    const slipWords = new Set(nameTokens(text));
    const hits = nameTokens(id.full_name).filter(w => w.length >= 3 && !ours.has(w) && slipWords.has(w));
    if (hits.length >= 2) { nameOk = true; nameDetail = `ID name words found on slip: ${hits.join(", ")}`; }
    else nameDetail = nameDetail || `ID name "${id.full_name}" not found on slip`;
  }
  add("name_match", nameOk, nameDetail || "Name not readable");

  const amounts = slip.amounts || [];
  const hit = amounts.find(a => Math.abs(a.v - Number(order.price)) < 0.005 && (!a.cur || cur(a.cur) === cur(order.currency)));
  add("amount_match", hit, hit ? `Found ${order.currency} ${order.price}` : `Price ${order.price} ${order.currency} not found (saw: ${amounts.map(a => a.v).slice(0, 5).join(", ") || "none"})`);

  const digitsText = digits(text);
  const ourAcc = digits(settings.account_number);
  // Full number, last 6 digits, or the masked form banks show (e.g. 7730*****3456)
  const masked = ourAcc.length >= 8 && new RegExp(ourAcc.slice(0, 4) + "[\\s*xX•·.\\-]{2,}" + ourAcc.slice(-4)).test(text);
  const accOk = ourAcc.length >= 6 && (digitsText.includes(ourAcc) || digitsText.includes(ourAcc.slice(-6)) || masked);
  const nameTo = [...ours].filter(w => w.length > 2).some(w => new Set(nameTokens(text)).has(w));
  add("paid_to_us", accOk || nameTo, accOk ? "Our account number found on slip" : nameTo ? "Our account name found on slip" : "Our account not found on slip");

  const startMin = Math.floor(startedAt / 60000) * 60000; // slips show minutes only
  const inWin = ms => Number.isFinite(ms) && ms >= startMin - 60000 && ms <= startedAt + WINDOW_MIN * 60000 && ms <= now + 120000;
  const dts = (slip.datetimes || []).map(d => ({ d, ms: Date.parse(d.replace(" ", "T") + ":00" + TZ) }));
  const okDt = dts.find(x => inWin(x.ms));
  const startLocal = new Date(startedAt + 5 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  add("within_30_min", okDt, okDt ? `Transfer ${okDt.d} · checkout started ${startLocal}` : dts.length ? `Transfer time ${dts[0].d} is outside 30 min of ${startLocal}` : "Transfer date/time not readable");

  add("reference_new", slip.reference && !refUsed, slip.reference ? (refUsed ? `Reference ${slip.reference} already used` : `Reference ${slip.reference}`) : "No reference number found");

  return { passed: checks.every(c => c.ok), checks, extracted: { slip: { ...slip, text: text.slice(0, 1500) }, id } };
}
