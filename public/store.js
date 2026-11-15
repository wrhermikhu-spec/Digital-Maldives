import { $, $$, esc, money, when, toast, copy, api } from "/common.js";

let shop = { name: "Gift Card Shop", currency: "MVR" };
let cards = [];
let selected = null;
let slipDataUrl = null;
let pollTimer = null;

// ---------- device hints (IP + location are captured on the server) ----------
function visitorId() {
  try {
    let v = localStorage.getItem("gc_vid");
    if (!v) { v = (crypto.randomUUID?.() || String(Math.random()).slice(2)) ; localStorage.setItem("gc_vid", v); }
    return v;
  } catch { return ""; }
}
const devicePromise = (async () => {
  const d = {
    visitorId: visitorId(),
    screen: `${screen.width}×${screen.height} @${window.devicePixelRatio || 1}x`,
    language: navigator.language || "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    model: "",
  };
  try { // Android Chrome / Samsung Internet expose the real model, e.g. "SM-S918B"
    const h = await Promise.race([navigator.userAgentData?.getHighEntropyValues(["model"]), new Promise(r => setTimeout(r, 1500))]);
    if (h?.model) d.model = h.model;
  } catch {}
  return d;
})();

// ---------- views ----------
function show(view) {
  for (const v of ["Shop", "Checkout", "Order", "MyOrders"]) $(`#view${v}`).hidden = v !== view;
  window.scrollTo(0, 0);
}
document.addEventListener("click", e => {
  if (e.target.closest("[data-go]")?.dataset.go === "shop") { history.pushState({}, "", "/"); route(); }
});
$("#myOrdersBtn").onclick = () => { renderMyOrders(); show("MyOrders"); };
window.addEventListener("popstate", route);

// ---------- local order history ----------
const LS = "gc_orders";
const myOrders = () => { try { return JSON.parse(localStorage.getItem(LS) || "[]"); } catch { return []; } };
const rememberOrder = o => { try { localStorage.setItem(LS, JSON.stringify([o, ...myOrders()].slice(0, 50))); } catch {} };

// ---------- load ----------
async function load() {
  try {
    const data = await api("/api/catalog");
    shop = { ...shop, ...data.settings };
    cards = data.cards;
  } catch {
    $("#cards").innerHTML = `<div class="pad err">Couldn't load the store. Check your connection and refresh.</div>`;
    route();
    return;
  }
  document.title = shop.name;
  $("#shopName").textContent = shop.name;
  $("#footName").textContent = shop.name;
  renderCards();
  route();
}

function cardFace(c, big = false) {
  return `<div class="face ${big ? "big" : ""}" style="--c:${esc(c.color || "#0f766e")}">
    <span class="chip"></span>
    <span class="face-name">${esc(c.name)}</span>
    <span class="face-val">${esc(c.value_label || "")}</span>
  </div>`;
}

function renderCards() {
  if (!cards.length) { $("#cards").innerHTML = `<div class="pad muted">No cards for sale right now. Check back soon.</div>`; return; }
  $("#cards").innerHTML = cards.map(c => `<button class="tile" data-card="${esc(c.id)}" ${c.in_stock ? "" : "disabled"}>
      ${cardFace(c)}
      <div class="tile-row"><span class="price">${money(c.price, shop.currency)}</span>
      <span class="tag ${c.in_stock ? "in" : "out"}">${c.in_stock ? "In stock" : "Sold out"}</span></div>
    </button>`).join("");
  $$("#cards .tile").forEach(t => (t.onclick = () => openCheckout(t.dataset.card)));
}

// ---------- checkout ----------
function openCheckout(id) {
  selected = cards.find(c => c.id === id);
  if (!selected) return;
  slipDataUrl = null;
  $("#coForm").reset();
  $("#slipPreview").hidden = true;
  resetDrop();
  $("#coCard").innerHTML = `${cardFace(selected, true)}
    <div class="co-sum"><div><div class="muted">You pay</div><div class="price big">${money(selected.price, shop.currency)}</div></div>
    ${selected.description ? `<p class="muted">${esc(selected.description)}</p>` : ""}</div>`;
  const rows = [["Bank", shop.bank_name], ["Account name", shop.account_name], ["Account number", shop.account_number], ["Amount", money(selected.price, shop.currency)]]
    .filter(r => r[1]);
  $("#bankBox").innerHTML = rows.map(([k, v]) => `<div class="bank-row"><span>${esc(k)}</span><b>${esc(v)}</b>
      <button type="button" class="mini" data-copy="${esc(k === "Amount" ? selected.price : v)}">Copy</button></div>`).join("")
    + (shop.instructions ? `<p class="muted small">${esc(shop.instructions)}</p>` : "")
    + (rows.length <= 1 ? `<p class="err small">Bank details haven't been set up yet.</p>` : "");
  $$("#bankBox [data-copy]").forEach(b => (b.onclick = () => copy(b.dataset.copy)));
  show("Checkout");
}

function resetDrop() {
  $("#dropText").hidden = false;
  $("#dropText").innerHTML = "<b>Tap to choose a screenshot</b><br><small>JPG or PNG of the bank app receipt</small>";
}

