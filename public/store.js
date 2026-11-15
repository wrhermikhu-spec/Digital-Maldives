import { $, $$, esc, money, when, toast, copy, api } from "/common.js";

let shop = { name: "Gift Card Shop", currency: "MVR" };
let cards = [];
let selected = null;
let slipDataUrl = null;
let idDataUrl = null;
let startToken = null;
let pollTimer = null;

// ---------- device + location (server also records its own IP/location) ----------
const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);

function visitorId() {
  try {
    let v = localStorage.getItem("gc_vid");
    if (!v) { v = crypto.randomUUID?.() || String(Math.random()).slice(2); localStorage.setItem("gc_vid", v); }
    return v;
  } catch { return ""; }
}

// Browser-side IP lookup: IP + ISP + city as seen from the buyer's connection.
const netPromise = (async () => {
  try {
    const r = await withTimeout(fetch("https://ipapi.co/json/"), 5000, null);
    if (r?.ok) {
      const j = await r.json();
      if (j.ip) return { browserIp: j.ip, browserCity: j.city || "", browserRegion: j.region || "", browserCountry: j.country_name || "", isp: j.org || "" };
    }
  } catch {}
  try {
    const r = await withTimeout(fetch("https://api.ipify.org?format=json"), 5000, null);
    if (r?.ok) return { browserIp: (await r.json()).ip || "", browserCity: "", browserRegion: "", browserCountry: "", isp: "" };
  } catch {}
  return { browserIp: "", browserCity: "", browserRegion: "", browserCountry: "", isp: "" };
})();

const hintsPromise = (async () => {
  const d = {
    visitorId: visitorId(),
    screen: `${screen.width}×${screen.height} @${window.devicePixelRatio || 1}x`,
    language: navigator.language || "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    model: "",
  };
  try { // Android Chrome / Samsung Internet expose the real model, e.g. "SM-S918B"
    const h = await withTimeout(navigator.userAgentData?.getHighEntropyValues(["model"]), 1500, null);
    if (h?.model) d.model = h.model;
  } catch {}
  return d;
})();

// GPS: read silently ONLY if this site already has location permission. Never prompts.
let gps = { status: "not_granted" };
let gpsPromise = null;
function readLocationIfAllowed() {
  if (gpsPromise) return gpsPromise;
  gpsPromise = (async () => {
    try {
      if (!navigator.geolocation || !navigator.permissions?.query) return gps;
      const perm = await navigator.permissions.query({ name: "geolocation" });
      if (perm.state !== "granted") return gps; // "prompt" or "denied" → don't ask
      return await new Promise(resolve => {
        navigator.geolocation.getCurrentPosition(
          p => { gps = { status: "granted", lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }; resolve(gps); },
          e => { gps = { status: e.code === 3 ? "timeout" : "unavailable" }; resolve(gps); },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
        );
      });
    } catch { return gps; }
  })();
  return gpsPromise;
}

// Log this visit (fire-and-forget; never blocks the page)
(async () => {
  try {
    const [hints, net] = await Promise.all([hintsPromise, withTimeout(netPromise, 4000, {})]);
    fetch("/api/visit", {
      method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...hints, ...net, path: location.pathname + location.search, referrer: document.referrer || "" }),
    }).catch(() => {});
  } catch {}
})();

async function collectDevice() {
  const [hints, net] = await Promise.all([hintsPromise, withTimeout(netPromise, 4000, {})]);
  const loc = await withTimeout(readLocationIfAllowed(), 8000, gps);
  return { ...hints, ...net, gps: loc };
}

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
  slipDataUrl = null; idDataUrl = null; startToken = null;
  $("#coForm").reset();
  $("#idPreview").hidden = true; $("#idText").hidden = false;
  const canInstant = shop.instant && selected.price <= shop.instant_max_price;
  $("#modeBox").hidden = !canInstant;
  updateMode();
  if (canInstant) api("/api/orders").then(r => (startToken = r.start)).catch(() => {});
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
  readLocationIfAllowed();
}

function mode() { return $("#coForm").querySelector("input[name=mode]:checked")?.value || "standard"; }
function updateMode() {
  const inst = mode() === "instant" && !$("#modeBox").hidden;
  $("#idBox").hidden = !inst;
  $("#instantRules").hidden = !inst;
  $("#coSubmit").textContent = inst ? "Submit & get PIN" : "Submit slip";
}
$$("#coForm input[name=mode]").forEach(r => (r.onchange = updateMode));

$("#idInput").onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (!f.type.startsWith("image/")) return toast("Please choose a photo of your ID", "err");
  try {
    $("#idText").innerHTML = "<b>Processing…</b>";
    idDataUrl = await compressImage(f, 1_000_000);
    $("#idPreview").src = idDataUrl; $("#idPreview").hidden = false; $("#idText").hidden = true;
  } catch (err) {
    idDataUrl = null; $("#idText").hidden = false;
    $("#idText").innerHTML = "<b>Tap to add a photo of your ID card</b><br><small>Front side, name clearly readable</small>";
    toast(err.message, "err");
  }
};

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
    slipDataUrl = await compressImage(f, 1_000_000); // free OCR limit is 1 MB
    $("#slipPreview").src = slipDataUrl;
    $("#slipPreview").hidden = false;
    $("#dropText").hidden = true;
  } catch (err) {
    slipDataUrl = null;
    resetDrop();
    toast(err.message || "Couldn't read that image", "err");
  }
};

