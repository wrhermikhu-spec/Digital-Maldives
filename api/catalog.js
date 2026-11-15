import { db } from "../lib/supabase.js";
import { send, fail } from "../lib/http.js";

// GET /api/catalog → shop settings + visible cards
export default async function handler(req, res) {
  try {
    const [settings, cards] = await Promise.all([
      db.select("settings", "id=eq.1&select=name,currency,bank_name,account_name,account_number,instructions"),
      db.select("card_stock", "active=eq.true&select=id,name,value_label,description,price,color,sort,stock&order=sort.asc,price.asc"),
    ]);
    res.setHeader("Cache-Control", "no-store");
    send(res, 200, {
      settings: settings[0] || { name: "Gift Card Shop", currency: "MVR" },
      cards: cards.map(({ stock, ...c }) => ({ ...c, price: Number(c.price), in_stock: stock > 0 })),
    });
  } catch (e) { fail(res, e); }
}
