import { $, $$, esc, money, when, toast, api, CARD_COLORS } from "/common.js";

let token = sessionStorage.getItem("gc_admin") || "";
let orders = [], cards = [], visits = [], shop = { currency: "MVR" };
let vfilter = "all";
let filter = "pending";
let refreshTimer = null;

// ---------- auth ----------
const call = (action, args = {}) => api("/api/admin", { method: "POST", token, body: { action, ...args } }).catch(e => {
  if (e.status === 401) logout(e.message);
  throw e;
});

function logout(msg = "") {
  token = ""; sessionStorage.removeItem("gc_admin");
  clearTimeout(refreshTimer);
  $("#app").hidden = true; $("#login").hidden = false; $("#logoutBtn").hidden = true; $("#refreshBtn").hidden = true;
  $("#loginErr").textContent = msg;
}

$("#loginForm").onsubmit = async e => {
  e.preventDefault();
  $("#loginErr").textContent = "";
  try {
    const r = await api("/api/admin", { method: "POST", body: { action: "login", password: new FormData(e.target).get("password") } });
    token = r.token; sessionStorage.setItem("gc_admin", token);
    e.target.reset();
    enter();
  } catch (err) { $("#loginErr").textContent = err.message; }
};
$("#logoutBtn").onclick = () => logout();
$("#refreshBtn").onclick = () => refresh(true);

function enter() {
  $("#login").hidden = true; $("#app").hidden = false; $("#logoutBtn").hidden = false; $("#refreshBtn").hidden = false;
  refresh();
}

async function refresh(manual = false) {
  clearTimeout(refreshTimer);
  try {
    const d = await call("dashboard");
    orders = d.orders; cards = d.cards; visits = d.visits || []; shop = { currency: "MVR", ...d.settings };
    const p = orders.filter(o => o.status === "pending" || o.status === "verify_submitted").length;
    $("#pendingBadge").textContent = p || "";
    document.title = (p ? `(${p}) ` : "") + "Admin";
    renderOrders(); renderCustomers(); renderVisitors(); renderStock(); renderCards(); fillSettings();
    if (manual) toast("Updated");
  } catch (e) { if (e.status !== 401) toast(e.message, "err"); }
  if (token) refreshTimer = setTimeout(refresh, document.hidden ? 60000 : 20000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && token) refresh(); });

// ---------- tabs ----------
$$(".tabs button").forEach(b => (b.onclick = () => {
  $$(".tabs button").forEach(x => x.classList.toggle("on", x === b));
  $$("[data-pane]").forEach(p => (p.hidden = p.dataset.pane !== b.dataset.tab));
}));
$$(".filters [data-f]").forEach(b => (b.onclick = () => {
  filter = b.dataset.f;
  $$(".filters [data-f]").forEach(x => x.classList.toggle("on", x === b));
  renderOrders();
}));
$("#orderSearch").oninput = renderOrders;
$("#custSearch").oninput = renderCustomers;
$("#visSearch").oninput = renderVisitors;
$$(".filters [data-vf]").forEach(b => (b.onclick = () => {
  vfilter = b.dataset.vf;
  $$(".filters [data-vf]").forEach(x => x.classList.toggle("on", x === b));
  renderVisitors();
}));

// ---------- helpers ----------
const place = o => [o.city, o.region, o.country].filter(Boolean).join(", ");
const bPlace = o => [o.browser_city, o.browser_country].filter(Boolean).join(", ");
const mapUrl = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;
const ipFamily = ip => (String(ip).includes(":") ? 6 : 4);
// Only compare when both are IPv4 or both IPv6 (a phone can use either for different requests)
const ipMismatch = o => o.ip && o.browser_ip && ipFamily(o.ip) === ipFamily(o.browser_ip) && o.ip !== o.browser_ip;
const gpsText = o => o.gps_status === "granted" && o.gps_lat != null
  ? `<a href="${mapUrl(o.gps_lat, o.gps_lng)}" target="_blank" rel="noopener">${Number(o.gps_lat).toFixed(5)}, ${Number(o.gps_lng).toFixed(5)}</a> <span class="muted">±${Math.round(o.gps_accuracy || 0)} m</span>`
  : `<span class="muted">${{ not_granted: "Not shared", unavailable: "Not available", timeout: "Timed out" }[o.gps_status] || "Not shared"}</span>`;

