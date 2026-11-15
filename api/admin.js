import { db, storage } from "../lib/supabase.js";
import { send, fail, bad, readJson, str, isUuid, makeToken, checkToken, passwordOk } from "../lib/http.js";

// POST /api/admin  { action, ...args }   (all actions except "login" need the Bearer token)
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  try {
    const b = await readJson(req);

    if (b.action === "login") {
      if (!process.env.ADMIN_PASSWORD) throw bad("ADMIN_PASSWORD is not set in Vercel environment variables.", 500);
      await new Promise(r => setTimeout(r, 400)); // slow down guessing
      if (!passwordOk(b.password)) throw bad("Wrong password.", 401);
      return send(res, 200, { token: makeToken(12) });
    }
    if (!checkToken(req)) throw bad("Session expired — please log in again.", 401);

    const action = actions[b.action];
    if (!action) throw bad("Unknown action");
    send(res, 200, await action(b));
  } catch (e) { fail(res, e); }
}

const ORDER_FIELDS = "*";

const actions = {
  async dashboard() {
    const [orders, cards, settings, visits] = await Promise.all([
      db.select("orders", `select=${ORDER_FIELDS}&order=created_at.desc&limit=1000`),
      db.select("card_stock", "select=*&order=sort.asc,price.asc"),
      db.select("settings", "id=eq.1&select=*"),
      db.select("visits", "select=*&order=last_seen.desc&limit=1000").catch(() => []),
    ]);
    return {
      orders: orders.map(o => ({ ...o, price: Number(o.price) })),
      cards: cards.map(c => ({ ...c, price: Number(c.price) })),
      settings: { ...(settings[0] || {}), ai_key_set: !!process.env.OCR_SPACE_API_KEY },
      visits,
    };
  },

  async slip({ id }) {
    if (!isUuid(id)) throw bad("Bad order id");
    const [o] = await db.select("orders", `id=eq.${id}&select=slip_path`);
    if (!o) throw bad("Order not found", 404);
    return { url: await storage.signedUrl("slips", o.slip_path, 600) };
  },

  async approve({ id }) {
    if (!isUuid(id)) throw bad("Bad order id");
    try {
      const pin = await db.rpc("approve_order", { p_order: id });
      return { pin };
    } catch (e) {
      if (/NO_STOCK/.test(e.message)) throw bad("No PINs left for this card. Add stock first.", 409);
      if (/ORDER_NOT_PENDING/.test(e.message)) throw bad("This order was already reviewed.", 409);
      throw e;
    }
  },

  async reject({ id, note }) {
    if (!isUuid(id)) throw bad("Bad order id");
    const rows = await db.update("orders", `id=eq.${id}&status=in.(pending,verify_required,verify_submitted)`, {
      status: "rejected", note: str(note, 300) || "We couldn't verify this payment.", reviewed_at: new Date().toISOString(),
    });
    if (!rows.length) throw bad("This order was already reviewed.", 409);
    return { ok: true };
  },

  async requestVerification({ id, note }) {
    if (!isUuid(id)) throw bad("Bad order id");
    const rows = await db.update("orders", `id=eq.${id}&status=eq.pending`, {
      status: "verify_required",
      verify_note: str(note, 300) || "We need to confirm your identity before we can deliver this order.",
      verify_requested_at: new Date().toISOString(),
    });
    if (!rows.length) throw bad("Only pending orders can be sent for verification.", 409);
    return { ok: true };
  },

  async kyc({ id }) {
    if (!isUuid(id)) throw bad("Bad order id");
    const [o] = await db.select("orders", `id=eq.${id}&select=id_path,selfie_path`);
    if (!o?.id_path) throw bad("No ID photos for this order.", 404);
    const [idUrl, selfieUrl] = await Promise.all([
      storage.signedUrl("kyc", o.id_path, 600),
      o.selfie_path ? storage.signedUrl("kyc", o.selfie_path, 600) : null,
    ]);
    return { idUrl, selfieUrl };
  },

  async deleteKyc({ id }) {
    if (!isUuid(id)) throw bad("Bad order id");
    const [o] = await db.select("orders", `id=eq.${id}&select=id_path,selfie_path,status`);
    if (!o) throw bad("Order not found", 404);
    if (o.status === "verify_submitted") throw bad("Approve or reject the order first.", 409);
    const paths = [o.id_path, o.selfie_path].filter(Boolean);
    if (paths.length) await storage.remove("kyc", paths);
    await db.update("orders", `id=eq.${id}`, { id_path: null, selfie_path: null });
    return { ok: true };
  },

  async saveCard({ card }) {
    const row = {
      name: str(card?.name, 80),
      value_label: str(card?.value_label, 40),
      description: str(card?.description, 200),
      price: Number(card?.price),
      color: /^#[0-9a-f]{6}$/i.test(card?.color) ? card.color : "#0f766e",
      sort: Math.trunc(Number(card?.sort) || 0),
      active: !!card?.active,
    };
    if (!row.name) throw bad("Card name is required.");
    if (!(row.price >= 0)) throw bad("Enter a valid price.");
    if (card.id) {
      if (!isUuid(card.id)) throw bad("Bad card id");
      await db.update("cards", `id=eq.${card.id}`, row);
    } else {
      await db.insert("cards", row);
    }
    return { ok: true };
  },

  async addPins({ cardId, codes }) {
    if (!isUuid(cardId)) throw bad("Bad card id");
    const list = [...new Set((Array.isArray(codes) ? codes : []).map(c => str(c, 200)).filter(Boolean))].slice(0, 2000);
    if (!list.length) throw bad("Paste at least one PIN.");
    const inserted = await db.upsert("pins", list.map(code => ({ card_id: cardId, code })), "card_id,code");
    return { added: inserted.length, duplicates: list.length - inserted.length };
  },

  async saveSettings({ settings: s }) {
    const row = {
      name: str(s?.name, 80) || "Gift Card Shop",
      currency: str(s?.currency, 8) || "MVR",
      bank_name: str(s?.bank_name, 80),
      account_name: str(s?.account_name, 120),
      account_number: str(s?.account_number, 60),
      instructions: str(s?.instructions, 400),
      instant_enabled: !!s?.instant_enabled,
      instant_max_price: Math.max(0, Number(s?.instant_max_price) || 0),
      instant_daily_limit: Math.max(0, Math.trunc(Number(s?.instant_daily_limit) || 0)),
    };
    await db.update("settings", "id=eq.1", row);
    return { ok: true };
  },
};
