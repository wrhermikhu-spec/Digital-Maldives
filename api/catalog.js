import { db } from "../lib/supabase.js";
import { send, fail } from "../lib/http.js";

// GET /api/catalog → shop settings + visible cards
export default async function handler(req, res) {
  try {
    const [settings, cards] = await Promise.all([
      db.select("settings", "id=eq.1&select=*"),
      db.select("card_stock", "active=eq.true&select=id,name,value_label,description,price,color,sort,stock&order=sort.asc,price.asc"),
    ]);
    res.setHeader("Cache-Control", "no-store");
    const st = settings[0] || { name: "Gift Card Shop", currency: "MVR" };
    send(res, 200, {
      settings: {
        name: st.name, currency: st.currency, bank_name: st.bank_name, account_name: st.account_name,
        account_number: st.account_number, instructions: st.instructions,
        instant: !!(st.instant_enabled && process.env.ANTHROPIC_API_KEY),
        instant_max_price: Number(st.instant_max_price ?? 0),
      },
      cards: cards.map(({ stock, ...c }) => ({ ...c, price: Number(c.price), in_stock: stock > 0 })),
    });
  } catch (e) { fail(res, e); }
}