const devLine = o => `📱 <b>${esc(o.device_model || "?")}</b> · ${esc(o.os || "")} · ${esc(o.browser || "")}<br>
  🖥 Server IP <b>${esc(o.ip || "?")}</b>${place(o) ? ` · ${esc(place(o))}` : ""}<br>
  🌐 Browser IP <b>${esc(o.browser_ip || "?")}</b>${o.isp ? ` · ${esc(o.isp)}` : ""}${bPlace(o) ? ` · ${esc(bPlace(o))}` : ""}<br>
  📍 GPS ${gpsText(o)}`;

function devTable(o) {
  const rows = [
    ["Server IP (Vercel)", esc(o.ip)],
    ["Server IP location", esc(place(o)) + (o.ip_lat != null ? ` · <a href="${mapUrl(o.ip_lat, o.ip_lng)}" target="_blank" rel="noopener">map</a>` : "")],
    ["Browser IP", esc(o.browser_ip) + (ipMismatch(o) ? ' <span class="flag inline">differs</span>' : "")],
    ["ISP / network", esc(o.isp)],
    ["Browser IP location", esc([o.browser_city, o.browser_region, o.browser_country].filter(Boolean).join(", "))],
    ["GPS location", gpsText(o)],
    ["Phone / device", esc(o.device_model)], ["OS", esc(o.os)], ["Browser", esc(o.browser)],
    ["Screen", esc(o.screen)], ["Language", esc(o.language)], ["Timezone", esc(o.timezone)],
    ["Visitor ID", esc(o.visitor_id)], ["User agent", esc(o.user_agent)],
  ];
  return `<table class="kv">${rows.filter(r => r[1]).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>`;
}

const matches = (o, q) => !q || [o.buyer_name, o.contact, o.card_name, o.id, o.ip, o.browser_ip, o.isp, o.device_model, o.city, o.browser_city]
  .some(v => String(v || "").toLowerCase().includes(q));

const custKey = o => o.visitor_id || `c:${(o.contact || "").toLowerCase()}`;

function sharedIps() {
  const byIp = {};
  for (const o of orders) for (const ip of new Set([o.ip, o.browser_ip])) if (ip) (byIp[ip] ||= new Set()).add(custKey(o));
  return new Set(Object.entries(byIp).filter(([, s]) => s.size > 1).map(([ip]) => ip));
}

