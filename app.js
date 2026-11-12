/* Kedai Manis – simple order manager for home bakers.
   All data lives in this device's localStorage. Use Settings → Export to back up. */
(() => {
  "use strict";

  // A demo build (window.APP_DEMO) runs on example data kept in each visitor's own browser.
  const DEMO = !!window.APP_DEMO;
  const STORE_KEY = DEMO ? "order-app-demo-v1" : "kedai-manis-v1";
  const hasClaudeApi = () => !DEMO && !!(window.claude && typeof window.claude.use === "function");
  const STATUSES = ["New", "Making", "Ready", "Posted", "Completed", "Cancelled"];
  const ACTIVE = ["New", "Making", "Ready"];
  const PAY_METHODS = ["DuitNow QR", "Bank Transfer", "Cash (pickup)"];
  const PAY_STATUS = ["Unpaid", "Paid", "Refunded"];
  // Delivery as on the website: postage is charged per lamp; pickup in Taman Sentosa, Klang is free.
  const DELIVERY = ["Semenanjung", "Sabah / Sarawak", "Self pickup"];
  const postFee = (d) => d === "Semenanjung" ? Number(db.settings.postSM ?? 10) : d === "Sabah / Sarawak" ? Number(db.settings.postSS ?? 45) : 0;
  const EXP_CATS = ["Materials", "Packaging", "Postage", "Equipment", "Other"];

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rm = (n) => "RM" + (Number(n) || 0).toFixed(2);
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const todayStr = () => ymd(new Date());
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const prettyDate = (s) => { if (!s) return "-"; const d = parseYmd(s); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
  const relDate = (s) => {
    const diff = Math.round((parseYmd(s) - parseYmd(todayStr())) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff === -1) return "Yesterday";
    if (diff < 0) return `${-diff} days late`;
    const d = parseYmd(s);
    return `${DOW[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  };
  const ADDON_RE = /paper bag|^box|wish card|add-on/i;
  const isAddon = (it) => {
    if (it.productId === "receipt-only") return true;
    const p = db.products.find((x) => x.id === it.productId) || db.products.find((x) => x.name === it.name);
    return p ? p.category === "Add-on" : ADDON_RE.test(it.name || "");
  };
  const productOf = (it) => db.products.find((x) => x.id === it.productId) || db.products.find((x) => x.name === it.name);
  const thumb = (it, cls = "thumb") => {
    const pr = it && (it.img ? it : productOf(it));
    return pr && pr.img ? `<img class="${cls}" src="${esc(pr.img)}" alt="" loading="lazy" />` : `<span class="${cls} thumb-empty"><span class="bloom"></span></span>`;
  };
  const lampThumbs = (o) => {
    const lamps = o.items.filter((i) => !isAddon(i));
    return lamps.length ? `<div class="thumbs">${lamps.slice(0, 4).map((i) => thumb(i)).join("")}${lamps.length > 4 ? `<span class="more">+${lamps.length - 4}</span>` : ""}</div>` : "";
  };
  // Shrink a picked photo so it stays small in the database.
  const shrinkPhoto = (file, size = 240, whole = false, quality = 0.8) => new Promise((ok, fail) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, size / (whole ? Math.max(img.width, img.height) : Math.min(img.width, img.height)));
      const w = Math.round(img.width * k), h = Math.round(img.height * k);
      const c = document.createElement("canvas");
      c.width = whole ? w : Math.min(w, size); c.height = whole ? h : Math.min(h, size);
      c.getContext("2d").drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
      URL.revokeObjectURL(url);
      ok(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); fail(); };
    img.src = url;
  });
  const itemsTotal = (o) => o.items.reduce((t, i) => t + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
  const orderTotal = (o) => itemsTotal(o) + (Number(o.postage) || 0);
  const lampCount = (o) => o.items.filter((i) => !isAddon(i)).reduce((t, i) => t + (Number(i.qty) || 0), 0);
  const itemCount = lampCount;
  const waLink = (phone, text) => {
    let p = String(phone || "").replace(/\D/g, "");
    if (!p) return null;
    if (p.startsWith("0")) p = "6" + p; // Malaysian numbers: 01x… → 601x…
    return `https://wa.me/${p}` + (text ? `?text=${encodeURIComponent(text)}` : "");
  };

  // ---------- data ----------
  function seed() {
    const t = new Date();
    const d = (n) => ymd(addDays(t, n));
    const products = [
      { id: "p-rose", name: "Rose Lamp", price: 45, category: "USB + LED" },
      { id: "p-daisy", name: "Daisy Lamp", price: 39, category: "LED" },
      { id: "p-tulip", name: "Tulip Lamp", price: 55, category: "USB + LED" },
      { id: "p-sunflower", name: "Sunflower Lamp", price: 49, category: "USB + LED" },
      { id: "p-lily-big", name: "Lily Garden (Big)", price: 79, category: "LED · Big size" },
      { id: "p-bag", name: "Window paper bag", price: 3, category: "Add-on" },
      { id: "p-box", name: "Gift box", price: 12, category: "Add-on" },
      { id: "p-card", name: "Wish card", price: 2, category: "Add-on" },
    ];
    const P = Object.fromEntries(products.map((x) => [x.id, x]));
    const it = (id, qty) => ({ productId: id, name: P[id].name, price: P[id].price, qty });
    let no = 1000;
    const mk = (customer, phone, date, items, status, payStatus, delivery, extra = {}) => {
      const lamps = items.filter((i) => P[i.productId].category !== "Add-on").reduce((a, i) => a + i.qty, 0);
      return { id: uid(), code: `DEMO-${++no}`, customer, phone, date, items, status, payMethod: delivery === "Self pickup" && payStatus === "Paid" && no % 3 === 0 ? "Cash (pickup)" : "DuitNow QR", payStatus,
        delivery, postage: delivery === "Semenanjung" ? 10 * lamps : delivery === "Sabah / Sarawak" ? 45 * lamps : 0,
        address: delivery === "Self pickup" ? "" : extra.address || "No 12, Jalan Contoh 3, 40000 Shah Alam", wish: extra.wish || "", tracking: extra.tracking || "", notes: "Example order", createdAt: Date.now() };
    };
    const orders = [
      mk("Contoh: Alya", "012-000 1101", d(-24), [it("p-rose", 2), it("p-card", 1)], "Completed", "Paid", "Semenanjung", { tracking: "630000000101", wish: "Happy anniversary!" }),
      mk("Contoh: Balqis", "012-000 1102", d(-20), [it("p-daisy", 1), it("p-bag", 1)], "Completed", "Paid", "Self pickup"),
      mk("Contoh: Camelia", "012-000 1103", d(-16), [it("p-lily-big", 1)], "Completed", "Paid", "Sabah / Sarawak", { address: "Lot 8, Taman Contoh, 88000 Kota Kinabalu", tracking: "630000000103" }),
      mk("Contoh: Alya", "012-000 1101", d(-12), [it("p-tulip", 1), it("p-box", 1)], "Completed", "Paid", "Self pickup"),
      mk("Contoh: Dahlia", "012-000 1104", d(-8), [it("p-sunflower", 2)], "Completed", "Paid", "Semenanjung", { tracking: "630000000105" }),
      mk("Contoh: Erina", "012-000 1105", d(-5), [it("p-rose", 1), it("p-daisy", 1)], "Posted", "Paid", "Semenanjung", { tracking: "630000000106" }),
      mk("Contoh: Farhana", "012-000 1106", d(-1), [it("p-tulip", 2), it("p-card", 2)], "Ready", "Paid", "Semenanjung", { wish: "Selamat hari jadi, Ibu 🤍" }),
      mk("Contoh: Ghazal", "012-000 1107", d(0), [it("p-daisy", 2), it("p-bag", 2)], "Ready", "Paid", "Self pickup"),
      mk("Contoh: Hani", "012-000 1108", d(1), [it("p-lily-big", 1), it("p-card", 1)], "Making", "Paid", "Semenanjung"),
      mk("Contoh: Iman", "012-000 1109", d(3), [it("p-rose", 3)], "New", "Unpaid", "Semenanjung"),
      mk("Contoh: Balqis", "012-000 1102", d(6), [it("p-sunflower", 1), it("p-bag", 1)], "New", "Unpaid", "Self pickup"),
      mk("Contoh: Jasmin", "012-000 1110", d(9), [it("p-tulip", 1)], "New", "Unpaid", "Sabah / Sarawak", { address: "No 3, Jalan Contoh, 93000 Kuching" }),
    ];
    return {
      settings: { business: DEMO ? "Kedai Bunga Demo" : "My Flower Shop", owner: "Sis", prefix: "DEMO-", nextNo: no + 1, ordersSheet: "", productsSheet: "", postSM: 10, postSS: 45, wall: "bloom" },
      products,
      inventory: [
        { id: uid(), name: "Pipe cleaner (pink)", qty: 2, unit: "pack", min: 5 },
        { id: uid(), name: "LED fairy light", qty: 1, unit: "set", min: 3 },
        { id: uid(), name: "Flower pot (small)", qty: 12, unit: "pcs", min: 5 },
        { id: uid(), name: "Window paper bag", qty: 40, unit: "pcs", min: 20 },
        { id: uid(), name: "Gift box", qty: 6, unit: "pcs", min: 4 },
      ],
      expenses: [
        { id: uid(), date: d(-26), desc: "Pipe cleaner & LED (Shopee)", category: "Materials", amount: 210 },
        { id: uid(), date: d(-14), desc: "Box & ribbon", category: "Packaging", amount: 85 },
        { id: uid(), date: d(-6), desc: "J&T postage", category: "Postage", amount: 60 },
        { id: uid(), date: d(-2), desc: "Glue gun refill", category: "Equipment", amount: 25 },
      ],
      orders,
    };
  }

  const COLS = ["orders", "products", "inventory", "expenses"];
  const emptyDb = () => ({ settings: { business: "My Shop", owner: "", prefix: "PN-", nextNo: 1001, ordersSheet: "", productsSheet: "", postSM: 10, postSS: 45 }, products: [], inventory: [], expenses: [], orders: [] });
  let db = emptyDb();
  let cloud = null;            // claude db namespace when running as a published artifact
  let synced = null;           // last written JSON per doc, to send only changes
  let loading = true;
  let writeChain = Promise.resolve();

  const readLocal = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; } };
  const writeLocal = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch { /* storage blocked */ } };

  function snapshotDocs() {
    const m = new Map();
    m.set("meta/settings", JSON.stringify(db.settings));
    COLS.forEach((c) => db[c].forEach((x) => m.set(`${c}/${x.id}`, JSON.stringify(x))));
    return m;
  }
  function save() {
    if (!cloud) { writeLocal(); return; }
    const next = snapshotDocs();
    const prev = synced;
    synced = next;
    writeChain = writeChain.then(async () => {
      try {
        for (const [path, json] of next) if (prev.get(path) !== json) await cloud.doc(path).set(JSON.parse(json));
        for (const path of prev.keys()) if (!next.has(path)) await cloud.doc(path).delete();
      } catch (e) {
        toast(e && e.code === "quota_exceeded" ? "Storage is full. Delete old orders, then try again." : "Not saved. Check your connection and try again.");
      }
    });
  }
  async function loadCloud() {
    const [meta, ...lists] = await Promise.all([
      cloud.doc("meta/settings").get(),
      ...COLS.map((c) => cloud.collection(c).limit(1000).get()),
    ]);
    const d = emptyDb();
    if (meta.exists) d.settings = { ...d.settings, ...meta.data() };
    COLS.forEach((c, i) => { d[c] = lists[i].docs.map((doc) => JSON.parse(JSON.stringify(doc.data()))); });
    db = d;
    synced = snapshotDocs();
  }
  async function boot() {
    if (DEMO) {
      const local = readLocal();
      db = local && Array.isArray(local.orders) ? local : seed();
      writeLocal();
      loading = false;
      document.body.classList.add("is-demo");
      route();
      return;
    }
    const hasClaude = hasClaudeApi();
    if (hasClaude) {
      try {
        const ns = await Promise.race([window.claude.use("db"), new Promise((r) => setTimeout(() => r(null), 10000))]);
        if (ns) { cloud = ns; await loadCloud(); }
      } catch { cloud = null; }
      if (!cloud) toast("Sign in to sync. Saving on this device only.");
    }
    if (!cloud) {
      const local = readLocal();
      db = local && Array.isArray(local.orders) ? local : hasClaude ? emptyDb() : seed();
      writeLocal();
    }
    if (!Array.isArray(db.settings.webSeen)) db.settings.webSeen = db.orders.map((o) => o.webId).filter(Boolean);
    db.orders.forEach((o) => {
      if (o.status === "Baking") o.status = "Making";
      // Orders saved before delivery became its own field kept postage as a line item.
      const post = (o.items || []).filter((i) => /^postage/i.test(i.name || ""));
      if (post.length && !o.postage) {
        o.postage = post.reduce((t, i) => t + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
        o.items = o.items.filter((i) => !/^postage/i.test(i.name || ""));
        if (!o.delivery) o.delivery = /sabah|sarawak/i.test(post[0].name) ? "Sabah / Sarawak" : "Semenanjung";
      }
      if (!o.delivery && /self pickup/i.test(o.notes || "")) o.delivery = "Self pickup";
      if (o.payMethod === "QR / DuitNow") o.payMethod = "DuitNow QR";
    });
    loading = false;
    route();
    if (hasClaudeApi()) {
      pullWebOrders(null, true);
      setInterval(() => { if (document.visibilityState === "visible") pullWebOrders(null, true); }, 120000);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pullWebOrders(null, true); });
    }
  }

  // ---------- ui shell ----------
  const view = $("#view");
  const ui = { orderFilter: "All", orderSearch: "", calMonth: null, calSel: todayStr() };

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 1800);
  }

  const drawer = $("#drawer"), scrim = $("#scrim");
  const setDrawer = (open) => { drawer.classList.toggle("open", open); scrim.classList.toggle("open", open); };
  $("#menuBtn").onclick = () => setDrawer(true);
  scrim.onclick = () => setDrawer(false);
  drawer.addEventListener("click", (e) => { if (e.target.closest("a")) setDrawer(false); });

  function openModal(title, html, onMount) {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = html;
    $("#modalWrap").hidden = false;
    document.body.style.overflow = "hidden";
    onMount && onMount($("#modalBody"));
  }
  function closeModal() { $("#modalWrap").hidden = true; document.body.style.overflow = ""; }
  $("#modalClose").onclick = closeModal;
  $("#modalWrap").addEventListener("click", (e) => { if (e.target.id === "modalWrap") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); setDrawer(false); } });

  // In-page confirmation (native confirm() is blocked inside the Claude viewer).
  function ask(message, yesLabel, onYes) {
    openModal("Are you sure?", `<p style="margin:0 0 18px;font-weight:700">${esc(message)}</p>
      <div class="form-actions"><button type="button" class="btn" id="askNo">Cancel</button><button type="button" class="btn danger" id="askYes">${esc(yesLabel)}</button></div>`, (root) => {
      $("#askNo", root).onclick = closeModal;
      $("#askYes", root).onclick = () => { closeModal(); onYes(); };
    });
  }

  const opts = (list, sel) => (sel && !list.includes(sel) ? [sel, ...list] : list).map((v) => `<option ${v === sel ? "selected" : ""}>${esc(v)}</option>`).join("");
  const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;

  function refreshBrand() {
    $("#brandName").textContent = db.settings.business;
    $("#drawerBrand").textContent = db.settings.business;
    $("#drawerOwner").textContent = db.settings.owner ? `Hi, ${db.settings.owner}` : "";
    document.title = db.settings.business;
    applyWall();
  }

  // ---------- wallpaper ----------
  const WALLS = [["bloom", "🌸 Flowers"], ["sparkle", "✧ Sparkle"], ["gingham", "🧺 Gingham"], ["plain", "Plain"], ["photo", "🖼️ My photo"]];
  function applyWall() {
    const w = db.settings.wall || "bloom";
    const photo = w === "photo" && db.settings.wallImg;
    document.body.dataset.wall = photo ? "photo" : w === "photo" ? "bloom" : w;
    if (photo) document.body.style.setProperty("--wall-img", `url("${db.settings.wallImg}")`);
    else document.body.style.removeProperty("--wall-img");
  }

  // ---------- router ----------
  const pages = { dashboard, orders, calendar, report, customers, products, inventory, expenses, shop: settings };
  function route() {
    const page = (location.hash.slice(1) || "dashboard").split("?")[0];
    const fn = pages[page] || dashboard;
    $$(".drawer a").forEach((a) => a.classList.toggle("active", a.dataset.page === (pages[page] ? page : "dashboard")));
    refreshBrand();
    if (loading) { view.innerHTML = `<div class="empty" style="padding-top:80px">Loading your orders…</div>`; return; }
    fn();
    window.scrollTo(0, 0);
  }
  const rerender = () => { const y = window.scrollY; const page = (location.hash.slice(1) || "dashboard"); (pages[page] || dashboard)(); window.scrollTo(0, y); };
  window.addEventListener("hashchange", route);

  // ---------- dashboard ----------
  function dashboard() {
    const now = new Date();
    const monthKey = ymd(now).slice(0, 7);
    const valid = db.orders.filter((o) => o.status !== "Cancelled");
    const monthSales = valid.filter((o) => o.date.slice(0, 7) === monthKey).reduce((t, o) => t + orderTotal(o), 0);
    const active = db.orders.filter((o) => ACTIVE.includes(o.status));
    const low = db.inventory.filter((i) => Number(i.qty) <= Number(i.min));
    const monthExp = db.expenses.filter((e) => e.date.slice(0, 7) === monthKey);
    const expTotal = monthExp.reduce((t, e) => t + Number(e.amount || 0), 0);
    const today = todayStr();
    const dueToday = active.filter((o) => o.date === today).length;
    const reminders = [...active].sort((a, b) => a.date.localeCompare(b.date));

    // last 7 days chart
    const days = [...Array(7)].map((_, i) => ymd(addDays(now, i - 6)));
    const sales = days.map((d) => valid.filter((o) => o.date === d).reduce((t, o) => t + orderTotal(o), 0));
    const exps = days.map((d) => db.expenses.filter((e) => e.date === d).reduce((t, e) => t + Number(e.amount || 0), 0));

    const starter = !db.products.length && !db.orders.length ? `<section class="card" style="margin-bottom:16px"><h3>Welcome! Start here</h3>
        <p class="muted">1. Add your menu in <a href="#products">Products</a>. 2. Add orders in <a href="#orders">Orders</a>. 3. Set your shop name in <a href="#shop">Settings</a>.</p></section>` : "";
    view.innerHTML = starter + `
      <div class="page-head"><div><h1>Dashboard</h1><p>Welcome back${db.settings.owner ? ", " + esc(db.settings.owner) : ""} 👋</p></div></div>
      <div class="stats">
        <div class="stat" style="--c:var(--pink)"><div class="label">Sales · ${MONTHS[now.getMonth()]}</div><div class="value">${rm(monthSales)}</div><div class="sub">Profit ${rm(monthStats(monthKey).profit)}</div></div>
        <div class="stat" style="--c:var(--yellow)"><div class="label">Active orders</div><div class="value">${active.length}</div><div class="sub">${dueToday} due today</div></div>
        <div class="stat" style="--c:var(--red)"><div class="label">Low stock</div><div class="value">${low.length}</div><div class="sub ${low.length ? "warn" : ""}">${low.length ? low.length + " to restock" : "All good"}</div></div>
        <div class="stat" style="--c:var(--green)"><div class="label">Expenses · ${MONTHS[now.getMonth()]}</div><div class="value">${rm(expTotal)}</div><div class="sub">${monthExp.length} records</div></div>
      </div>

      <section class="card">
        <div class="row-between"><h3>💐 Order Reminders</h3><span class="badge">${reminders.length}</span></div>
        ${reminders.length ? `<div class="hscroll">${reminders.map((o) => `
          <button class="remind" data-order="${o.id}">
            <div class="d" ${o.date < today ? 'style="color:var(--red)"' : ""}>${esc(relDate(o.date))}</div>
            ${lampThumbs(o)}
            <div class="n">${esc(o.customer)}</div>
            <div class="m">${itemCount(o)} lamp${itemCount(o) === 1 ? "" : "s"} · ${rm(orderTotal(o))}</div>
            <div style="margin-top:6px">${pill("st-" + o.status, o.status)}</div>
          </button>`).join("")}</div>` : `<div class="empty"><span class="bloom"></span>No active orders. Time to make more blooms 🌷</div>`}
      </section>

      <section class="card">
        <h3>Sales vs Expenses</h3>
        <div class="muted">Last 7 days</div>
        ${barChart(days, sales, exps)}
        <div class="legend"><span style="--c:var(--pink)">Sales ${rm(sales.reduce((a, b) => a + b, 0))}</span><span style="--c:var(--yellow)">Expenses ${rm(exps.reduce((a, b) => a + b, 0))}</span></div>
      </section>

      ${low.length ? `<section class="card"><div class="row-between"><h3>📦 Restock soon</h3><a class="btn small" href="#inventory">View</a></div>
        <div class="list" style="margin-top:12px">${low.map((i) => `<div class="item low"><div><div class="title">${esc(i.name)}</div><div class="meta">Min ${esc(i.min)} ${esc(i.unit)}</div></div><div class="right"><span class="amt" style="color:var(--red)">${esc(i.qty)} ${esc(i.unit)}</span></div></div>`).join("")}</div></section>` : ""}
    `;
    $$("[data-order]", view).forEach((b) => (b.onclick = () => orderForm(db.orders.find((o) => o.id === b.dataset.order))));
  }

  function barChart(days, a, b) {
    const W = 340, H = 200, top = 12, bottom = 26, left = 6, right = 6;
    const max = Math.max(1, ...a, ...b);
    const slot = (W - left - right) / days.length;
    const bw = Math.min(14, slot / 3.2);
    const h = (v) => ((H - top - bottom) * v) / max;
    const base = H - bottom;
    let bars = "";
    days.forEach((d, i) => {
      const cx = left + slot * i + slot / 2;
      const ha = Math.max(h(a[i]), 2), hb = Math.max(h(b[i]), 2);
      bars += `<rect x="${cx - bw - 1}" y="${base - ha}" width="${bw}" height="${ha}" rx="${bw / 2}" fill="url(#gPink)"><title>${DOW[parseYmd(d).getDay()]} sales ${rm(a[i])}</title></rect>`;
      bars += `<rect x="${cx + 1}" y="${base - hb}" width="${bw}" height="${hb}" rx="${bw / 2}" fill="url(#gYel)"><title>${DOW[parseYmd(d).getDay()]} expenses ${rm(b[i])}</title></rect>`;
      bars += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${DOW[parseYmd(d).getDay()]}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sales versus expenses for the last 7 days">
      <defs>
        <linearGradient id="gPink" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--chart-a1)"/><stop offset="1" style="stop-color:var(--chart-a2)"/></linearGradient>
        <linearGradient id="gYel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--chart-b1)"/><stop offset="1" style="stop-color:var(--chart-b2)"/></linearGradient>
      </defs>
      <line x1="0" x2="${W}" y1="${base}" y2="${base}" style="stroke:var(--line)"/>${bars}</svg>`;
  }

  // ---------- Google Sheet sync (website orders + product list) ----------
  // Runs only inside Claude: reads the viewer's Google Drive through the connector.
  const DRIVE = "Google Drive";
  const sheetId = (v) => { const t = String(v || "").trim(); const m = t.match(/\/d\/([\w-]{20,})/); return m ? m[1] : /^[\w-]{20,}$/.test(t) ? t : ""; };

  function parseCSV(text) {
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += ch;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
    return rows.filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
  }

  const DRIVE_ERRORS = {
    server_not_connected: "Google Drive is not connected. Add it in claude.ai → Settings → Connectors.",
    needs_reauth: "Google Drive needs reconnecting. Go to claude.ai → Settings → Connectors.",
    not_in_manifest: "This app is not allowed to read Google Drive. Allow it in the app's permissions, then try again.",
    approval_required: "Allow Google Drive access when Claude asks, then tap the button again.",
    selection_required: "Choose which Google Drive account to use when Claude asks, then try again.",
    blocked_by_policy: "Your organization blocks Google Drive for this app.",
    server_unavailable: "Google Drive is not answering right now. Try again in a minute.",
    tool_error: "Could not open that Sheet. Check the link and that it belongs to your Google account.",
  };

  async function readSheet(id) {
    const hasClaude = hasClaudeApi();
    const mcp = hasClaude ? await window.claude.use("mcp") : null;
    if (!mcp) throw { code: "local", message: "Open this app in Claude to pull from Google Sheets." };
    const res = await mcp.callTool(DRIVE, "download_file_content", { fileId: id, exportMimeType: "text/csv" }, { cache: false });
    const b64 = res && res.payload && res.payload.content;
    if (typeof b64 !== "string") throw { code: "tool_error" };
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return parseCSV(new TextDecoder().decode(bytes));
  }
  const driveError = (e) => (e && (e.code === "local" ? e.message : DRIVE_ERRORS[e.code])) || "Could not read Google Drive. Try again.";

  // Website orders are pulled when the app opens, every 2 minutes while it is on screen,
  // and whenever the button is tapped. Nothing can run while the app is closed.
  let pulling = false, autoOff = false, lastPull = 0, pullProblem = "";
  const pullLine = () => {
    if (!sheetId(db.settings.ordersSheet)) return `🌐 Website orders: add the Sheet link in <a href="#shop">Settings</a>`;
    if (pulling) return "🌐 Checking website orders…";
    if (pullProblem) return `🌐 <span class="warn-note">${esc(pullProblem)}</span> · <button type="button" class="link-btn" data-pull>Try again</button>`;
    const when = lastPull ? new Date(lastPull).toLocaleTimeString("en-MY", { hour: "numeric", minute: "2-digit" }) : "";
    return `🌐 Website orders come in by themselves${when ? ` · checked ${when}` : ""} · <button type="button" class="link-btn" data-pull>Check now</button>`;
  };
  const showPullLine = () => { const el = document.getElementById("pullLine"); if (el) el.innerHTML = pullLine(); };
  document.addEventListener("click", (e) => { if (e.target.closest("[data-pull]")) pullWebOrders(null, false); });
  // "20 December 2026" -> "2026-12-20"
  function preorderDate(s) {
    const m = String(s || "").match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
    if (!m) return "";
    const mi = MONTHS_FULL.findIndex((x) => x.toLowerCase().startsWith(m[2].slice(0, 3).toLowerCase()));
    return mi < 0 ? "" : `${m[3]}-${pad(mi + 1)}-${pad(Number(m[1]))}`;
  }

  async function pullWebOrders(btn, auto = false) {
    const id = sheetId(db.settings.ordersSheet);
    if (!id) { if (!auto) { toast("Add your orders Sheet link in Settings first"); location.hash = "#shop"; } return; }
    if (pulling || (auto && autoOff)) return;
    pulling = true; showPullLine();
    const label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Pulling…"; }
    try {
      const rows = await readSheet(id);
      // Remember every website order ever pulled, so one deleted in the app is not pulled again.
      if (!Array.isArray(db.settings.webSeen)) db.settings.webSeen = [];
      const have = new Set([...db.settings.webSeen, ...db.orders.map((o) => o.webId).filter(Boolean)]);
      let added = 0;
      rows.forEach((r) => {
        if (!r.order_id || have.has(r.order_id)) return;
        let lines = [];
        try { lines = JSON.parse(r.lines_json || "[]"); } catch { lines = []; }
        const post = lines.filter((l) => /^postage/i.test(String(l.name)));
        lines = lines.filter((l) => !/^postage/i.test(String(l.name)));
        const items = lines.map((l) => {
          const p = db.products.find((x) => x.name.toLowerCase() === String(l.name).toLowerCase());
          return { productId: p ? p.id : "web-" + String(l.name).toLowerCase().replace(/\W+/g, "-"), name: String(l.name), price: Number(l.price) || 0, qty: Number(l.qty) || 0 };
        });
        const created = r.created_at ? new Date(r.created_at) : new Date();
        const addr = [r.address, [r.postcode, r.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
        db.orders.push({
          id: uid(), webId: r.order_id, code: r.order_id, customer: r.name || "Website customer", phone: r.phone || "",
          date: preorderDate(r.preorder_by) || (isNaN(created) ? todayStr() : ymd(created)), items, status: "New", payMethod: "DuitNow QR", payStatus: "Unpaid",
          delivery: /pickup/i.test(r.delivery) ? "Self pickup" : /sabah|sarawak/i.test(r.delivery) ? "Sabah / Sarawak" : "Semenanjung",
          postage: post.reduce((t, l) => t + (Number(l.price) || 0) * (Number(l.qty) || 0), 0),
          address: addr, wish: r.wish || "", tracking: "",
          notes: ["From website", r.preorder_by ? "Pre-order, postage by " + r.preorder_by : ""].filter(Boolean).join(" · "),
          createdAt: Date.now(),
        });
        have.add(r.order_id);
        db.settings.webSeen.push(r.order_id);
        added++;
      });
      if (added) { save(); rerender(); toast(`🌐 ${added} new website order${added > 1 ? "s" : ""}`); }
      else if (!auto) toast("No new website orders");
      autoOff = false; lastPull = Date.now(); pullProblem = "";
    } catch (e) {
      // A failed automatic pull stays quiet; it stops retrying until the button is tapped.
      pullProblem = driveError(e);
      if (auto) { if (!(e && e.retryable)) autoOff = true; } else toast(pullProblem);
    } finally {
      pulling = false; showPullLine();
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; }
    }
  }

  async function pullProducts(btn) {
    const id = sheetId(db.settings.productsSheet);
    if (!id) return toast("Add your products Sheet link in Settings first");
    btn.disabled = true;
    try {
      const rows = await readSheet(id);
      let n = 0;
      rows.forEach((r) => {
        if (!r.name) return;
        const pid = "p-" + (r.id || r.name.toLowerCase().replace(/\W+/g, "-"));
        const item = { id: pid, name: r.name, price: Number(String(r.price).replace(/[^\d.]/g, "")) || 0, category: r.category || "" };
        const i = db.products.findIndex((x) => x.id === pid);
        i >= 0 ? (db.products[i] = { ...db.products[i], ...item }) : db.products.push(item);
        n++;
      });
      save(); rerender(); toast(`${n} products updated from Sheet`);
    } catch (e) { toast(driveError(e)); }
    finally { if (btn.isConnected) btn.disabled = false; }
  }

  // ---------- orders ----------
  function orders() {
    const tabs = ["All", ...ACTIVE, "Posted", "Completed", "Cancelled"];
    const q = ui.orderSearch.trim().toLowerCase();
    let list = db.orders.filter((o) => ui.orderFilter === "All" || o.status === ui.orderFilter);
    if (q) list = list.filter((o) => (o.customer + " " + o.phone + " " + o.code).toLowerCase().includes(q));
    // active first by nearest date, then the rest newest first
    list.sort((a, b) => {
      const aa = ACTIVE.includes(a.status), bb = ACTIVE.includes(b.status);
      if (aa !== bb) return aa ? -1 : 1;
      return aa ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
    });

    view.innerHTML = `
      <div class="page-head"><div><h1>Orders</h1><p>Manage &amp; track order status</p></div><button class="btn primary" id="newOrder">+ New Order</button></div>
      <p class="pull-line" id="pullLine">${pullLine()}</p>
      <div class="btn-pair" style="margin-bottom:14px"><button class="btn" id="waImport">💬 Import from WhatsApp</button><button class="btn" id="bulkRc">🧾 Add receipts</button></div>
      <div class="tabs">${tabs.map((t) => `<button class="${t === ui.orderFilter ? "on" : ""}" data-tab="${t}">${t} ${t === "All" ? "" : `(${db.orders.filter((o) => o.status === t).length})`}</button>`).join("")}</div>
      <input class="search" id="orderSearch" type="search" placeholder="Search name, phone or code…" value="${esc(ui.orderSearch)}" />
      <div class="list">${list.length ? list.map(orderRow).join("") : `<div class="empty"><span class="bloom"></span>No orders here yet.</div>`}</div>
    `;
    $("#newOrder").onclick = () => orderForm(null);
    $("#bulkRc").onclick = () => bulkReceipts();
    $("#waImport").onclick = () => waImport();
    $$("[data-tab]").forEach((b) => (b.onclick = () => { ui.orderFilter = b.dataset.tab; orders(); }));
    const s = $("#orderSearch");
    s.oninput = () => { ui.orderSearch = s.value; orders(); const n = $("#orderSearch"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
    $$("[data-order]", view).forEach((b) => (b.onclick = () => orderForm(db.orders.find((o) => o.id === b.dataset.order))));
  }

  // One tap moves an order to its next step.
  const nextStatus = (o) => ({ New: "Making", Making: "Ready", Ready: o.delivery === "Self pickup" ? "Completed" : "Posted", Posted: "Completed" })[o.status];
  const nextLabel = (st) => ({ Making: "🧶 Start making", Ready: "🌷 Mark ready", Posted: "📦 Mark posted", Completed: "✅ Mark completed" })[st];

  function orderRow(o) {
    const nx = nextStatus(o);
    return `<div class="order-card"><button class="item" data-order="${o.id}">
      <div>
        <div class="code">${esc(o.code)} · ${esc(prettyDate(o.date))}</div>
        <div class="title">${esc(o.customer)}</div>
        <div class="meta">${o.phone ? esc(o.phone) + " · " : ""}${itemCount(o)} lamp${itemCount(o) === 1 ? "" : "s"}${o.delivery ? " · " + esc(o.delivery) : ""}${o.tracking ? " · 📦 " + esc(o.tracking) : ""}</div>
        ${lampThumbs(o)}
      </div>
      <div class="right">
        <span class="amt">${rm(orderTotal(o))}</span>
        ${pill("st-" + o.status, o.status)}
        ${pill("pay-" + o.payStatus, o.payStatus)}${hasReceipt(o) ? `<span class="rc-flag" title="Receipt saved">🧾</span>` : ""}
      </div>
    </button>${nx ? `<button class="next-btn" data-next="${o.id}">${nextLabel(nx)} <span aria-hidden="true">›</span></button>` : ""}</div>`;
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-next]");
    if (!b) return;
    const o = db.orders.find((x) => x.id === b.dataset.next);
    const nx = o && nextStatus(o);
    if (!nx) return;
    if (nx === "Posted") return postSheet(o);
    const prev = o.status;
    o.status = nx;
    save(); rerender();
    toast(`${o.customer}: ${prev} → ${nx}`);
  });

  // Marking an order as posted: scan or paste the J&T number, save, then WhatsApp the customer.
  function postSheet(o) {
    openModal(`Post ${o.customer}'s order`, `
      <div class="field"><label for="ps-track">J&amp;T tracking no.</label>
        <div class="track-row"><input id="ps-track" value="${esc(o.tracking || "")}" placeholder="Paste or scan" autocomplete="off" />
        <label class="btn small scan-btn" for="ps-scan">📷 Scan</label></div>
        <input id="ps-scan" type="file" accept="image/*" hidden />
        <div class="muted" id="ps-msg" style="font-size:.85rem">Photo of the airway bill, or a screenshot from the J&amp;T app.</div>
      </div>
      <div class="form-actions"><button type="button" class="btn" id="ps-skip">Post without no.</button><button type="button" class="btn primary" id="ps-save">📦 Mark posted</button></div>
      <div id="ps-done" hidden></div>`, (root) => {
      $("#ps-scan", root).onchange = async (e) => {
        const file = e.target.files[0]; e.target.value = "";
        if (!file) return;
        const msg = $("#ps-msg", root);
        msg.textContent = "Reading the tracking number…";
        const res = await readTracking(file);
        if (!root.isConnected) return;
        if (res.no) { $("#ps-track", root).value = res.no; msg.textContent = `Found ${res.no}. Check it, then tap Mark posted.`; }
        else msg.textContent = res.why;
      };
      const finish = (withNo) => {
        o.tracking = withNo ? $("#ps-track", root).value.trim().toUpperCase() : o.tracking || "";
        if (withNo && !o.tracking) { toast("Add the tracking number, or tap Post without no."); return; }
        o.status = "Posted";
        save(); rerender();
        const wa = waLink(o.phone, waMsg(o, "posted"));
        $("#ps-done", root).hidden = false;
        $("#ps-done", root).innerHTML = `<p style="font-weight:700;margin:14px 0 10px">✅ ${esc(o.customer)}'s order is posted.</p>
          ${wa ? `<a class="btn primary block" target="_blank" rel="noopener" href="${wa}">💬 WhatsApp ${esc(o.customer)} the tracking</a>` : `<p class="muted">No phone number on this order.</p>`}
          <button type="button" class="btn block" style="margin-top:10px" id="ps-close">Done</button>`;
        root.querySelector(".form-actions").hidden = true;
        $("#ps-close", root).onclick = closeModal;
      };
      $("#ps-save", root).onclick = () => finish(true);
      $("#ps-skip", root).onclick = () => finish(false);
    });
  }

  // ---------- DuitNow receipts ----------
  const hasReceipt = (o) => !!(o.receipt || o.receiptData);
  const receiptSrc = (o) => o.receipt ? "/_blob/" + o.receipt : o.receiptData || "";
  const receiptThumb = (o) => hasReceipt(o)
    ? `<button type="button" class="receipt-thumb" data-receipt aria-label="View receipt"><img src="${esc(receiptSrc(o))}" alt="" /></button>`
    : `<span class="receipt-thumb empty">🧾</span>`;
  // Built by hand: fetch() of a data: URL is blocked inside the Claude viewer.
  const toBlob = async (dataUrl) => {
    const [head, b64] = String(dataUrl).split(",");
    const bin = atob(b64 || "");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: (head.match(/data:([^;]+)/) || [])[1] || "image/jpeg" });
  };
  // Smaller copy kept inside the order when file storage is not available.
  const compactReceipt = async (dataUrl) => {
    try { return await shrinkPhoto(await toBlob(dataUrl), 800, true, 0.6); } catch { return dataUrl; }
  };
  async function storeReceipt(file) { return storeReceiptData(await shrinkPhoto(file, 1100, true)); }
  async function storeReceiptData(data) {
    const assets = hasClaudeApi() ? await window.claude.use("assets") : null;
    if (!assets) return { data: await compactReceipt(data) };
    const blob = await toBlob(data);
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const up = await assets.upload(blob, { type: "image/jpeg" }); return { id: up.id }; }
      catch (e) {
        console.warn("Receipt upload failed:", e && e.code, e && e.message);
        if (!(e && e.code === "store_unavailable") || attempt) break;
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    // File storage refused it: keep a smaller copy inside the order instead.
    return { data: await compactReceipt(data) };
  }
  function viewReceipt(o) {
    const lb = document.createElement("div");
    lb.className = "lightbox";
    lb.innerHTML = `<img src="${esc(receiptSrc(o))}" alt="DuitNow receipt for ${esc(o.customer)}" /><button type="button" class="btn">Close</button>`;
    lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
  }

  // ---------- many DuitNow receipts at once ----------
  const orderDay = (o) => (o.createdAt ? ymd(new Date(o.createdAt)) : o.date) || o.date || "";
  const dayGap = (a, b) => (a && b ? Math.abs(parseYmd(a) - parseYmd(b)) / 86400000 : 30);
  const firstWord = (t) => String(t || "").trim().toLowerCase().split(/\s+/)[0] || "";
  const titleCase = (t) => String(t || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();

  async function readReceipt(blob) {
    const sample = hasClaudeApi() ? await window.claude.use("sample") : null;
    if (!sample) return { error: "local" };
    try {
      const r = await sample.json(
        "This image is a Malaysian DuitNow / bank transfer receipt (screenshot). Return JSON only: " +
        '{"amount": number in RM, "date": "YYYY-MM-DD", "payer": "name of the person who paid, as written", "reference": "transaction reference or empty string"}. ' +
        "Use null for anything you cannot see.",
        { images: [blob], modelTier: "quick", cache: false });
      return { amount: Number(r && r.amount) || "", date: /^\d{4}-\d{2}-\d{2}$/.test(r && r.date) ? r.date : "", payer: (r && r.payer) || "", reference: (r && r.reference) || "" };
    } catch (e) { return { error: e && e.code }; }
  }

  // Best unmatched order for a receipt: same total, unpaid first, closest date, same first name.
  function guessOrder(rc, taken) {
    const amt = Number(rc.amount);
    if (!amt) return "";
    const pool = db.orders.filter((o) => o.status !== "Cancelled" && !hasReceipt(o) && !taken.has(o.id) && Math.abs(orderTotal(o) - amt) < 0.01);
    const name = firstWord(rc.payer);
    const score = (o) => (o.payStatus === "Unpaid" ? 0 : 5) + dayGap(rc.date, orderDay(o)) - (name && String(o.customer || "").toLowerCase().includes(name) ? 3 : 0);
    pool.sort((a, b) => score(a) - score(b));
    return pool[0] ? pool[0].id : "";
  }

  function matchOptions(rc, sel, taken) {
    const amt = Number(rc.amount);
    const open = db.orders.filter((o) => o.status !== "Cancelled" && !hasReceipt(o) && (!taken.has(o.id) || o.id === sel));
    const same = open.filter((o) => amt && Math.abs(orderTotal(o) - amt) < 0.01);
    const others = open.filter((o) => !same.includes(o)).sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 40);
    const opt = (o, mark) => `<option value="${o.id}" ${o.id === sel ? "selected" : ""}>${mark} ${esc(o.code)} · ${esc(o.customer)} · ${rm(orderTotal(o))}</option>`;
    return `<option value="new" ${sel === "new" ? "selected" : ""}>➕ New order from this receipt</option>
      <option value="skip" ${sel === "skip" ? "selected" : ""}>Skip this receipt</option>
      ${same.length ? `<optgroup label="Same amount">${same.map((o) => opt(o, "✓")).join("")}</optgroup>` : ""}
      ${others.length ? `<optgroup label="Other orders">${others.map((o) => opt(o, "")).join("")}</optgroup>` : ""}`;
  }

  function bulkReceipts() {
    const rows = [];
    openModal("Add receipts", `
      <p class="muted" style="margin:-4px 0 12px">Pick old DuitNow receipts. Claude reads the amount, date and name, and matches each one to an order. Receipts with no order become new orders.</p>
      <label class="btn primary block" for="bulkFiles">🧾 Choose receipts</label>
      <input id="bulkFiles" type="file" accept="image/*" multiple hidden />
      <div id="bulkStatus" class="muted" style="margin:12px 0 4px;font-weight:700"></div>
      <div id="bulkList" class="rc-list"></div>
      <div id="bulkActions" hidden class="form-actions" style="margin-top:14px"><button type="button" class="btn" id="bulkCancel">Cancel</button><button type="button" class="btn primary" id="bulkSave">Save all</button></div>`, (root) => {
      const list = $("#bulkList", root), status = $("#bulkStatus", root);
      const taken = () => new Set(rows.filter((r) => r.match && r.match !== "new" && r.match !== "skip").map((r) => r.match));
      const drawRow = (i) => {
        const r = rows[i];
        const el = list.querySelector(`[data-rc="${i}"]`);
        el.innerHTML = `<img class="rc-img" src="${r.data}" alt="Receipt ${i + 1}" />
          <div class="rc-fields">
            ${r.reading ? `<div class="muted">Reading…</div>` : `
            <div class="rc-grid">
              <label>RM<input type="number" step="0.01" inputmode="decimal" data-f="amount" value="${esc(r.amount)}" /></label>
              <label>Date<input type="date" data-f="date" value="${esc(r.date)}" /></label>
            </div>
            <label class="rc-payer">Paid by<input data-f="payer" value="${esc(r.payer)}" placeholder="Name on receipt" /></label>
            <select data-f="match" aria-label="Order for this receipt">${matchOptions(r, r.match, taken())}</select>
            ${r.note ? `<div class="muted" style="font-size:.82rem">${esc(r.note)}</div>` : ""}`}
          </div>`;
      };
      const redrawAll = () => rows.forEach((_, i) => drawRow(i));

      list.addEventListener("change", (e) => {
        const box = e.target.closest("[data-rc]"); if (!box) return;
        const r = rows[Number(box.dataset.rc)], f = e.target.dataset.f;
        if (!f) return;
        r[f] = e.target.value;
        if (f === "amount" && (!r.match || r.match === "new")) { r.match = guessOrder(r, taken()) || "new"; }
        redrawAll();
      });

      $("#bulkFiles", root).onchange = async (e) => {
        const files = [...e.target.files]; e.target.value = "";
        if (!files.length) return;
        const start = rows.length;
        for (const f of files) {
          let data = "";
          try { data = await shrinkPhoto(f, 1100, true); } catch { continue; }
          rows.push({ data, amount: "", date: "", payer: "", reference: "", match: "", reading: true });
          list.insertAdjacentHTML("beforeend", `<div class="rc-item" data-rc="${rows.length - 1}"></div>`);
          drawRow(rows.length - 1);
        }
        $("#bulkActions", root).hidden = false;
        let stopped = false;
        for (let i = start; i < rows.length; i++) {
          if (!root.isConnected) return;
          const r = rows[i];
          status.textContent = `Reading receipt ${i - start + 1} of ${rows.length - start}…`;
          const got = stopped ? { error: "stopped" } : await readReceipt(await toBlob(r.data));
          if (got.error) {
            if (got.error === "rate_limited" || got.error === "not_granted" || got.error === "local") stopped = true;
            r.note = got.error === "local" ? "Open the app in Claude to read receipts automatically. Fill in the amount." : "Could not read this one. Fill in the amount and date.";
          } else Object.assign(r, got);
          r.reading = false;
          r.match = guessOrder(r, taken()) || "new";
          drawRow(i);
        }
        redrawAll();
        const matched = rows.filter((r) => r.match && r.match !== "new" && r.match !== "skip").length;
        status.textContent = `${rows.length} receipt${rows.length > 1 ? "s" : ""}: ${matched} matched to orders, ${rows.filter((r) => r.match === "new").length} new. Check them, then tap Save all.`;
      };

      $("#bulkCancel", root).onclick = closeModal;
      $("#bulkSave", root).onclick = async (e) => {
        const btn = e.currentTarget;
        if (rows.some((r) => r.reading)) return toast("Still reading receipts…");
        btn.disabled = true;
        let linked = 0, created = 0, failed = 0;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (r.match === "skip") continue;
          btn.textContent = `Saving ${i + 1}/${rows.length}…`;
          let stored;
          try { stored = await storeReceiptData(r.data); } catch { failed++; continue; }
          if (r.match && r.match !== "new") {
            const o = db.orders.find((x) => x.id === r.match);
            if (!o) continue;
            o.receipt = stored.id || ""; o.receiptData = stored.data || ""; o.payStatus = "Paid";
            if (!o.payMethod) o.payMethod = "DuitNow QR";
            linked++;
          } else {
            const amt = Number(r.amount) || 0;
            db.orders.push({
              id: uid(), code: (db.settings.prefix || "") + db.settings.nextNo++, customer: titleCase(r.payer) || "Customer", phone: "",
              date: r.date || todayStr(), items: amt ? [{ productId: "receipt-only", name: "Past order (from receipt)", price: amt, qty: 1 }] : [],
              status: "Completed", payMethod: "DuitNow QR", payStatus: "Paid", delivery: "", postage: 0, address: "", wish: "", tracking: "",
              notes: "Added from a DuitNow receipt" + (r.reference ? " · Ref " + r.reference : ""), receipt: stored.id || "", receiptData: stored.data || "", createdAt: Date.now(),
            });
            created++;
          }
        }
        save(); closeModal(); rerender();
        toast(`🧾 ${linked} receipt${linked === 1 ? "" : "s"} added to orders, ${created} new order${created === 1 ? "" : "s"}${failed ? `, ${failed} not saved` : ""}`);
      };
    });
  }

  // ---------- old orders from WhatsApp ----------
  const money = (t) => Number(String(t || "").replace(/[^\d.]/g, "")) || 0;
  const findProduct = (name) => {
    const n = String(name || "").trim().toLowerCase();
    return db.products.find((x) => x.name.toLowerCase() === n) || db.products.find((x) => n.startsWith(x.name.toLowerCase()) || x.name.toLowerCase().startsWith(n));
  };
  const lineItem = (name, qty, unit) => {
    const pr = findProduct(name);
    return { productId: pr ? pr.id : "wa-" + String(name).toLowerCase().replace(/\W+/g, "-"), name: pr ? pr.name : String(name).trim(), price: unit || (pr ? pr.price : 0), qty };
  };

  // Split a WhatsApp export/copy into messages, keeping each message's date.
  // iPhone: "[12/11/2026, 10:06:13 PM] Nuha: text"  Android: "12/11/2026, 10:06 pm - Nuha: text"
  const WA_PREFIX = /^\[?(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4}),?\s+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\s*(?:[ap]\.?m\.?)?\]?\s*(?:-\s*)?([^:\n]{1,60}?):\s?(.*)$/i;
  function waMessages(text) {
    const lines = String(text).replace(/[‎‏‪-‮⁦-⁩]/g, "").replace(/\r/g, "").split("\n");
    const out = [];
    let cur = null;
    for (const line of lines) {
      const m = line.match(WA_PREFIX);
      if (m) {
        let y = Number(m[3]); if (y < 100) y += 2000;
        cur = { date: `${y}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`, from: m[4].trim(), text: m[5] };
        out.push(cur);
      } else if (cur) cur.text += "\n" + line;
      else { cur = { date: "", from: "", text: line }; out.push(cur); }
    }
    return out;
  }

  // Orders sent from preciousnuha.com always start with this line.
  const WEB_HEAD = /Hi Precious Nuha!?\s*I['’]?d love to order/i;
  function parseWebOrder(block, date, from) {
    const o = { items: [], postage: 0, delivery: "", address: "", wish: "", customer: "", phone: "", total: 0, code: "", date, preorder: "" };
    const code = block.match(/\(Order\s+([A-Z]{2,}-[\w-]+)\)/i);
    if (code) o.code = code[1];
    for (const raw of block.split("\n")) {
      const l = raw.trim();
      let m;
      if ((m = l.match(/^-\s*(.+?)\s*x\s*(\d+)\s*=\s*RM\s*([\d,.]+)\s*$/i))) {
        const name = m[1].replace(/\s*\([^)]*\)\s*$/, "");
        o.items.push(lineItem(name, Number(m[2]), money(m[3]) / Number(m[2])));
      } else if ((m = l.match(/^Postage\s*\(([^)]+)\):\s*RM\s*([\d,.]+)\s*x\s*(\d+)\s*=\s*RM\s*([\d,.]+)/i))) {
        o.delivery = /sabah|sarawak/i.test(m[1]) ? "Sabah / Sarawak" : "Semenanjung";
        o.postage = money(m[4]);
      } else if (/^Self pickup:\s*FREE/i.test(l) || /^Delivery:\s*Self pickup/i.test(l)) o.delivery = "Self pickup";
      else if ((m = l.match(/^Total:\s*RM\s*([\d,.]+)/i))) o.total = money(m[1]);
      else if ((m = l.match(/postage by\s+(.+)$/i))) o.preorder = m[1].trim();
      else if ((m = l.match(/^Name:\s*(.*)$/i))) o.customer = m[1].trim();
      else if ((m = l.match(/^Phone:\s*(.*)$/i))) o.phone = m[1].trim();
      else if ((m = l.match(/^Address:\s*(.*)$/i))) o.address = m[1].trim();
      else if ((m = l.match(/^Wish card message:\s*(.*)$/i))) o.wish = m[1].trim();
      else if (!/^(Subtotal|Total|Payment)/i.test(l) && (m = l.match(/^([A-Za-z][^=]*?)\s*x\s*(\d+)\s*=\s*RM\s*([\d,.]+)\s*$/i))) {
        o.items.push(lineItem(m[1], Number(m[2]), money(m[3]) / Number(m[2]))); // add-ons
      }
    }
    if (!o.customer && from) o.customer = from;
    return o;
  }

  async function claudeOrders(text) {
    const sample = hasClaudeApi() ? await window.claude.use("sample") : null;
    if (!sample) return { error: "local" };
    const menu = db.products.map((p) => `${p.name} RM${p.price}`).join("; ");
    try {
      const r = await sample.json(
        "You read WhatsApp chats of a Malaysian handmade flower lamp shop (Precious Nuha) and list the orders customers placed. " +
        "Chats may be in Malay or English. Products and prices: " + menu + ". Postage is RM" + (db.settings.postSM ?? 10) + " per lamp to Semenanjung, RM" + (db.settings.postSS ?? 45) + " per lamp to Sabah/Sarawak, free for self pickup. " +
        'Return JSON only: {"orders":[{"customer":string,"phone":string,"date":"YYYY-MM-DD or empty","items":[{"name":string,"qty":number,"price":number}],"delivery":"Semenanjung"|"Sabah / Sarawak"|"Self pickup"|"","address":string,"wish":string,"total":number,"notes":string}]}. ' +
        "Only include real orders (skip greetings and questions). Use product names from the list when they match.\n\nCHAT:\n" + String(text).slice(0, 30000),
        { modelTier: "default", cache: false });
      return { orders: (r && Array.isArray(r.orders) ? r.orders : []) };
    } catch (e) { return { error: e && e.code }; }
  }

  // iPhone exports a chat as a .zip holding _chat.txt; Android exports the .txt itself.
  let zipLoad = null;
  const loadZip = () => zipLoad || (zipLoad = new Promise((ok, fail) => {
    const sc = document.createElement("script");
    sc.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
    sc.onload = () => (window.JSZip ? ok(window.JSZip) : fail());
    sc.onerror = () => { zipLoad = null; fail(); };
    document.head.appendChild(sc);
  }));
  async function chatFileText(file) {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    if (head[0] !== 0x50 || head[1] !== 0x4b) return file.text(); // not a zip
    const zip = await (await loadZip()).loadAsync(file);
    const entry = Object.values(zip.files).find((z) => /\.txt$/i.test(z.name) && !z.dir);
    if (!entry) throw new Error("no chat");
    return entry.async("string");
  }

  function waImport() {
    let found = [];
    openModal("Import from WhatsApp", `
      <ol class="steps">
        <li>In WhatsApp, press and hold an order message → <b>Select</b> more messages → <b>Copy</b>.<br><span class="muted">Or: open the chat → contact name → <b>Export chat</b> → Without media → save, and pick that file below.</span></li>
        <li>Paste here, then tap <b>Read orders</b>.</li>
      </ol>
      <div class="field"><textarea id="waText" rows="7" placeholder="Paste WhatsApp messages here…"></textarea></div>
      <div class="btn-pair"><label class="btn" for="waFile">📄 Pick chat file</label><button type="button" class="btn primary" id="waRead">Read orders</button></div>
      <input id="waFile" type="file" accept=".txt,.zip,text/plain,application/zip" hidden />
      <div id="waStatus" class="muted" style="margin:12px 0 6px;font-weight:700"></div>
      <div id="waList" class="list"></div>
      <div id="waSave" hidden style="margin-top:14px">
        <div class="grid2">
          <div class="field"><label for="waSt">Status for these</label><select id="waSt">${opts(STATUSES, "Completed")}</select></div>
          <div class="field"><label for="waPay">Payment</label><select id="waPay">${opts(PAY_STATUS, "Paid")}</select></div>
        </div>
        <button type="button" class="btn primary block" id="waGo">Import</button>
      </div>`, (root) => {
      const status = $("#waStatus", root), list = $("#waList", root);
      const isDup = (o) => {
        const ph = String(o.phone || "").replace(/\D/g, "").replace(/^6?0/, "");
        return db.orders.some((x) => (o.code && (x.code === o.code || x.webId === o.code)) ||
          (ph && String(x.phone || "").replace(/\D/g, "").replace(/^6?0/, "") === ph && Math.abs(orderTotal(x) - (o.total || itemsTotal(o) + o.postage)) < 0.01 && dayGap(x.date, o.date) <= 3));
      };
      const draw = () => {
        list.innerHTML = found.map((o, i) => `
          <label class="wa-card ${o.dup ? "dup" : ""}">
            <input type="checkbox" data-i="${i}" ${o.pick ? "checked" : ""} />
            <div class="wa-body">
              <div class="row-between"><b>${esc(o.customer || "Customer")}</b><b>${rm(o.total || itemsTotal(o) + o.postage)}</b></div>
              <div class="meta">${esc([o.code, o.phone, o.delivery, o.date ? prettyDate(o.date) : ""].filter(Boolean).join(" · "))}</div>
              <div class="meta">${o.items.map((it) => `${esc(it.name)} ×${it.qty}`).join(", ") || "No items found"}</div>
              ${o.dup ? `<div class="warn-note">Looks like an order already in the app — left unticked.</div>` : ""}
              ${o.mismatch ? `<div class="warn-note">Items add up to ${rm(itemsTotal(o) + o.postage)}, message says ${rm(o.total)}. Check after import.</div>` : ""}
            </div>
          </label>`).join("");
        const n = found.filter((o) => o.pick).length;
        $("#waSave", root).hidden = !found.length;
        $("#waGo", root).textContent = `Import ${n} order${n === 1 ? "" : "s"}`;
        $("#waGo", root).disabled = !n;
      };
      list.addEventListener("change", (e) => { const i = e.target.dataset.i; if (i != null) { found[Number(i)].pick = e.target.checked; draw(); } });

      $("#waFile", root).onchange = async (e) => {
        const f = e.target.files[0]; e.target.value = "";
        if (!f) return;
        try { $("#waText", root).value = await chatFileText(f); }
        catch { toast("Could not open that file. Copy and paste the messages instead."); }
      };

      $("#waRead", root).onclick = async (e) => {
        const text = $("#waText", root).value;
        if (!text.trim()) return toast("Paste some messages first");
        const btn = e.currentTarget; btn.disabled = true;
        found = [];
        const msgs = waMessages(text);
        const rest = [];
        for (const m of msgs) {
          if (WEB_HEAD.test(m.text)) {
            m.text.split(WEB_HEAD).slice(1).forEach((part) => found.push(parseWebOrder("Hi Precious Nuha! I'd love to order" + part, m.date, m.from)));
          } else rest.push(m);
        }
        const restText = rest.map((m) => (m.date ? `[${m.date}] ${m.from}: ` : "") + m.text).join("\n").trim();
        if (restText.length > 20) {
          status.textContent = `Found ${found.length} website order${found.length === 1 ? "" : "s"}. Asking Claude to read the rest of the chat…`;
          const r = await claudeOrders(restText);
          if (r.orders) r.orders.forEach((x) => {
            const items = (x.items || []).filter((it) => it && it.name).map((it) => lineItem(it.name, Number(it.qty) || 1, Number(it.price) || 0));
            const delivery = DELIVERY.includes(x.delivery) ? x.delivery : "";
            const lamps = items.filter((it) => !isAddon(it)).reduce((t, it) => t + it.qty, 0);
            found.push({ items, customer: x.customer || "", phone: x.phone || "", date: /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : "", delivery,
              postage: delivery ? postFee(delivery) * lamps : 0, address: x.address || "", wish: x.wish || "", total: Number(x.total) || 0, code: "", preorder: "", notes: x.notes || "", fromChat: true });
          });
          else if (r.error && r.error !== "local") toast("Claude could not read the chat messages. Website orders are still listed.");
        }
        found.forEach((o) => {
          o.date = preorderDate(o.preorder) || o.date || todayStr();
          if (!o.total) o.total = itemsTotal(o) + o.postage;
          o.mismatch = o.items.length && Math.abs(itemsTotal(o) + o.postage - o.total) > 0.01;
          o.dup = isDup(o);
          o.pick = !o.dup;
        });
        status.textContent = found.length ? `${found.length} order${found.length === 1 ? "" : "s"} found. Untick any you don't want, then import.` : "No orders found in that text.";
        btn.disabled = false;
        draw();
      };

      $("#waGo", root).onclick = () => {
        const st = $("#waSt", root).value, pay = $("#waPay", root).value;
        let n = 0;
        found.filter((o) => o.pick).forEach((o) => {
          const items = o.items.length ? o.items : [{ productId: "receipt-only", name: "Past order (from WhatsApp)", price: o.total, qty: 1 }];
          const code = o.code || (db.settings.prefix || "") + db.settings.nextNo++;
          db.orders.push({
            id: uid(), code, webId: o.code || undefined, customer: o.customer || "Customer", phone: o.phone, date: o.date, items,
            status: st, payMethod: "DuitNow QR", payStatus: pay, delivery: o.delivery, postage: o.postage, address: o.address, wish: o.wish, tracking: "",
            notes: ["Imported from WhatsApp", o.preorder ? "Postage by " + o.preorder : "", o.notes || ""].filter(Boolean).join(" · "), createdAt: Date.now(),
          });
          if (o.code) { if (!Array.isArray(db.settings.webSeen)) db.settings.webSeen = []; db.settings.webSeen.push(o.code); }
          n++;
        });
        save(); closeModal(); rerender();
        toast(`💬 ${n} order${n === 1 ? "" : "s"} imported`);
      };
    });
  }

  // ---------- J&T tracking number from a photo or screenshot ----------
  const trackUrl = (no) => `https://www.jtexpress.my/tracking/${encodeURIComponent(no)}`;
  const looksLikeTracking = (t) => /^[A-Z0-9]{9,20}$/.test(t) && /\d{6,}/.test(t);
  let zxingLoad = null;
  const loadZxing = () => zxingLoad || (zxingLoad = new Promise((ok, fail) => {
    const sc = document.createElement("script");
    sc.src = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";
    sc.onload = () => (window.ZXing ? ok(window.ZXing) : fail());
    sc.onerror = () => { zxingLoad = null; fail(); };
    document.head.appendChild(sc);
  }));

  async function readBarcode(file) {
    const url = URL.createObjectURL(file);
    try {
      if ("BarcodeDetector" in window) {
        try {
          const img = await createImageBitmap(file);
          const codes = await new window.BarcodeDetector().detect(img);
          const hit = codes.map((c) => c.rawValue.trim().toUpperCase()).filter(looksLikeTracking).sort((a, b) => b.length - a.length)[0];
          if (hit) return hit;
        } catch { /* fall through to the library */ }
      }
      const Z = await loadZxing();
      const hints = new Map([[Z.DecodeHintType.TRY_HARDER, true]]);
      const r = await new Z.BrowserMultiFormatReader(hints).decodeFromImageUrl(url);
      const t = String(r && r.getText ? r.getText() : "").trim().toUpperCase();
      return looksLikeTracking(t) ? t : "";
    } catch { return ""; } finally { URL.revokeObjectURL(url); }
  }

  async function readTracking(file) {
    const bar = await readBarcode(file);
    if (bar) return { no: bar, how: "barcode" };
    // No barcode (e.g. a screenshot of the J&T app): ask Claude to read the number.
    const sample = hasClaudeApi() ? await window.claude.use("sample") : null;
    if (!sample) return { why: "No barcode found in that picture. Type or paste the number instead." };
    try {
      const lim = sample.limits ? await sample.limits() : { images: true };
      if (!lim || !lim.images) return { why: "No barcode found in that picture. Type or paste the number instead." };
      const out = await sample("This image is a J&T Express Malaysia airway bill or a screenshot from the J&T app. Reply with ONLY the tracking (waybill) number, with no spaces or other text. If you cannot see one, reply NONE.", { images: [file], modelTier: "quick", cache: false });
      const t = String(out.text || "").replace(/\s+/g, "").toUpperCase();
      return looksLikeTracking(t) ? { no: t, how: "read by Claude" } : { why: "Could not find a tracking number. Type or paste it instead." };
    } catch (e) {
      return { why: e && e.code === "not_granted" ? "Reading pictures was not allowed. Type or paste the number instead." : "Could not read the picture. Type or paste the number instead." };
    }
  }

  // Ready-made WhatsApp messages, in the shop's own friendly tone.
  function waMsg(o, kind) {
    const shop = db.settings.business || "Precious Nuha";
    const lines = o.items.map((i) => `- ${i.name} x ${i.qty}`).join("\n");
    if (kind === "pay") return `Hi ${o.customer}! 🌷 Thank you for ordering with ${shop} (${o.code}).\n\n${lines}\nTotal: ${rm(orderTotal(o))}\n\nPlease make full payment via DuitNow QR and send the receipt here. Thank you 🤍`;
    if (kind === "ready") return o.delivery === "Self pickup"
      ? `Hi ${o.customer}! Your blooms are ready 🌷 (${o.code}). You can pick them up at Taman Sentosa, Klang. Let me know what time suits you 🤍`
      : `Hi ${o.customer}! Your blooms are ready 🌷 (${o.code}). We'll post them out soon and send you the tracking number 🤍`;
    return `Hi ${o.customer}! Your order ${o.code} has been posted 📦${o.tracking ? `\nTracking no: ${o.tracking}\nTrack here: ${trackUrl(o.tracking)}` : ""}\nThank you for supporting ${shop} 🤍`;
  }

  function orderForm(order, presetDate) {
    const isNew = !order;
    const o = order ? JSON.parse(JSON.stringify(order)) : {
      id: uid(), code: "", customer: "", phone: "", date: presetDate || todayStr(),
      items: db.products[0] ? [{ productId: db.products[0].id, name: db.products[0].name, price: db.products[0].price, qty: 1 }] : [],
      status: "New", payMethod: PAY_METHODS[0], payStatus: "Unpaid", notes: "",
      delivery: "Semenanjung", postage: 0, address: "", wish: "", tracking: "",
    };
    if (!o.delivery) o.delivery = "";
    const autoPostage = () => { if (o.delivery) o.postage = postFee(o.delivery) * lampCount(o); };
    if (isNew) autoPostage();

    const productOptions = (it) => {
      let html = db.products.map((p) => `<option value="${p.id}" ${p.id === it.productId ? "selected" : ""}>${esc(p.name)} – ${rm(p.price)}</option>`).join("");
      if (it.productId && !db.products.some((p) => p.id === it.productId)) html = `<option value="${esc(it.productId)}" selected>${esc(it.name)} – ${rm(it.price)}</option>` + html;
      return html;
    };
    const wa = waLink(o.phone);

    openModal(isNew ? "New Order" : `Edit Order`, `
      <form id="orderF" autocomplete="off">
        ${isNew ? "" : `<div class="muted" style="margin:-8px 0 12px;font-weight:700">${esc(o.code)}</div>`}
        <div class="field"><label for="f-customer">Customer name</label><input id="f-customer" required value="${esc(o.customer)}" placeholder="e.g. Munirah" /></div>
        <div class="grid2">
          <div class="field"><label for="f-phone">Phone</label><input id="f-phone" type="tel" inputmode="tel" value="${esc(o.phone)}" placeholder="01X-XXXXXXX" /></div>
          <div class="field"><label for="f-date">Post / pickup date</label><input id="f-date" type="date" required value="${esc(o.date)}" /></div>
        </div>
        <div class="lbl" style="margin-bottom:6px">Delivery</div>
        <div class="seg" id="f-delivery">${DELIVERY.map((d) => `<label><input type="radio" name="delivery" value="${esc(d)}" ${o.delivery === d ? "checked" : ""}><span>${esc(d)}${postFee(d) ? ` · RM${postFee(d)}/lamp` : " · FREE"}</span></label>`).join("")}</div>
        <div class="field" id="addrField" ${o.delivery === "Self pickup" ? "hidden" : ""}><label for="f-address">Address</label><textarea id="f-address" rows="2" placeholder="Address, postcode, city">${esc(o.address || "")}</textarea></div>
        <div class="row-between"><span class="lbl">Lamps &amp; add-ons</span><span class="lbl" style="width:118px">Qty</span></div>
        <div class="line-items" id="lineItems"></div>
        ${db.products.length ? `<button type="button" class="btn small" id="addItem">+ Add item</button>` : `<div class="muted">Add products first in <a href="#products">Products</a>.</div>`}
        <div class="field"><label for="f-wish">Wish card message</label><textarea id="f-wish" rows="2" placeholder="Happy birthday! Love, …">${esc(o.wish || "")}</textarea></div>
        <div style="margin-top:4px"><div class="sum-row"><span>Lamps &amp; add-ons</span><span id="subOut"></span></div><div class="sum-row"><span id="postLbl">Postage</span><span id="postOut"></span></div></div>
        <div class="total-box"><span>Total</span><strong id="totalOut">RM0.00</strong></div>
        <div class="lbl" style="margin-bottom:6px">Order status</div>
        <div class="seg" id="f-status">${STATUSES.map((st) => `<label><input type="radio" name="status" value="${st}" ${o.status === st ? "checked" : ""}><span>${st}</span></label>`).join("")}</div>
        <div class="grid2">
          <div class="field"><label for="f-method">Payment method</label><select id="f-method">${opts(PAY_METHODS, o.payMethod)}</select></div>
          <div class="field"><label for="f-pay">Payment status</label><select id="f-pay">${opts(PAY_STATUS, o.payStatus)}</select></div>
        </div>
        <div class="field"><span class="lbl">DuitNow receipt</span>
          <div class="receipt-row"><span id="rcPrev">${receiptThumb(o)}</span>
            <label class="btn small" for="f-receipt">🧾 ${hasReceipt(o) ? "Change receipt" : "Add receipt"}</label>
            <input id="f-receipt" type="file" accept="image/*" hidden /></div>
          <div class="muted" id="rcMsg" style="font-size:.85rem"></div>
        </div>
        <div class="field"><label for="f-track">J&amp;T tracking no.</label>
          <div class="track-row"><input id="f-track" value="${esc(o.tracking || "")}" placeholder="Paste or scan" autocomplete="off" />
          <label class="btn small scan-btn" for="f-scan">📷 Scan</label></div>
          <input id="f-scan" type="file" accept="image/*" hidden />
          <div class="muted" id="scanMsg" style="font-size:.85rem">Photo of the airway bill, or a screenshot from the J&amp;T app.</div>
        </div>
        <div class="field"><label for="f-notes">Notes</label><textarea id="f-notes" rows="2" placeholder="Custom colour, pickup time…">${esc(o.notes)}</textarea></div>
        <div class="form-actions">
          <button type="button" class="btn" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn primary">Save Order</button>
        </div>
        ${isNew ? "" : `${wa ? `<div class="lbl" style="margin-top:16px">WhatsApp ${esc(o.customer)}</div><div class="quick-wa">
            <a class="btn small" target="_blank" rel="noopener" href="${waLink(o.phone, waMsg(o, "pay"))}">💳 Payment</a>
            <a class="btn small" target="_blank" rel="noopener" href="${waLink(o.phone, waMsg(o, "ready"))}">🌷 Ready</a>
            <a class="btn small" target="_blank" rel="noopener" href="${waLink(o.phone, waMsg(o, "posted"))}">📦 Posted</a>
          </div>` : ""}
          <button type="button" class="btn danger block" style="margin-top:12px" id="delOrder">Delete order</button>`}
      </form>`, (root) => {
      const box = $("#lineItems", root);
      const draw = () => {
        box.innerHTML = o.items.map((it, i) => `
          <div class="li-row">
            ${thumb(it, "li-thumb")}
            <select data-i="${i}" class="li-prod" aria-label="Product">${productOptions(it)}</select>
            <input data-i="${i}" class="li-qty" type="number" min="0" inputmode="numeric" value="${esc(it.qty)}" aria-label="Quantity" />
            <button type="button" class="x" data-i="${i}" aria-label="Remove item">✕</button>
          </div>`).join("") || `<div class="muted">No items yet.</div>`;
        sums();
      };
      const sums = () => {
        $("#subOut", root).textContent = rm(itemsTotal(o));
        $("#postLbl", root).textContent = o.delivery === "Self pickup" ? "Self pickup" : `Postage${o.delivery ? " (" + o.delivery + ")" : ""}`;
        $("#postOut", root).textContent = o.postage ? rm(o.postage) : "FREE";
        $("#totalOut", root).textContent = rm(orderTotal(o));
      };
      $("#f-delivery", root).addEventListener("change", (e) => {
        o.delivery = e.target.value; autoPostage();
        $("#addrField", root).hidden = o.delivery === "Self pickup";
        sums();
      });
      draw();
      box.addEventListener("change", (e) => {
        const i = Number(e.target.dataset.i);
        if (e.target.classList.contains("li-prod")) {
          const p = db.products.find((p) => p.id === e.target.value);
          if (p) o.items[i] = { ...o.items[i], productId: p.id, name: p.name, price: p.price };
          autoPostage(); draw();
          return;
        }
        autoPostage(); sums();
      });
      box.addEventListener("input", (e) => {
        if (e.target.classList.contains("li-qty")) {
          o.items[Number(e.target.dataset.i)].qty = Math.max(0, Number(e.target.value) || 0);
          autoPostage(); sums();
        }
      });
      box.addEventListener("click", (e) => {
        if (e.target.classList.contains("x")) { o.items.splice(Number(e.target.dataset.i), 1); autoPostage(); draw(); }
      });
      const add = $("#addItem", root);
      if (add) add.onclick = () => { const p = db.products[0]; o.items.push({ productId: p.id, name: p.name, price: p.price, qty: 1 }); autoPostage(); draw(); };
      $("#f-receipt", root).onchange = async (e) => {
        const file = e.target.files[0]; e.target.value = "";
        if (!file) return;
        const msg = $("#rcMsg", root);
        msg.textContent = "Saving receipt…";
        try {
          const r = await storeReceipt(file);
          o.receipt = r.id || ""; o.receiptData = r.data || "";
          $("#rcPrev", root).innerHTML = receiptThumb(o);
          $("#f-pay", root).value = "Paid";
          msg.textContent = "Receipt saved. Payment set to Paid — tap Save Order.";
        } catch (err) { msg.textContent = err && err.message ? err.message : "Could not save that picture. Try again."; }
      };
      $("#rcPrev", root).addEventListener("click", (e) => { if (e.target.closest("[data-receipt]")) { e.preventDefault(); viewReceipt(o); } });
      $("#f-scan", root).onchange = async (e) => {
        const file = e.target.files[0];
        e.target.value = "";
        if (!file) return;
        const msg = $("#scanMsg", root);
        msg.textContent = "Reading the tracking number…";
        const res = await readTracking(file);
        if (!root.isConnected) return;
        if (res.no) {
          $("#f-track", root).value = res.no;
          msg.textContent = `Found ${res.no}${res.how ? " (" + res.how + ")" : ""}. Check it, then tap Save.`;
          const posted = $('#f-status input[value="Posted"]', root);
          if (posted && ["New", "Making", "Ready"].includes(o.status)) posted.checked = true;
        } else {
          msg.textContent = res.why || "Could not find a tracking number. Type or paste it instead.";
        }
      };
      $("#cancelBtn", root).onclick = closeModal;
      const del = $("#delOrder", root);
      if (del) del.onclick = () => {
        ask(`Delete order ${o.code} (${o.customer})?`, "Delete", () => {
          db.orders = db.orders.filter((x) => x.id !== o.id); save(); rerender(); toast("Order deleted");
        });
      };
      $("#orderF", root).onsubmit = (e) => {
        e.preventDefault();
        o.customer = $("#f-customer", root).value.trim();
        o.phone = $("#f-phone", root).value.trim();
        o.date = $("#f-date", root).value;
        o.status = ($("#f-status input:checked", root) || {}).value || o.status;
        o.payMethod = $("#f-method", root).value;
        o.payStatus = $("#f-pay", root).value;
        o.notes = $("#f-notes", root).value.trim();
        o.address = o.delivery === "Self pickup" ? "" : $("#f-address", root).value.trim();
        o.wish = $("#f-wish", root).value.trim();
        o.tracking = $("#f-track", root).value.trim();
        if (o.tracking && o.status !== "Completed" && o.status !== "Cancelled") o.status = o.status === "Ready" || o.status === "Making" || o.status === "New" ? "Posted" : o.status;
        o.items = o.items.filter((i) => Number(i.qty) > 0);
        if (!o.customer || !o.date) return toast("Name and date are required");
        if (isNew) {
          o.code = (db.settings.prefix || "") + db.settings.nextNo++;
          o.createdAt = Date.now();
          db.orders.push(o);
        } else {
          db.orders[db.orders.findIndex((x) => x.id === o.id)] = o;
        }
        save(); closeModal(); rerender(); toast(isNew ? `Order ${o.code} added` : "Order saved");
      };
    });
  }

  // ---------- calendar ----------
  function calendar() {
    const now = new Date();
    if (!ui.calMonth) ui.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const y = ui.calMonth.getFullYear(), m = ui.calMonth.getMonth();
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const today = todayStr();
    const byDate = {};
    db.orders.forEach((o) => (byDate[o.date] ||= []).push(o));

    let cells = DOW.map((d) => `<div class="cal-dow">${d.toUpperCase()}</div>`).join("");
    for (let i = 0; i < first; i++) cells += `<div class="cal-cell blank"></div>`;
    for (let d = 1; d <= days; d++) {
      const key = `${y}-${pad(m + 1)}-${pad(d)}`;
      const list = (byDate[key] || []).filter((o) => o.status !== "Cancelled");
      cells += `<button class="cal-cell ${key === today ? "is-today" : ""} ${key === ui.calSel ? "sel" : ""}" data-day="${key}" aria-label="${d} ${MONTHS_FULL[m]}, ${list.length} orders">
        <span class="dn">${d}</span>
        ${list.slice(0, 2).map((o) => `<span class="cal-chip st-${o.status}">${esc(o.customer)}</span>`).join("")}
        ${list.length > 2 ? `<span class="cal-more">+${list.length - 2} more</span>` : ""}
      </button>`;
    }
    const sel = (byDate[ui.calSel] || []).slice().sort((a, b) => a.customer.localeCompare(b.customer));

    view.innerHTML = `
      <div class="page-head"><div><h1>Calendar</h1><p>Postage &amp; pickup schedule</p></div></div>
      <div class="cal-nav">
        <button class="btn" id="prevM" aria-label="Previous month">‹</button>
        <div class="month">${MONTHS_FULL[m]} ${y}</div>
        <button class="btn" id="nextM" aria-label="Next month">›</button>
        <button class="btn today" id="todayM">Today</button>
      </div>
      <div class="card" style="padding:10px"><div class="cal-grid">${cells}</div></div>
      <section class="card day-list">
        <div class="row-between"><h3>${esc(prettyDate(ui.calSel))}</h3><button class="btn small primary" id="addOnDay">+ Order</button></div>
        <div class="list" style="margin-top:12px">${sel.length ? sel.map(orderRow).join("") : `<div class="empty"><span class="bloom"></span>No orders on this day.</div>`}</div>
      </section>`;
    $("#prevM").onclick = () => { ui.calMonth = new Date(y, m - 1, 1); calendar(); };
    $("#nextM").onclick = () => { ui.calMonth = new Date(y, m + 1, 1); calendar(); };
    $("#todayM").onclick = () => { ui.calMonth = null; ui.calSel = todayStr(); calendar(); };
    $$("[data-day]").forEach((b) => (b.onclick = () => { ui.calSel = b.dataset.day; rerender(); }));
    $("#addOnDay").onclick = () => orderForm(null, ui.calSel);
    $$("[data-order]", view).forEach((b) => (b.onclick = () => orderForm(db.orders.find((o) => o.id === b.dataset.order))));
  }

  // ---------- generic simple CRUD (products / inventory / expenses) ----------
  function simpleForm({ title, item, fields, onSave, onDelete }) {
    openModal(title, `<form id="simpleF" autocomplete="off">
        ${fields.map((f) => `<div class="field"><label for="s-${f.key}">${esc(f.label)}</label>${
          f.type === "photo" ? `<div class="photo-pick"><span id="s-${f.key}-prev">${thumb(item, "prod-photo")}</span>
            <label class="btn small" for="s-${f.key}">📷 ${item[f.key] ? "Change photo" : "Add photo"}</label>
            ${item[f.key] ? `<button type="button" class="btn small" id="s-${f.key}-rm">Remove</button>` : ""}
            <input id="s-${f.key}" type="file" accept="image/*" hidden /></div>`
          : f.options ? `<select id="s-${f.key}">${opts(f.options, item[f.key])}</select>`
          : `<input id="s-${f.key}" type="${f.type || "text"}" ${f.type === "number" ? 'step="any" inputmode="decimal"' : ""} ${f.required ? "required" : ""} value="${esc(item[f.key])}" placeholder="${esc(f.placeholder || "")}" />`}</div>`).join("")}
        <div class="form-actions"><button type="button" class="btn" id="sCancel">Cancel</button><button class="btn primary">Save</button></div>
        ${onDelete ? `<button type="button" class="btn danger block" style="margin-top:12px" id="sDel">Delete</button>` : ""}
      </form>`, (root) => {
      const photos = {};
      fields.filter((f) => f.type === "photo").forEach((f) => {
        const show = (src) => { $(`#s-${f.key}-prev`, root).innerHTML = thumb({ img: src }, "prod-photo"); };
        $(`#s-${f.key}`, root).onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try { photos[f.key] = await shrinkPhoto(file); show(photos[f.key]); } catch { toast("Could not open that picture"); }
        };
        const rmb = $(`#s-${f.key}-rm`, root);
        if (rmb) rmb.onclick = () => { photos[f.key] = ""; show(""); };
      });
      $("#sCancel", root).onclick = closeModal;
      if (onDelete) $("#sDel", root).onclick = () => ask("Delete this item?", "Delete", () => { onDelete(); save(); rerender(); toast("Deleted"); });
      $("#simpleF", root).onsubmit = (e) => {
        e.preventDefault();
        const out = { ...item };
        fields.forEach((f) => {
          if (f.type === "photo") { if (f.key in photos) out[f.key] = photos[f.key]; return; }
          const v = $(`#s-${f.key}`, root).value; out[f.key] = f.type === "number" ? Number(v) || 0 : v.trim();
        });
        onSave(out); save(); closeModal(); rerender(); toast("Saved");
      };
    });
  }

  function crudPage({ title, sub, addLabel, list, row, form, extra = "" }) {
    view.innerHTML = `
      <div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div><button class="btn primary" id="addBtn">${addLabel}</button></div>${extra}
      <div class="list">${list.length ? list.map((x) => `<button class="item ${row(x).cls || ""}" data-id="${x.id}">${row(x).html}</button>`).join("") : `<div class="empty"><span class="bloom"></span>Nothing here yet.</div>`}</div>`;
    $("#addBtn").onclick = () => form(null);
    $$("[data-id]", view).forEach((b) => (b.onclick = () => form(list.find((x) => x.id === b.dataset.id))));
  }

  function products() {
    const sold = {};
    db.orders.filter((o) => o.status !== "Cancelled").forEach((o) => o.items.forEach((i) => (sold[i.productId] = (sold[i.productId] || 0) + Number(i.qty))));
    crudPage({
      title: "Products", sub: "Your blooms & prices", addLabel: "+ Product",
      extra: db.settings.productsSheet ? `<button class="btn block" id="pullProd" style="margin-bottom:14px">🔄 Update from products Sheet</button>` : "",
      list: db.products,
      row: (p) => ({ cls: "with-photo", html: `${thumb(p, "prod-photo")}<div>${p.category ? `<div class="cat">${esc(p.category)}</div>` : ""}<div class="title">${esc(p.name)}</div><div class="meta">${sold[p.id] || 0} sold</div></div><div class="right"><span class="amt">${rm(p.price)}</span></div>` }),
      form: (p) => simpleForm({
        title: p ? "Edit Product" : "New Product",
        item: p || { id: uid(), name: "", price: "", category: "LED" },
        fields: [{ key: "img", label: "Photo", type: "photo" }, { key: "name", label: "Name", required: true, placeholder: "e.g. Pink Daisy" }, { key: "category", label: "Type", options: ["LED", "USB + LED", "LED · Big size", "Custom", "Add-on"] }, { key: "price", label: "Price (RM)", type: "number", required: true }],
        onSave: (x) => { const i = db.products.findIndex((y) => y.id === x.id); i >= 0 ? (db.products[i] = x) : db.products.push(x); },
        onDelete: p && (() => { db.products = db.products.filter((y) => y.id !== p.id); }),
      }),
    });
    const pp = $("#pullProd");
    if (pp) pp.onclick = () => pullProducts(pp);
  }

  function inventory() {
    const list = [...db.inventory].sort((a, b) => (Number(a.qty) <= Number(a.min) ? 0 : 1) - (Number(b.qty) <= Number(b.min) ? 0 : 1) || a.name.localeCompare(b.name));
    crudPage({
      title: "Supplies", sub: "Materials & packaging stock", addLabel: "+ Item",
      list,
      row: (i) => {
        const low = Number(i.qty) <= Number(i.min);
        return { cls: low ? "low" : "", html: `<div><div class="title">${esc(i.name)}</div><div class="meta">Min ${esc(i.min)} ${esc(i.unit)}</div></div><div class="right"><span class="amt" ${low ? 'style="color:var(--red)"' : ""}>${esc(i.qty)} ${esc(i.unit)}</span>${low ? pill("pay-Unpaid", "Restock") : ""}</div>` };
      },
      form: (i) => simpleForm({
        title: i ? "Edit Stock" : "New Stock Item",
        item: i || { id: uid(), name: "", qty: "", unit: "pcs", min: "" },
        fields: [
          { key: "name", label: "Name", required: true, placeholder: "e.g. Pipe cleaner (pink)" },
          { key: "qty", label: "Quantity in stock", type: "number", required: true },
          { key: "unit", label: "Unit", placeholder: "kg, pcs, pack…" },
          { key: "min", label: "Alert when at or below", type: "number" },
        ],
        onSave: (x) => { const k = db.inventory.findIndex((y) => y.id === x.id); k >= 0 ? (db.inventory[k] = x) : db.inventory.push(x); },
        onDelete: i && (() => { db.inventory = db.inventory.filter((y) => y.id !== i.id); }),
      }),
    });
  }

  function expenses() {
    const list = [...db.expenses].sort((a, b) => b.date.localeCompare(a.date));
    const monthKey = todayStr().slice(0, 7);
    const total = db.expenses.filter((e) => e.date.slice(0, 7) === monthKey).reduce((t, e) => t + Number(e.amount || 0), 0);
    crudPage({
      title: "Expenses", sub: `This month: ${rm(total)}`, addLabel: "+ Expense",
      list,
      row: (e) => ({ html: `<div><div class="code">${esc(prettyDate(e.date))}</div><div class="title">${esc(e.desc)}</div><div class="meta">${esc(e.category)}</div></div><div class="right"><span class="amt">${rm(e.amount)}</span></div>` }),
      form: (e) => simpleForm({
        title: e ? "Edit Expense" : "New Expense",
        item: e || { id: uid(), date: todayStr(), desc: "", category: EXP_CATS[0], amount: "" },
        fields: [
          { key: "date", label: "Date", type: "date", required: true },
          { key: "desc", label: "Description", required: true, placeholder: "e.g. Pipe cleaner & LED" },
          { key: "category", label: "Category", options: EXP_CATS },
          { key: "amount", label: "Amount (RM)", type: "number", required: true },
        ],
        onSave: (x) => { const k = db.expenses.findIndex((y) => y.id === x.id); k >= 0 ? (db.expenses[k] = x) : db.expenses.push(x); },
        onDelete: e && (() => { db.expenses = db.expenses.filter((y) => y.id !== e.id); }),
      }),
    });
  }

  // ---------- monthly report ----------
  const monthKeyOf = (d) => ymd(d).slice(0, 7);
  function monthStats(key) {
    const orders = db.orders.filter((o) => o.status !== "Cancelled" && (o.date || "").slice(0, 7) === key);
    const sales = orders.reduce((t, o) => t + orderTotal(o), 0);
    const postage = orders.reduce((t, o) => t + (Number(o.postage) || 0), 0);
    const exps = db.expenses.filter((e) => (e.date || "").slice(0, 7) === key);
    const expenses = exps.reduce((t, e) => t + Number(e.amount || 0), 0);
    const lamps = {};
    orders.forEach((o) => o.items.filter((i) => !isAddon(i)).forEach((i) => {
      const k = i.name;
      lamps[k] = lamps[k] || { name: i.name, item: i, qty: 0, amount: 0 };
      lamps[k].qty += Number(i.qty) || 0; lamps[k].amount += (Number(i.qty) || 0) * (Number(i.price) || 0);
    }));
    const unpaid = orders.filter((o) => o.payStatus === "Unpaid");
    const byDelivery = {};
    orders.forEach((o) => { const d = o.delivery || "Not set"; byDelivery[d] = (byDelivery[d] || 0) + 1; });
    const byCat = {};
    exps.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount || 0); });
    return {
      orders, sales, postage, expenses, profit: sales - postage - expenses,
      lampsSold: Object.values(lamps).reduce((t, l) => t + l.qty, 0),
      top: Object.values(lamps).sort((a, b) => b.qty - a.qty || b.amount - a.amount),
      unpaid, unpaidTotal: unpaid.reduce((t, o) => t + orderTotal(o), 0), byDelivery, byCat,
    };
  }
  const change = (now, before, lowerIsBetter = false) => {
    if (!before && !now) return `<span class="chg flat">—</span>`;
    if (!before) return `<span class="chg up">new</span>`;
    const pct = Math.round(((now - before) / Math.abs(before)) * 100);
    const good = lowerIsBetter ? pct < 0 : pct > 0, bad = lowerIsBetter ? pct > 0 : pct < 0;
    return `<span class="chg ${good ? "up" : bad ? "down" : "flat"}">${pct > 0 ? "▲" : pct < 0 ? "▼" : "•"} ${Math.abs(pct)}%</span>`;
  };

  function report() {
    if (!ui.repMonth) ui.repMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const m = ui.repMonth, key = monthKeyOf(m);
    const prevD = new Date(m.getFullYear(), m.getMonth() - 1, 1);
    const a = monthStats(key), b = monthStats(monthKeyOf(prevD));
    const maxQty = Math.max(1, ...a.top.map((l) => l.qty));
    view.innerHTML = `
      <div class="page-head"><div><h1>Report</h1><p>How the month went</p></div></div>
      <div class="cal-nav">
        <button class="btn" id="rPrev" aria-label="Previous month">‹</button>
        <div class="month">${MONTHS_FULL[m.getMonth()]} ${m.getFullYear()}</div>
        <button class="btn" id="rNext" aria-label="Next month">›</button>
      </div>
      <div class="stats">
        <div class="stat" style="--c:var(--pink)"><div class="label">Sales</div><div class="value">${rm(a.sales)}</div><div class="sub">${change(a.sales, b.sales)} vs ${MONTHS[prevD.getMonth()]}</div></div>
        <div class="stat" style="--c:var(--green)"><div class="label">Profit</div><div class="value">${rm(a.profit)}</div><div class="sub">${change(a.profit, b.profit)} vs ${MONTHS[prevD.getMonth()]}</div></div>
        <div class="stat" style="--c:var(--yellow)"><div class="label">Lamps sold</div><div class="value">${a.lampsSold}</div><div class="sub">${a.orders.length} orders · ${change(a.lampsSold, b.lampsSold)}</div></div>
        <div class="stat" style="--c:var(--red)"><div class="label">Expenses</div><div class="value">${rm(a.expenses)}</div><div class="sub">${change(a.expenses, b.expenses, true)} vs ${MONTHS[prevD.getMonth()]}</div></div>
      </div>
      <section class="card">
        <h3>🏆 Best-selling lamps</h3>
        ${a.top.length ? `<div class="rank">${a.top.slice(0, 8).map((l, i) => `
          <div class="rank-row">${thumb(l.item)}<div class="rank-body"><div class="row-between"><span class="rank-name">${i + 1}. ${esc(l.name)}</span><span class="amt">${l.qty} sold</span></div>
            <div class="bar"><span style="width:${Math.round((l.qty / maxQty) * 100)}%"></span></div><div class="meta">${rm(l.amount)}</div></div></div>`).join("")}</div>`
          : `<div class="empty"><span class="bloom"></span>No lamps sold this month yet.</div>`}
      </section>
      <section class="card">
        <h3>Money</h3>
        <div class="kv"><span>Sales (incl. postage)</span><b>${rm(a.sales)}</b></div>
        <div class="kv"><span>Postage collected</span><b>− ${rm(a.postage)}</b></div>
        <div class="kv"><span>Expenses</span><b>− ${rm(a.expenses)}</b></div>
        ${Object.entries(a.byCat).map(([c, v]) => `<div class="kv sub"><span>${esc(c)}</span><span>${rm(v)}</span></div>`).join("")}
        <div class="kv total"><span>Profit</span><b>${rm(a.profit)}</b></div>
        <p class="muted" style="font-size:.85rem;margin:8px 0 0">Profit leaves out postage, since it is paid on to J&amp;T.</p>
      </section>
      <section class="card">
        <h3>Still to collect</h3>
        ${a.unpaid.length ? `<p style="margin:6px 0 10px"><b>${rm(a.unpaidTotal)}</b> from ${a.unpaid.length} unpaid order${a.unpaid.length > 1 ? "s" : ""}</p>
          <div class="list">${a.unpaid.map(orderRow).join("")}</div>` : `<p class="muted">Everyone has paid this month 🤍</p>`}
      </section>
      <section class="card">
        <h3>Delivery</h3>
        ${Object.keys(a.byDelivery).length ? Object.entries(a.byDelivery).map(([d, n]) => `<div class="kv"><span>${esc(d)}</span><b>${n} order${n > 1 ? "s" : ""}</b></div>`).join("") : `<p class="muted">No orders this month.</p>`}
      </section>`;
    $("#rPrev").onclick = () => { ui.repMonth = prevD; report(); };
    $("#rNext").onclick = () => { ui.repMonth = new Date(m.getFullYear(), m.getMonth() + 1, 1); report(); };
    $$("[data-order]", view).forEach((el) => (el.onclick = () => orderForm(db.orders.find((o) => o.id === el.dataset.order))));
  }

  // ---------- customers ----------
  const custKey = (o) => { const d = String(o.phone || "").replace(/\D/g, "").replace(/^6?0/, "0"); return d.length >= 9 ? "p" + d : "n" + (o.customer || "").trim().toLowerCase(); };
  function customerList() {
    const map = new Map();
    db.orders.filter((o) => o.status !== "Cancelled").forEach((o) => {
      const k = custKey(o);
      const c = map.get(k) || { key: k, name: o.customer, phone: o.phone, orders: [], total: 0, lamps: 0, last: "" };
      c.orders.push(o); c.total += orderTotal(o); c.lamps += lampCount(o);
      if ((o.date || "") >= c.last) { c.last = o.date || ""; c.name = o.customer || c.name; if (o.phone) c.phone = o.phone; }
      map.set(k, c);
    });
    return [...map.values()];
  }
  function customers() {
    const q = (ui.custSearch || "").trim().toLowerCase();
    const sort = ui.custSort || "total";
    let list = customerList();
    if (q) list = list.filter((c) => (c.name + " " + c.phone).toLowerCase().includes(q));
    list.sort((a, b) => sort === "recent" ? b.last.localeCompare(a.last) : sort === "orders" ? b.orders.length - a.orders.length || b.total - a.total : b.total - a.total);
    const repeat = customerList().filter((c) => c.orders.length > 1).length;
    view.innerHTML = `
      <div class="page-head"><div><h1>Customers</h1><p>${customerList().length} customers · ${repeat} came back again</p></div></div>
      <div class="tabs">${[["total", "Top spend"], ["orders", "Most orders"], ["recent", "Recent"]].map(([k, l]) => `<button class="${k === sort ? "on" : ""}" data-sort="${k}">${l}</button>`).join("")}</div>
      <input class="search" id="custSearch" type="search" placeholder="Search name or phone…" value="${esc(ui.custSearch || "")}" />
      <div class="list">${list.length ? list.map((c) => `
        <button class="item" data-cust="${esc(c.key)}">
          <div><div class="title">${esc(c.name)} ${c.orders.length > 1 ? `<span class="pill st-Ready">♥ ${c.orders.length}× customer</span>` : ""}</div>
            <div class="meta">${c.phone ? esc(c.phone) + " · " : ""}${c.lamps} lamp${c.lamps === 1 ? "" : "s"} · last ${esc(prettyDate(c.last))}</div></div>
          <div class="right"><span class="amt">${rm(c.total)}</span><span class="meta">${c.orders.length} order${c.orders.length > 1 ? "s" : ""}</span></div>
        </button>`).join("") : `<div class="empty"><span class="bloom"></span>No customers yet.</div>`}</div>`;
    $$("[data-sort]").forEach((b) => (b.onclick = () => { ui.custSort = b.dataset.sort; customers(); }));
    const s = $("#custSearch");
    s.oninput = () => { ui.custSearch = s.value; customers(); const n = $("#custSearch"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
    $$("[data-cust]").forEach((b) => (b.onclick = () => customerSheet(customerList().find((c) => c.key === b.dataset.cust))));
  }
  function customerSheet(c) {
    if (!c) return;
    const wa = waLink(c.phone, `Hi ${c.name}! 🌷 `);
    const fav = {};
    c.orders.forEach((o) => o.items.filter((i) => !isAddon(i)).forEach((i) => (fav[i.name] = (fav[i.name] || 0) + Number(i.qty || 0))));
    const favs = Object.entries(fav).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, q]) => `${esc(n)} ×${q}`).join(", ");
    openModal(c.name, `
      <div class="kv"><span>Phone</span><b>${esc(c.phone || "—")}</b></div>
      <div class="kv"><span>Total spent</span><b>${rm(c.total)}</b></div>
      <div class="kv"><span>Orders</span><b>${c.orders.length}</b></div>
      <div class="kv"><span>Favourites</span><b style="text-align:right">${favs || "—"}</b></div>
      ${wa ? `<a class="btn primary block" style="margin:14px 0" target="_blank" rel="noopener" href="${wa}">💬 WhatsApp ${esc(c.name)}</a>` : ""}
      <div class="lbl" style="margin:10px 0 8px">Orders</div>
      <div class="list">${[...c.orders].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map(orderRow).join("")}</div>`, (root) => {
      $$("[data-order]", root).forEach((el) => (el.onclick = () => orderForm(db.orders.find((o) => o.id === el.dataset.order))));
    });
  }

  // ---------- settings ----------
  function settings() {
    const s = db.settings;
    view.innerHTML = `
      <div class="page-head"><div><h1>Settings</h1><p>Business info &amp; backup</p></div></div>
      <form class="card" id="setF">
        <div class="field"><label for="st-b">Business name</label><input id="st-b" value="${esc(s.business)}" required /></div>
        <div class="field"><label for="st-o">Your name</label><input id="st-o" value="${esc(s.owner)}" /></div>
        <div class="grid2">
          <div class="field"><label for="st-p">Order code prefix</label><input id="st-p" value="${esc(s.prefix)}" /></div>
          <div class="field"><label for="st-n">Next number</label><input id="st-n" type="number" value="${esc(s.nextNo)}" /></div>
        </div>
        <div class="grid2">
          <div class="field"><label for="st-sm">Postage Semenanjung (RM/lamp)</label><input id="st-sm" type="number" inputmode="decimal" value="${esc(s.postSM ?? 10)}" /></div>
          <div class="field"><label for="st-ss">Postage Sabah/Sarawak (RM/lamp)</label><input id="st-ss" type="number" inputmode="decimal" value="${esc(s.postSS ?? 45)}" /></div>
        </div>
        <div class="field"><label for="st-os">Website orders Sheet (link)</label><input id="st-os" value="${esc(s.ordersSheet || "")}" placeholder="https://docs.google.com/spreadsheets/d/…" /></div>
        <div class="field"><label for="st-ps">Products Sheet (link)</label><input id="st-ps" value="${esc(s.productsSheet || "")}" placeholder="https://docs.google.com/spreadsheets/d/…" /></div>
        <button class="btn primary block">Save settings</button>
      </form>
      <section class="card">
        <h3>Wallpaper</h3>
        <p class="muted" style="margin:4px 0 12px">The background behind every page.</p>
        <div class="seg" id="wallSeg">${WALLS.map(([k, l]) => `<label><input type="radio" name="wall" value="${k}" ${(s.wall || "bloom") === k ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>
        <div id="wallPhoto" ${(s.wall || "bloom") === "photo" ? "" : "hidden"}>
          <div class="photo-pick">
            ${s.wallImg ? `<img class="wall-prev" src="${esc(s.wallImg)}" alt="Current wallpaper" />` : ""}
            <label class="btn small" for="wallFile">📷 ${s.wallImg ? "Change photo" : "Choose photo"}</label>
            <input id="wallFile" type="file" accept="image/*" hidden />
          </div>
          <p class="muted" style="font-size:.85rem;margin:8px 0 0">The photo is softened so text stays easy to read.</p>
        </div>
      </section>
      <section class="card">
        <h3>Backup</h3>
        <p class="muted">Data is stored only on this phone/browser. Export regularly so you don't lose it.</p>
        <div class="form-actions"><button class="btn" id="exp">⬇️ Export</button><label class="btn" for="imp">⬆️ Import</label></div>
        <input type="file" id="imp" accept="application/json,.json" hidden />
      </section>
      <section class="card">
        <h3>Danger zone</h3>
        <div class="form-actions"><button class="btn" id="demo">Load demo data</button><button class="btn danger" id="wipe">Erase all</button></div>
      </section>`;
    $("#wallSeg").onchange = (e) => {
      s.wall = e.target.value;
      $("#wallPhoto").hidden = s.wall !== "photo";
      if (s.wall === "photo" && !s.wallImg) { $("#wallFile").click(); return; }
      save(); applyWall();
    };
    $("#wallFile").onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      try { s.wallImg = await shrinkPhoto(f, 1000, true, 0.7); s.wall = "photo"; save(); applyWall(); settings(); toast("Wallpaper updated"); }
      catch { toast("Could not open that picture"); }
    };
    $("#setF").onsubmit = (e) => {
      e.preventDefault();
      s.business = $("#st-b").value.trim() || "My Shop";
      s.owner = $("#st-o").value.trim();
      s.prefix = $("#st-p").value.trim();
      s.nextNo = Number($("#st-n").value) || s.nextNo;
      s.postSM = Number($("#st-sm").value) || 0;
      s.postSS = Number($("#st-ss").value) || 0;
      s.ordersSheet = $("#st-os").value.trim();
      s.productsSheet = $("#st-ps").value.trim();
      save(); refreshBrand(); toast("Settings saved");
    };
    $("#exp").onclick = async () => {
      const filename = `${(s.business || "backup").replace(/\W+/g, "-").toLowerCase()}-${todayStr()}.json`;
      const json = JSON.stringify(db, null, 2);
      if (hasClaudeApi()) {
        const dl = await window.claude.use("downloads");
        if (!dl) return toast("Export is not available here");
        try { await dl.save({ filename, data: json }); toast("Backup saved"); } catch (err) { if (err && err.code !== "declined") toast("Could not save the backup"); }
        return;
      }
      const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $("#imp").onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data || !Array.isArray(data.orders) || !data.settings) throw new Error("bad");
        e.target.value = "";
        ask("Replace all current data with this backup?", "Restore", () => { db = { ...emptyDb(), ...data }; save(); route(); toast("Backup restored"); });
      } catch { toast("That file is not a valid backup"); }
    };
    $("#demo").onclick = () => ask("Replace everything with demo data?", "Load demo", () => { db = seed(); save(); route(); toast("Demo data loaded"); });
    $("#wipe").onclick = () => {
      ask("Erase ALL orders, products, stock and expenses? This cannot be undone.", "Erase all", () => {
        db = { settings: { ...s, nextNo: 1001 }, products: [], inventory: [], expenses: [], orders: [] };
        save(); route(); toast("All data erased");
      });
    };
  }

  route();
  boot();
})();
