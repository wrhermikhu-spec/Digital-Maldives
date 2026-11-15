import { db } from "../lib/supabase.js";
import { send, fail, bad, isUuid } from "../lib/http.js";

// GET /api/order?id=<uuid> → the buyer's order status (and PIN once approved).
// The random UUID in the link is the buyer's key; orders can't be listed.
export default async function handler(req, res) {
  try {
    const id = new URL(req.url, "http://x").searchParams.get("id");
    if (!isUuid(id)) throw bad("Order not found", 404);
    const rows = await db.select("orders", `id=eq.${id}&select=id,card_name,price,currency,status,pin,note,created_at`);
    if (!rows.length) throw bad("Order not found", 404);
    const o = rows[0];
    if (o.status !== "approved") delete o.pin;
    send(res, 200, { ...o, price: Number(o.price) });
  } catch (e) { fail(res, e); }
}