// ---------- orders ----------
function renderOrders() {
  const q = $("#orderSearch").value.trim().toLowerCase();
  const shared = sharedIps();
  const rejectedKeys = new Set(orders.filter(o => o.status === "rejected").map(custKey));
  const inFilter = o => filter === "all" || o.status === filter || (filter === "verify" && o.status.startsWith("verify"));
  const list = orders.filter(o => inFilter(o) && matches(o, q));
  $("#ordersList").innerHTML = list.length ? list.map(o => {
    const flags = [];
    if (shared.has(o.ip) || shared.has(o.browser_ip)) flags.push("IP used by another customer");
    if (ipMismatch(o)) flags.push("Browser IP differs from server IP (VPN/proxy?)");
    if (rejectedKeys.has(custKey(o)) && o.status !== "rejected") flags.push("Had a rejected slip before");
    const stock = cards.find(c => c.id === o.card_id)?.stock ?? 0;
    return `<article class="order ${o.status}">
      <div class="order-top">
        <div><b>${esc(o.card_name)}</b> · ${money(o.price, o.currency)}<br>
          <span class="small muted">${esc(o.id.slice(0, 8).toUpperCase())} · ${when(o.created_at)}</span></div>
        <span class="tag ${o.status}">${STATUS[o.status] || o.status}</span>
      </div>
      <div class="small"><b>${esc(o.buyer_name)}</b> · ${esc(o.contact)}</div>
      <div class="small dev">${devLine(o)}</div>
      ${flags.length ? `<div class="flag">⚠ ${flags.map(esc).join(" · ")}</div>` : ""}
      ${o.status === "approved" ? `<div class="small">PIN sent: <code>${esc(o.pin)}</code></div>` : ""}
      ${o.status === "rejected" && o.note ? `<div class="small muted">Reason: ${esc(o.note)}</div>` : ""}
      ${o.status === "verify_required" ? `<div class="small muted">Waiting for buyer to upload ID · asked ${when(o.verify_requested_at)}</div>` : ""}
      ${o.status === "verify_submitted" ? `<div class="flag" style="background:#ede9fe;color:#5b21b6">🪪 ID submitted ${when(o.verify_submitted_at)}: review it</div>` : ""}
      <div class="row gap wrapr">
        <button class="btn" data-slip="${o.id}">View slip</button>
        <button class="btn" data-dev="${o.id}">Device details</button>
        ${o.id_path ? `<button class="btn" data-kyc="${o.id}">🪪 View ID</button>` : ""}
        ${o.status === "pending" || o.status === "verify_submitted" ? `<button class="btn ok" data-approve="${o.id}">Approve${stock <= 0 ? " (no stock!)" : ""}</button>` : ""}
        ${o.status === "pending" ? `<button class="btn" data-askid="${o.id}">Request ID</button>` : ""}
        ${["pending", "verify_required", "verify_submitted"].includes(o.status) ? `<button class="btn bad" data-reject="${o.id}">Reject</button>` : ""}
        ${o.id_path && ["approved", "rejected"].includes(o.status) ? `<button class="btn bad" data-delkyc="${o.id}">Delete ID photos</button>` : ""}
      </div>
    </article>`;
  }).join("") : `<div class="panel pad muted">No ${filter === "all" ? "" : filter} orders.</div>`;

  $$("[data-slip]").forEach(b => (b.onclick = () => viewSlip(b.dataset.slip)));
  $$("[data-dev]").forEach(b => (b.onclick = () => {
    const o = orders.find(x => x.id === b.dataset.dev);
    modal(`<h3>Device &amp; network</h3><p class="small muted">${esc(o.buyer_name)} · ${esc(o.contact)}</p>${devTable(o)}
      <p class="small muted">Server IP comes from Vercel. Browser IP, GPS and device details come from the buyer's phone.</p>
      <div class="row end"><button class="btn" data-close>Close</button></div>`);
  }));
  $$("[data-approve]").forEach(b => (b.onclick = () => confirmApprove(b.dataset.approve)));
  $$("[data-reject]").forEach(b => (b.onclick = () => rejectDialog(b.dataset.reject)));
  $$("[data-askid]").forEach(b => (b.onclick = () => askIdDialog(b.dataset.askid)));
  $$("[data-kyc]").forEach(b => (b.onclick = () => viewKyc(b.dataset.kyc)));
  $$("[data-delkyc]").forEach(b => (b.onclick = () => deleteKyc(b.dataset.delkyc)));
}

const STATUS = { pending: "Pending", approved: "Approved", rejected: "Rejected", verify_required: "ID requested", verify_submitted: "ID submitted" };

function askIdDialog(id) {
  const o = orders.find(x => x.id === id);
  modal(`<h3>Request ID verification</h3>
    <p class="small">${esc(o.buyer_name)} · ${esc(o.card_name)} · ${money(o.price, o.currency)}</p>
    <p class="small muted">The buyer's order page will ask for a photo of their ID card and a selfie holding it. The order stays on hold until you approve or reject.</p>
    <label>Message shown to buyer<textarea id="askNote" rows="3">For your security, we need to confirm your identity before delivering this order. Please upload a photo of your ID card and a selfie holding it. The name on the ID should match the bank account that sent the payment.</textarea></label>
    <div class="row end gap"><button class="btn" data-close>Cancel</button><button class="btn primary" id="doAsk">Request ID</button></div>`);
  $("#doAsk").onclick = async () => {
    try { await call("requestVerification", { id, note: $("#askNote").value }); closeModal(); toast("ID requested from buyer", "ok"); refresh(); }
    catch (e) { toast(e.message, "err"); }
  };
}

