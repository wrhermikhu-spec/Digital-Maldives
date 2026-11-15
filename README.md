# Gift Card Shop: Vercel + Supabase

A small storefront for selling gift card PINs paid by bank transfer.

- **Buyer (`/`):** picks a card → sees your bank details → uploads the slip → gets a private order page. The PIN appears there automatically once you approve.
- **Admin (`/admin`):**
  - **Orders:** view the slip, then **Approve** (a PIN is pulled from stock automatically) or **Reject** with a reason.
  - **Customers:** names, contacts, **IP address, city/country, phone model, OS, browser, screen, language, timezone**, order count, total spent. Flags shared IPs and past rejected slips.
  - **Stock / Cards / Settings:** paste PINs, manage cards and prices, and set your bank details.

No npm packages and no build step. It's plain HTML/JS plus 4 Vercel serverless functions.

```
api/catalog.js   GET  shop settings + cards
api/orders.js    POST create order (uploads slip, records IP/device)
api/order.js     GET  buyer's order status / PIN
api/admin.js     POST admin actions (password protected)
lib/             Supabase REST client, helpers
public/          the website
supabase/schema.sql
```

## Setup

### 1. Supabase
1. Create a project at https://supabase.com (free tier is fine; pick region **Mumbai** or **Singapore** for the Maldives).
2. Go to **SQL Editor → New query**, paste all of `supabase/schema.sql`, and **Run**. This creates the tables, the approval function, and a private `slips` storage bucket.
3. Under **Project Settings → API**, copy:
   - **Project URL**
   - **service_role** key (or a **secret key** `sb_secret_…`). ⚠ Keep it secret: it goes only into Vercel, never into the website code.

### 2. Vercel
1. Put this folder in a GitHub repo, then on https://vercel.com click **Add New → Project** and import the repo. Framework preset: **Other**. No build command is needed.
2. Under **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | `https://xxxx.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | your service_role / secret key |
   | `ADMIN_PASSWORD` | a long password for `/admin` |
   | `ADMIN_SECRET` | any long random string (signs admin sessions) |

3. **Deploy** (or redeploy after adding the variables).

### 3. First run
Open `https://your-site.vercel.app/admin` and log in. Then:
1. **Settings:** add your bank details.
2. **Cards:** add cards.
3. **Stock:** paste PINs.

Your store is live.

## How the buyer info is collected
| Field | Source | Reliability |
|---|---|---|
| IP address, city, region, country | Vercel's servers (`x-real-ip`, `x-vercel-ip-*` headers) | Real connection IP. A VPN or proxy shows the VPN's IP. |
| OS, browser, in-app browser (Facebook/Instagram/Viber) | User-Agent header | Good, but spoofable |
| Phone model | Android Client Hints (e.g. `SM-S918B`), else User-Agent | Android: real model. **iPhone: only "iPhone"**, because Apple hides the model. |
| Screen, language, timezone, visitor ID | Buyer's browser | Signal only |

Customers are grouped by a random visitor ID stored in the buyer's browser, or by contact if that's missing.

The checkout page tells buyers this is recorded for fraud prevention. Check local privacy rules, and don't keep it longer than you need.

## Security
- The database has RLS on with no public policies. Only the Vercel functions, using the service key, can read or write.
- PINs never leave the server until an order is approved. Approval runs in one Postgres transaction (`FOR UPDATE SKIP LOCKED`), so a PIN can't go to two orders.
- Buyer order links use random UUIDs. Orders can't be listed or guessed.
- Prices are taken from the database, not the browser. Slips must be real JPEGs (the browser converts screenshots to JPEG).
- There is a basic anti-spam limit of 5 orders per IP per 15 minutes (change `MAX_ORDERS_PER_IP` in `api/orders.js`).
- Admin login uses one password from env vars, a 12-hour signed session, and a slowed-down login to deter guessing.

## Notes
- Slips are stored in the private `slips` bucket. Admins see them through 10-minute signed links.
- The admin page refreshes every 20 seconds. Use ↻ to refresh right away.
- To change the currency or shop name, use Settings in the admin page.