$("#slipInput").onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (!f.type.startsWith("image/")) { toast("Please choose an image (screenshot of the slip)", "err"); return; }
  try {
    $("#dropText").innerHTML = "<b>Processing…</b>";
    slipDataUrl = await compressImage(f);
    $("#slipPreview").src = slipDataUrl;
    $("#slipPreview").hidden = false;
    $("#dropText").hidden = true;
  } catch (err) {
    slipDataUrl = null;
    resetDrop();
    toast(err.message || "Couldn't read that image", "err");
  }
};

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const s = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      let q = 0.85, out = c.toDataURL("image/jpeg", q);
      while (out.length > 1_400_000 && q > 0.4) { q -= 0.1; out = c.toDataURL("image/jpeg", q); }
      if (out.length > 3_000_000) return reject(new Error("Image is too large — try a cropped screenshot"));
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Unsupported image. Take a screenshot (PNG/JPG) instead.")); };
    img.src = url;
  });
}

$("#coForm").onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const buyerName = String(f.get("buyerName") || "").trim();
  const contact = String(f.get("contact") || "").trim();
  if (!buyerName || !contact) return toast("Please fill in your name and contact", "err");
  if (!slipDataUrl) return toast("Please upload your transfer slip", "err");

  const btn = $("#coSubmit");
  btn.disabled = true; btn.textContent = "Submitting…";
  try {
    const { id } = await api("/api/orders", {
      method: "POST",
      body: { cardId: selected.id, buyerName, contact, slip: slipDataUrl, device: await devicePromise },
    });
    rememberOrder({ id, cardName: selected.name, price: selected.price, currency: shop.currency, at: Date.now() });
    history.pushState({}, "", `/?order=${id}`);
    route();
  } catch (err) {
    toast(err.message || "Couldn't submit. Check your connection and try again.", "err");
  } finally {
    btn.disabled = false; btn.textContent = "Submit slip";
  }
};

// ---------- order status ----------
function route() {
  clearTimeout(pollTimer);
  const id = new URLSearchParams(location.search).get("order");
  if (id) return openOrder(id);
  show("Shop");
}

async function openOrder(id) {
  const el = $("#viewOrder");
  el.innerHTML = `<div class="panel center pad">Loading order…</div>`;
  show("Order");
  let failures = 0;
  const tick = async () => {
    try {
      const o = await api(`/api/order?id=${encodeURIComponent(id)}`);
      failures = 0;
      renderOrder(id, o);
      if (o.status === "pending") pollTimer = setTimeout(tick, document.hidden ? 15000 : 5000);
    } catch (err) {
      if (err.status === 404) {
        el.innerHTML = `<button class="back" data-go="shop">← All cards</button><div class="panel center pad">Order not found.</div>`;
        return;
      }
      failures++;
      if (failures === 2 && !$("#viewOrder .panel h2")) el.innerHTML = `<div class="panel center pad">Still connecting… check your internet.</div>`;
      pollTimer = setTimeout(tick, 8000);
    }
  };
  tick();
}

function renderOrder(id, o) {
  const link = `${location.origin}/?order=${id}`;
  let body;
  if (o.status === "approved") {
    body = `<div class="status ok">✓ Payment verified</div>
      <p class="muted">Here is your ${esc(o.card_name)} PIN:</p>
      <div class="pin">${esc(o.pin)}</div>
      <button class="btn primary" id="copyPin">Copy PIN</button>
      <p class="muted small">Keep this PIN private. Anyone with this page's link can see it.</p>`;
  } else if (o.status === "rejected") {
    body = `<div class="status bad">✕ Slip not accepted</div>
      <p>${esc(o.note || "We couldn't verify this payment.")}</p>
      <p class="muted small">If you think this is a mistake, contact us with order ID <b>${esc(id.slice(0, 8).toUpperCase())}</b>.</p>`;
  } else {
    body = `<div class="status wait"><span class="spin"></span> Verifying your slip…</div>
      <p class="muted">We're checking your transfer. This page updates on its own, and your PIN will appear right here. You can close it and come back any time.</p>`;
  }
  $("#viewOrder").innerHTML = `<button class="back" data-go="shop">← All cards</button>
    <div class="panel center">
      <div class="muted small">Order ${esc(id.slice(0, 8).toUpperCase())} · ${when(o.created_at)}</div>
      <h2>${esc(o.card_name)} · ${money(o.price, o.currency)}</h2>
      ${body}
      <div class="savebox"><span class="small muted">Save this link to view your order later:</span>
        <div class="row gap"><input readonly value="${esc(link)}" onclick="this.select()" /><button class="btn" id="copyLink">Copy</button></div></div>
    </div>`;
  $("#copyLink").onclick = () => copy(link);
  const cp = $("#copyPin"); if (cp) cp.onclick = () => copy(o.pin);
}

function renderMyOrders() {
  const list = myOrders();
  $("#myOrdersList").innerHTML = list.length
    ? list.map(o => `<a class="orow" href="/?order=${esc(o.id)}"><span><b>${esc(o.cardName)}</b><br><small class="muted">${new Date(o.at).toLocaleString()}</small></span><span>${money(o.price, o.currency)} →</span></a>`).join("")
    : `<div class="panel pad muted">No orders from this browser yet.</div>`;
}

load();