async function viewKyc(id) {
  const o = orders.find(x => x.id === id);
  modal(`<p class="pad center">Loading ID photos…</p>`);
  try {
    const [{ idUrl, selfieUrl }, slip] = await Promise.all([call("kyc", { id }), call("slip", { id }).catch(() => ({}))]);
    modal(`<h3>ID check · ${esc(o.buyer_name)}</h3>
      <p class="small">Name entered: <b>${esc(o.buyer_name)}</b> · ${esc(o.contact)}</p>
      <div class="kyc-grid">
        <figure><a href="${esc(idUrl)}" target="_blank" rel="noopener"><img src="${esc(idUrl)}" alt="ID card" /></a><figcaption>ID card</figcaption></figure>
        <figure><a href="${esc(selfieUrl)}" target="_blank" rel="noopener"><img src="${esc(selfieUrl)}" alt="Selfie with ID" /></a><figcaption>Selfie with ID</figcaption></figure>
        ${slip.url ? `<figure><a href="${esc(slip.url)}" target="_blank" rel="noopener"><img src="${esc(slip.url)}" alt="Slip" /></a><figcaption>Payment slip</figcaption></figure>` : ""}
      </div>
      <p class="small muted">Check: the face matches the ID photo · the name on the ID matches the slip's sender · the ID isn't edited or a screenshot.</p>
      <div class="row end gap">
        ${o.status === "verify_submitted" ? `<button class="btn bad" id="kReject">Reject</button><button class="btn ok" id="kApprove">Approve</button>` : ""}
        <button class="btn" data-close>Close</button></div>`);
    $("#kApprove")?.addEventListener("click", () => confirmApprove(id));
    $("#kReject")?.addEventListener("click", () => rejectDialog(id));
  } catch (e) { modal(`<p class="pad err">${esc(e.message)}</p><div class="row end"><button class="btn" data-close>Close</button></div>`); }
}

function deleteKyc(id) {
  modal(`<h3>Delete ID photos?</h3><p class="small muted">The ID card and selfie for this order will be permanently deleted.</p>
    <div class="row end gap"><button class="btn" data-close>Cancel</button><button class="btn bad" id="doDel">Delete</button></div>`);
  $("#doDel").onclick = async () => {
    try { await call("deleteKyc", { id }); closeModal(); toast("ID photos deleted"); refresh(); }
    catch (e) { toast(e.message, "err"); }
  };
}

async function viewSlip(id) {
  const o = orders.find(x => x.id === id);
  modal(`<p class="pad center">Loading slip…</p>`);
  try {
    const { url } = await call("slip", { id });
    modal(`<h3>Slip · ${esc(o.buyer_name)}</h3>
      <p class="small">Expected: <b>${money(o.price, o.currency)}</b> · ${esc(o.card_name)}</p>
      <a href="${esc(url)}" target="_blank" rel="noopener"><img class="slip" src="${esc(url)}" alt="Transfer slip" /></a>
      <div class="row end gap">
        ${o.status === "pending" || o.status === "verify_submitted" ? `<button class="btn bad" id="mReject">Reject</button><button class="btn ok" id="mApprove">Approve</button>` : ""}
        <button class="btn" data-close>Close</button></div>`);
    $("#mApprove")?.addEventListener("click", () => confirmApprove(id));
    $("#mReject")?.addEventListener("click", () => rejectDialog(id));
  } catch (e) { modal(`<p class="pad err">${esc(e.message)}</p><div class="row end"><button class="btn" data-close>Close</button></div>`); }
}

function confirmApprove(id) {
  const o = orders.find(x => x.id === id);
  modal(`<h3>Approve this order?</h3>
    <p>${esc(o.buyer_name)} · <b>${esc(o.card_name)}</b> · ${money(o.price, o.currency)}</p>
    <p class="small muted">A PIN will be taken from stock and shown to the buyer right away.</p>
    <div class="row end gap"><button class="btn" data-close>Cancel</button><button class="btn ok" id="doApprove">Approve &amp; send PIN</button></div>`);
  $("#doApprove").onclick = async e => {
    e.target.disabled = true; e.target.textContent = "Approving…";
    try { const { pin } = await call("approve", { id }); closeModal(); toast(`Approved: PIN ${pin} delivered`, "ok"); refresh(); }
    catch (err) { toast(err.message, "err"); e.target.disabled = false; e.target.textContent = "Approve & send PIN"; }
  };
}