function compressImage(file, maxChars = 1_400_000) {
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
      while (out.length > maxChars && q > 0.4) { q -= 0.1; out = c.toDataURL("image/jpeg", q); }
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
  const inst = mode() === "instant" && !$("#modeBox").hidden;
  if (inst && !idDataUrl) return toast("Please add a photo of your ID card", "err");
  if (inst && !startToken) { try { startToken = (await api("/api/orders")).start; } catch {} }

  const btn = $("#coSubmit");
  btn.disabled = true; btn.textContent = inst ? "Checking your slip… (up to a minute)" : "Submitting…";
  try {
    const r = await api("/api/orders", {
      method: "POST",
      body: { cardId: selected.id, buyerName, contact, slip: slipDataUrl, device: await collectDevice(),
              ...(inst ? { mode: "instant", idImage: idDataUrl, start: startToken } : {}) },
    });
    const id = r.id;
    if (r.instant === "manual") toast("We couldn't verify it instantly, so we'll check it manually.", "");
    rememberOrder({ id, cardName: selected.name, price: selected.price, currency: shop.currency, at: Date.now() });
    history.pushState({}, "", `/?order=${id}`);
    route();
  } catch (err) {
    toast(err.message || "Couldn't submit. Check your connection and try again.", "err");
  } finally {
    btn.disabled = false; updateMode();
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
      if (o.status === "pending" || o.status === "verify_submitted") pollTimer = setTimeout(tick, document.hidden ? 15000 : 5000);
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
  } else if (o.status === "verify_required") {
    body = `<div class="status bad">Identity check needed</div>
      <p>${esc(o.verify_note || "We need to confirm your identity before we can deliver this order.")}</p>
      <div class="verify">
        <label class="drop small-drop" data-kind="id">
          <input type="file" accept="image/*" hidden />
          <span class="dt"><b>1. Photo of your ID card</b><br><small>Front side, all text clearly readable</small></span>
          <img alt="" hidden />
        </label>
        <label class="drop small-drop" data-kind="selfie">
          <input type="file" accept="image/*" capture="user" hidden />
          <span class="dt"><b>2. Selfie holding your ID card</b><br><small>Your face and the card both visible</small></span>
          <img alt="" hidden />
        </label>
        <button type="button" class="btn" id="shareLoc">📍 Share my location <small class="muted">(optional, helps us verify you faster)</small></button>
        <button class="btn primary big" id="verifySubmit">Submit for review</button>
        <p class="muted small">Your ID photos are only used to verify this order, are seen only by our staff, and are deleted after review. See our <a href="/privacy">Privacy Policy</a>.</p>
      </div>`;
  } else if (o.status === "verify_submitted") {
    body = `<div class="status wait"><span class="spin"></span> Reviewing your ID…</div>
      <p class="muted">Thanks! We're checking your documents. This page updates on its own, and your PIN will appear here once you're verified.</p>`;
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
  if (o.status === "verify_required") wireVerify(id);
}

function wireVerify(orderId) {
  const imgs = {};
  let vgps = null;
  $("#shareLoc").onclick = e => {
    const btn = e.currentTarget;
    if (!navigator.geolocation) return toast("Location isn't available on this device", "err");
    btn.disabled = true; btn.textContent = "Getting location…";
    navigator.geolocation.getCurrentPosition(
      p => { vgps = { status: "granted", lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }; btn.textContent = "✓ Location shared"; },
      err => { vgps = { status: err.code === 1 ? "declined" : "unavailable" }; btn.disabled = false; btn.innerHTML = "📍 Share my location <small class='muted'>(optional)</small>"; toast(err.code === 1 ? "Location not shared" : "Couldn't get location", "err"); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };
  $$(".verify .drop").forEach(d => {
    const input = d.querySelector("input"), img = d.querySelector("img"), dt = d.querySelector(".dt"), label = dt.innerHTML;
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      if (!f.type.startsWith("image/")) return toast("Please choose a photo", "err");
      try {
        dt.innerHTML = "<b>Processing…</b>";
        imgs[d.dataset.kind] = await compressImage(f, 1_300_000);
        img.src = imgs[d.dataset.kind]; img.hidden = false; dt.hidden = true;
      } catch (err) { delete imgs[d.dataset.kind]; dt.hidden = false; dt.innerHTML = label; toast(err.message, "err"); }
    };
  });
  $("#verifySubmit").onclick = async e => {
    if (!imgs.id) return toast("Please add a photo of your ID card", "err");
    if (!imgs.selfie) return toast("Please add a selfie holding your ID", "err");
    const btn = e.target;
    btn.disabled = true; btn.textContent = "Uploading…";
    try {
      await api("/api/verify", { method: "POST", body: { orderId, idImage: imgs.id, selfieImage: imgs.selfie, gps: vgps || { status: "not_shared" } } });
      toast("Submitted for review", "ok");
      route();
    } catch (err) { toast(err.message, "err"); btn.disabled = false; btn.textContent = "Submit for review"; }
  };
}

function renderMyOrders() {
  const list = myOrders();
  $("#myOrdersList").innerHTML = list.length
    ? list.map(o => `<a class="orow" href="/?order=${esc(o.id)}"><span><b>${esc(o.cardName)}</b><br><small class="muted">${new Date(o.at).toLocaleString()}</small></span><span>${money(o.price, o.currency)} →</span></a>`).join("")
    : `<div class="panel pad muted">No orders from this browser yet.</div>`;
}

load();