function rejectDialog(id) {
  modal(`<h3>Reject slip</h3>
    <label>Reason shown to buyer<textarea id="rejNote" rows="3">We couldn't find this transfer in our account. Please check the amount and contact us.</textarea></label>
    <div class="row end gap"><button class="btn" data-close>Cancel</button><button class="btn bad" id="doReject">Reject</button></div>`);
  $("#doReject").onclick = async () => {
    try { await call("reject", { id, note: $("#rejNote").value }); closeModal(); toast("Order rejected"); refresh(); }
    catch (e) { toast(e.message, "err"); }
  };
}

// ---------- customers ----------
function renderCustomers() {
  const q = $("#custSearch").value.trim().toLowerCase();
  const shared = sharedIps();
  const map = new Map();
  for (const o of orders) {
    const k = custKey(o);
    const c = map.get(k) || { key: k, names: new Set(), contacts: new Set(), ips: new Map(), gps: [], devices: new Map(), orders: [], spent: 0, rejected: 0, first: Infinity, last: 0 };
    c.names.add(o.buyer_name); c.contacts.add(o.contact); c.orders.push(o);
    if (o.status === "approved") c.spent += o.price;
    if (o.status === "rejected") c.rejected++;
    if (o.ip) c.ips.set(o.ip, "server · " + place(o));
    if (o.browser_ip) c.ips.set(o.browser_ip, (c.ips.has(o.browser_ip) ? c.ips.get(o.browser_ip) + " / " : "") + "browser" + (o.isp ? ` · ${o.isp}` : ""));
    if (o.gps_status === "granted" && o.gps_lat != null) c.gps.push(o);
    if (o.device_model) c.devices.set(`${o.device_model} · ${o.os} · ${o.browser}`, o.screen || "");
    const t = new Date(o.created_at).getTime();
    c.first = Math.min(c.first, t); c.last = Math.max(c.last, t);
    map.set(k, c);
  }
  const list = [...map.values()].sort((a, b) => b.last - a.last).filter(c => !q ||
    [...c.names, ...c.contacts, ...c.ips.keys(), ...c.devices.keys()].some(v => String(v).toLowerCase().includes(q)));

  $("#custList").innerHTML = list.length ? list.map(c => {
    const sharedIp = [...c.ips.keys()].some(ip => shared.has(ip));
    const approved = c.orders.filter(o => o.status === "approved").length;
    return `<article class="order">
      <div class="order-top"><div><b>${esc([...c.names].join(" / "))}</b><br><span class="small">${esc([...c.contacts].join(", "))}</span></div>
        <div class="right small"><b>${money(c.spent, shop.currency)}</b><br><span class="muted">${c.orders.length} order${c.orders.length > 1 ? "s" : ""} · ${approved} ok · ${c.rejected} rejected</span></div></div>
      ${c.devices.size ? `<div class="small dev">${[...c.devices].map(([k, s]) => `📱 ${esc(k)}${s ? ` <span class="muted">(${esc(s)})</span>` : ""}`).join("<br>")}</div>` : ""}
      ${c.ips.size ? `<div class="small dev">${[...c.ips].map(([ip, loc]) => `🌐 <b>${esc(ip)}</b>${loc ? ` · ${esc(loc)}` : ""}${shared.has(ip) ? " <span class='flag inline'>shared</span>" : ""}`).join("<br>")}</div>` : ""}
      ${c.gps.length ? `<div class="small dev">${c.gps.slice(0, 5).map(o => `📍 ${gpsText(o)}`).join("<br>")}</div>` : ""}
      ${sharedIp || c.rejected ? `<div class="flag">⚠ ${[sharedIp ? "IP shared with another customer" : "", c.rejected ? `${c.rejected} rejected slip${c.rejected > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")}</div>` : ""}
      <div class="small muted">First seen ${new Date(c.first).toLocaleDateString()} · last ${new Date(c.last).toLocaleString()}</div>
    </article>`;
  }).join("") : `<div class="panel pad muted">No customers yet.</div>`;
}

// ---------- visitors ----------
function renderVisitors() {
  const q = $("#visSearch").value.trim().toLowerCase();
  const orderedBy = {};
  for (const o of orders) if (o.visitor_id) orderedBy[o.visitor_id] = (orderedBy[o.visitor_id] || 0) + 1;
  // group rows (one per visitor + IP) into one card per visitor
  const map = new Map();
  for (const v of visits) {
    const g = map.get(v.visitor_id) || { id: v.visitor_id, rows: [], hits: 0, first: Infinity, last: 0 };
    g.rows.push(v); g.hits += v.hits;
    g.first = Math.min(g.first, new Date(v.first_seen).getTime());
    g.last = Math.max(g.last, new Date(v.last_seen).getTime());
    map.set(v.visitor_id, g);
  }
  const all = [...map.values()].sort((a, b) => b.last - a.last);
  const dayAgo = Date.now() - 864e5;
  $("#visStats").textContent = `${all.length} visitors · ${all.filter(g => g.last > dayAgo).length} in last 24h · ${all.filter(g => orderedBy[g.id]).length} ordered`;
  const list = all.filter(g => (vfilter === "all" || (vfilter === "ordered") === !!orderedBy[g.id]) &&
    (!q || g.rows.some(v => [v.ip, v.browser_ip, v.isp, v.device_model, v.city, v.browser_city, v.os, v.browser].some(x => String(x || "").toLowerCase().includes(q)))));
  $("#visList").innerHTML = list.length ? list.slice(0, 300).map(g => {
    const v = g.rows.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen))[0];
    const n = orderedBy[g.id];
    const mismatch = g.rows.some(r => ipMismatch(r));
    return `<article class="order">
      <div class="order-top"><div>📱 <b>${esc(v.device_model || "Unknown device")}</b> · ${esc(v.os || "")} · ${esc(v.browser || "")}</div>
        <span class="tag ${n ? "approved" : "pending"}">${n ? `${n} order${n > 1 ? "s" : ""}` : "No order"}</span></div>
      <div class="small dev">${g.rows.map(r => `🖥 <b>${esc(r.ip || "?")}</b>${place(r) ? ` · ${esc(place(r))}` : ""}${r.ip_lat != null ? ` · <a href="${mapUrl(r.ip_lat, r.ip_lng)}" target="_blank" rel="noopener">map</a>` : ""}
        ${r.browser_ip ? `<br>🌐 <b>${esc(r.browser_ip)}</b>${r.isp ? ` · ${esc(r.isp)}` : ""}${r.browser_city ? ` · ${esc(r.browser_city)}` : ""}` : ""}`).join("<hr class='sep'>")}</div>
      ${mismatch ? `<div class="flag">⚠ Browser IP differs from server IP (VPN/proxy?)</div>` : ""}
      <div class="small muted">${g.hits} visit${g.hits > 1 ? "s" : ""} · first ${new Date(g.first).toLocaleString()} · last ${new Date(g.last).toLocaleString()}
        ${v.screen ? ` · ${esc(v.screen)}` : ""}${v.language ? ` · ${esc(v.language)}` : ""}${v.timezone ? ` · ${esc(v.timezone)}` : ""}
        ${v.referrer ? `<br>From: ${esc(v.referrer)}` : ""}</div>
    </article>`;
  }).join("") : `<div class="panel pad muted">No visitors yet.</div>`;
}

// ---------- stock ----------
function renderStock() {
  $("#stockList").innerHTML = cards.length ? cards.map(c => `<article class="order">
      <div class="order-top"><div><b>${esc(c.name)}</b> · ${money(c.price, shop.currency)}</div>
        <span class="tag ${c.stock > 0 ? "approved" : "rejected"}">${c.stock} PINs left</span></div>
      <label class="small">Add PINs (one per line)<textarea rows="3" data-pins="${c.id}" placeholder="XXXX-XXXX-XXXX"></textarea></label>
      <div class="row gap"><button class="btn primary" data-addpins="${c.id}">Add to stock</button></div>
    </article>`).join("") : `<div class="panel pad muted">Create a card in the Cards tab first.</div>`;
  $$("[data-addpins]").forEach(b => (b.onclick = () => addPins(b.dataset.addpins, b)));
}

async function addPins(cardId, btn) {
  const ta = $(`[data-pins="${cardId}"]`);
  const codes = ta.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!codes.length) return toast("Paste at least one PIN", "err");
  btn.disabled = true;
  try {
    const r = await call("addPins", { cardId, codes });
    ta.value = "";
    toast(`Added ${r.added} PIN${r.added === 1 ? "" : "s"}${r.duplicates ? ` (${r.duplicates} duplicate skipped)` : ""}`, "ok");
    refresh();
  } catch (e) { toast(e.message, "err"); }
  btn.disabled = false;
}

// ---------- cards ----------
function renderCards() {
  $("#cardsList").innerHTML = cards.map(c => `<article class="order row between">
      <span class="row gap"><span class="swatch" style="background:${esc(c.color || "#0f766e")}"></span>
      <span><b>${esc(c.name)}</b> ${c.value_label ? `<span class="muted">· ${esc(c.value_label)}</span>` : ""}<br><span class="small">${money(c.price, shop.currency)} · ${c.active ? "Visible" : "<span class='muted'>Hidden</span>"}</span></span></span>
      <button class="btn" data-edit="${c.id}">Edit</button></article>`).join("") || `<div class="panel pad muted">No cards yet.</div>`;
  $$("[data-edit]").forEach(b => (b.onclick = () => cardDialog(cards.find(c => c.id === b.dataset.edit))));
}
$("#newCardBtn").onclick = () => cardDialog(null);

function cardDialog(c) {
  const v = c || { name: "", value_label: "", price: "", color: CARD_COLORS[cards.length % CARD_COLORS.length], active: true, sort: cards.length, description: "" };
  modal(`<form id="cardForm"><h3>${c ? "Edit card" : "New card"}</h3>
    <label>Name<input name="name" required value="${esc(v.name)}" placeholder="PlayStation Store" /></label>
    <label>Face value / label<input name="value_label" value="${esc(v.value_label)}" placeholder="US$ 10" /></label>
    <label>Price (${esc(shop.currency)})<input name="price" type="number" step="0.01" min="0" required value="${esc(v.price)}" /></label>
    <label>Short description<input name="description" value="${esc(v.description || "")}" placeholder="US region only" /></label>
    <label>Color<div class="row gap wrapr">${CARD_COLORS.map(col => `<label class="sw"><input type="radio" name="color" value="${col}" ${col === v.color ? "checked" : ""}/><span style="background:${col}"></span></label>`).join("")}</div></label>
    <label>Sort order<input name="sort" type="number" value="${esc(v.sort ?? 0)}" /></label>
    <label class="check"><input type="checkbox" name="active" ${v.active ? "checked" : ""}/> Visible in store</label>
    <div class="row end gap"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`);
  $("#cardForm").onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const card = { id: c?.id, name: f.get("name"), value_label: f.get("value_label"), price: f.get("price"), description: f.get("description"),
      color: f.get("color"), sort: f.get("sort"), active: !!f.get("active") };
    try { await call("saveCard", { card }); closeModal(); toast("Card saved", "ok"); refresh(); }
    catch (err) { toast(err.message, "err"); }
  };
}

// ---------- settings ----------
const SETTINGS = ["name", "currency", "bank_name", "account_name", "account_number", "instructions"];
function fillSettings() {
  const f = $("#settingsForm");
  if (f.contains(document.activeElement)) return;
  for (const k of SETTINGS) f[k].value = shop[k] || "";
}
$("#settingsForm").onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { await call("saveSettings", { settings: Object.fromEntries(SETTINGS.map(k => [k, f.get(k)])) }); toast("Settings saved", "ok"); document.activeElement.blur(); refresh(); }
  catch (err) { toast(err.message, "err"); }
};

// ---------- modal ----------
function modal(html) {
  const m = $("#modal");
  $("#modalBody").innerHTML = html;
  $$("[data-close]", m).forEach(b => (b.onclick = closeModal));
  if (!m.open) m.showModal();
}
function closeModal() { $("#modal").close(); }
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });

// ---------- start ----------
if (token) enter(); else logout();
