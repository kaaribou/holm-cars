/* HOLM Cars Card — entretien, dépenses, carburant, recharges et statistiques de vos voitures.
 * Fait partie de HOLM — Home Orchestration & Living Management. https://github.com/kaaribou/holm-cars — licence MIT
 *   type: custom:holm-cars-card
 *   title: Garage        view: full | vehicle        vehicle: <id> (view: vehicle)        show_frame: true
 */
(() => {
const VERSION = "1.0.1";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => iso(new Date());
const pdate = (s) => { if (!s) return null; const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const fdate = (s, o = { day: "numeric", month: "short", year: "numeric" }) => { const d = pdate(s); return d ? d.toLocaleDateString("fr-FR", o) : ""; };
const nf = (v, d = 0) => (v == null || isNaN(v) ? "–" : Number(v).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }));
const km = (v) => (v == null ? "–" : `${nf(v)} km`);
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const num = (v) => { if (v === "" || v == null) return null; const n = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return isNaN(n) ? null : n; };
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

const TYPES = {
  entretien: { l: "Entretien", i: "mdi:wrench", c: "#0abfbf" },
  reparation: { l: "Réparation", i: "mdi:car-wrench", c: "#f97316" },
  amelioration: { l: "Équipement", i: "mdi:star-four-points-outline", c: "#a78bfa" },
  carburant: { l: "Carburant", i: "mdi:gas-station", c: "#e3a21a" },
  recharge: { l: "Recharge", i: "mdi:ev-station", c: "#22c55e" },
  frais: { l: "Frais", i: "mdi:file-document-outline", c: "#60a5fa" },
  km: { l: "Relevé km", i: "mdi:counter", c: "#94a3b8" },
};
const COST_TYPES = ["entretien", "reparation", "amelioration", "carburant", "recharge", "frais"];
const ENERGY = { essence: "Essence", diesel: "Diesel", electrique: "Électrique", hybride: "Hybride", hybride_rechargeable: "Hybride rechargeable", gpl: "GPL", e85: "Superéthanol E85" };
const PRESETS = {
  entretien: ["Vidange + filtres", "Révision", "Contrôle technique", "Pneus", "Plaquettes de frein", "Disques de frein", "Courroie de distribution", "Batterie", "Climatisation", "Essuie-glaces", "Liquide de refroidissement", "Géométrie / parallélisme", "Lavage"],
  reparation: ["Carrosserie", "Pare-brise", "Embrayage", "Échappement", "Électronique", "Démarreur", "Alternateur", "Amortisseurs"],
  amelioration: ["Attelage", "Autoradio / GPS", "Barres de toit", "Câble de recharge", "Tapis", "Pneus hiver"],
  frais: ["Assurance", "Carte grise", "Péage", "Parking", "Crédit / LOA", "Amende", "Abonnement recharge"],
};
const REM_PRESETS = [
  { title: "Contrôle technique", every_months: 24, record: "entretien" },
  { title: "Vidange + filtres", every_months: 12, every_km: 15000, record: "entretien" },
  { title: "Révision", every_months: 12, every_km: 20000, record: "entretien" },
  { title: "Courroie de distribution", every_months: 72, every_km: 120000, record: "entretien" },
  { title: "Pneus été / hiver", every_months: 6, record: "entretien" },
  { title: "Échéance assurance", every_months: 12, record: "frais" },
  { title: "Liquide de frein", every_months: 24, record: "entretien" },
];

// Garde la position de défilement pendant un rendu complet (iOS : la page ne remonte pas).
const keepScroll = (host, fn) => {
  const saved = [];
  let n = host;
  while (n) { n = n.assignedSlot || n.parentNode || n.host; if (n && n.nodeType === 1 && n.scrollHeight > n.clientHeight) saved.push([n, n.scrollTop]); }
  const se = document.scrollingElement; if (se) saved.push([se, se.scrollTop]);
  const h = host.offsetHeight; if (h) host.style.minHeight = `${h}px`;
  try { fn(); } finally {
    const restore = () => saved.forEach(([el, t]) => { if (Math.abs(el.scrollTop - t) > 1) el.scrollTop = t; });
    restore();
    let done = false;
    const release = () => { if (done) return; done = true; restore(); host.style.minHeight = ""; requestAnimationFrame(restore); };
    requestAnimationFrame(release); setTimeout(release, 500);
  }
};

class HolmCarsCard extends HTMLElement {
  setConfig(c) {
    this._c = { title: "Garage", view: "full", ...c };
    this._tab = this._tab || "home";
    this._filter = this._filter || "all";
    this._period = this._period || "12m";
    this._q = this._q || "";
    if (this._c.vehicle) this._vid = this._c.vehicle;
    if (this.shadowRoot) this._render();
  }
  set hass(h) {
    this._hass = h;
    if (!this.shadowRoot) { this.attachShadow({ mode: "open" }); this._render(); }
    if (!this._sub && h.connection) this._subscribe();
  }
  connectedCallback() { if (this._hass && !this._sub) this._subscribe(); }
  disconnectedCallback() { if (this._sub) { this._sub.then((u) => u && u()).catch(() => {}); this._sub = null; } }
  _subscribe() {
    this._sub = this._hass.connection.subscribeMessage((m) => { this._s = m.state; this._fixVid(); this._update(); }, { type: "holm_cars/subscribe" });
    this._sub.catch((e) => { this._err = e && e.code === "unknown_command" ? "L'intégration HOLM Cars n'est pas installée ou pas encore chargée." : (e && e.message) || String(e); this._sub = null; this._render(); });
  }
  _fixVid() {
    const vs = this._vehicles();
    if (!vs.length) { this._vid = null; return; }
    if (!this._vid || !this._s.vehicles[this._vid]) this._vid = (vs.find((v) => !v.archived) || vs[0]).id;
  }
  _vehicles() { return this._s ? Object.values(this._s.vehicles).sort((a, b) => (!!a.archived - !!b.archived) || (b.year || 0) - (a.year || 0) || String(a.name).localeCompare(b.name)) : []; }
  _veh() { return this._s && this._vid ? this._s.vehicles[this._vid] : null; }
  _recs(vid = this._vid, types = null) { return Object.values(this._s.records).filter((r) => r.vehicle_id === vid && (!types || types.includes(r.type))).sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.odometer || 0) - (a.odometer || 0)); }
  _rems(vid = this._vid) {
    const rank = { overdue: 0, soon: 1, ok: 2 };
    return Object.values(this._s.reminders).filter((r) => r.vehicle_id === vid).sort((a, b) => rank[a.state] - rank[b.state] || (a.days_left ?? 1e9) - (b.days_left ?? 1e9) || (a.km_left ?? 1e12) - (b.km_left ?? 1e12));
  }
  _cur() { return (this._s && this._s.settings.currency) || "€"; }
  _money(v, d = 0) { return v == null ? "–" : `${nf(v, d)} ${this._cur()}`; }
  _isAdmin() { return !!(this._hass && this._hass.user && this._hass.user.is_admin); }
  _ws(type, data = {}) { return this._hass.callWS({ type: `holm_cars/${type}`, ...data }); }
  _toast(msg) { const ev = new Event("hass-notification", { bubbles: true, composed: true }); ev.detail = { message: msg }; (document.querySelector("home-assistant") || this).dispatchEvent(ev); }
  async _do(p, ok) { try { const r = await p; if (ok) this._toast(ok); return r; } catch (e) { this._toast(`HOLM Cars : ${(e && e.message) || e}`); throw e; } }

  // ------------------------------------------------------------ fichiers (liens signés)
  _signed(name) {
    this._sig = this._sig || {};
    const hit = this._sig[name];
    if (hit && hit.exp > Date.now()) return hit.url;
    if (!hit || !hit.pending) {
      this._sig[name] = { pending: true, exp: 0, url: hit && hit.url };
      this._hass.callWS({ type: "auth/sign_path", path: `/api/holm_cars/file/${name}`, expires: 86400 })
        .then((r) => { this._sig[name] = { url: r.path, exp: Date.now() + 86000 * 1000 }; this._applySigned(name); })
        .catch(() => { this._sig[name] = { exp: Date.now() + 60000, url: "" }; });
    }
    return (hit && hit.url) || "";
  }
  _img(name) { if (!name) return ""; const u = this._signed(name); return `data-sig="${esc(name)}" style="${u ? `background-image:url('${esc(u)}')` : ""}"`; }
  _applySigned(name) {
    const url = this._sig[name] && this._sig[name].url;
    if (!url) return;
    const sel = `[data-sig="${String(name).replace(/"/g, "")}"]`;
    [this.shadowRoot].forEach((r) => r && r.querySelectorAll(sel).forEach((el) => {
      if (el.tagName === "A") el.href = url; else if (el.tagName === "IMG") el.src = url; else el.style.backgroundImage = `url('${url}')`;
    }));
  }
  async _upload(file) {
    const fd = new FormData(); fd.append("file", file, file.name);
    const r = await this._hass.fetchWithAuth("/api/holm_cars/upload", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || `Envoi impossible (${r.status})`);
    return j;
  }

  // ------------------------------------------------------------ rendu
  _update() {
    const a = this.shadowRoot && this.shadowRoot.activeElement;
    if (a && a.matches("input.search")) return; // pendant la saisie : pas de rendu complet
    this._render();
    if (this._refreshModal) this._refreshModal();
  }
  _render() { if (!this.shadowRoot || !this._c) return; keepScroll(this, () => this._renderNow()); }
  _renderNow() {
    const c = this._c, s = this._s;
    let body, tabs = "";
    if (this._err) body = `<div class="empty">${esc(this._err)}</div>`;
    else if (!s) body = `<div class="empty">Chargement…</div>`;
    else if (!this._vehicles().length) body = this._welcome();
    else if (c.view === "vehicle") body = this._compact();
    else {
      const T = [["home", "mdi:car-info", "Tableau de bord"], ["log", "mdi:history", "Historique"], ["rem", "mdi:bell-ring-outline", "Rappels"], ["stats", "mdi:chart-box-outline", "Insights"], ["set", "mdi:cog-outline", "Réglages"]];
      const alerts = this._rems().filter((r) => r.state !== "ok").length;
      tabs = `<div class="tabs">${T.map(([k, i, l]) => `<button class="tab ${this._tab === k ? "on" : ""}" data-tab="${k}" title="${l}"><ha-icon icon="${i}"></ha-icon><span>${l}</span>${k === "rem" && alerts ? `<em>${alerts}</em>` : ""}</button>`).join("")}</div>`;
      const view = { home: this._home, log: this._log, rem: this._remView, stats: this._stats, set: this._settings }[this._tab] || this._home;
      body = (this._tab === "set" ? "" : this._garageBar()) + view.call(this);
    }
    const keepModal = this.shadowRoot.querySelector(".modal-root");
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
      <ha-card class="${c.show_frame === false ? "noframe" : ""}">
        ${c.view === "vehicle" ? "" : `<div class="hd"><div class="tt"><ha-icon icon="mdi:car-multiple"></ha-icon>${esc(c.title)}</div>${tabs}</div>`}
        <div class="bd">${body}</div>
      </ha-card>`;
    if (keepModal) this.shadowRoot.appendChild(keepModal);
    this._bind();
  }

  _welcome() {
    return `<div class="welcome"><ha-icon icon="mdi:car-side"></ha-icon><h3>Bienvenue dans HOLM Cars</h3>
      <p>Ajoutez votre première voiture, ou récupérez tout votre garage depuis LubeLogger.</p>
      ${this._isAdmin() ? `<div class="row center"><button class="pill main" data-act="add-vehicle"><ha-icon icon="mdi:plus"></ha-icon>Ajouter une voiture</button>
      <button class="pill" data-act="import"><ha-icon icon="mdi:database-import-outline"></ha-icon>Importer depuis LubeLogger</button></div>` : `<p class="muted">Un administrateur doit ajouter les voitures.</p>`}</div>`;
  }

  // barre du garage : une vignette par voiture
  _garageBar() {
    const vs = this._vehicles();
    return `<div class="garage">${vs.map((v) => {
      const n = (v.summary || {}).next;
      const dot = n && n.state !== "ok" ? `<i class="dot ${n.state}"></i>` : "";
      return `<button class="gv ${v.id === this._vid ? "on" : ""} ${v.archived ? "arch" : ""}" data-vid="${v.id}">
        <span class="gph ${v.image ? "" : "no"}" ${this._img(v.image)}>${v.image ? "" : `<ha-icon icon="${v.energy === "electrique" ? "mdi:car-electric" : "mdi:car-hatchback"}"></ha-icon>`}</span>
        <span class="gtx"><small>${esc(v.year || "")}${v.archived ? " · vendue" : ""}</small><b>${esc(v.make || v.name)}</b><span>${esc(v.model || "")}</span>${v.plate ? `<code>${esc(v.plate)}</code>` : ""}</span>${dot}</button>`;
    }).join("")}${this._isAdmin() ? `<button class="gv add" data-act="add-vehicle" title="Ajouter une voiture"><ha-icon icon="mdi:plus"></ha-icon><span>Ajouter</span></button>` : ""}</div>`;
  }

  // ------------------------------------------------------------ tableau de bord
  _home() {
    const v = this._veh(); if (!v) return "";
    const sm = v.summary || {}, cons = sm.consumption;
    const rems = this._rems().slice(0, 4);
    const recs = this._recs().filter((r) => r.type !== "km").slice(0, 6);
    const y = new Date().getFullYear();
    const byType = {};
    this._recs(v.id, COST_TYPES).filter((r) => (r.date || "").startsWith(String(y))).forEach((r) => { byType[r.type] = (byType[r.type] || 0) + (r.cost || 0); });
    const elec = v.energy === "electrique";
    return `<div class="hero">
        <div class="hph ${v.image ? "" : "no"}" ${this._img(v.image)}>${v.image ? "" : `<ha-icon icon="mdi:car-side"></ha-icon>`}
          <div class="hov"><div><small>${esc([v.year, ENERGY[v.energy]].filter(Boolean).join(" · "))}</small><h2>${esc(v.name)}</h2>${v.plate ? `<code>${esc(v.plate)}</code>` : ""}</div>
          ${this._isAdmin() ? `<button class="ib glass" data-act="edit-vehicle" title="Modifier la voiture"><ha-icon icon="mdi:pencil"></ha-icon></button>` : ""}</div></div>
        <div class="tiles">
          ${this._tile("mdi:counter", km(sm.odometer), "Kilométrage", v.odometer_entity ? "relevé automatique" : `<button class="lnk" data-new="km">Nouveau relevé</button>`)}
          ${this._tile("mdi:cash", this._money(sm.cost_year), `Dépensé en ${y}`, Object.keys(byType).length ? this._miniBar(byType) : "aucune dépense")}
          ${this._tile("mdi:cash-marker", sm.cost_per_km != null ? `${nf(sm.cost_per_km, 2)} ${this._cur()}` : "–", "Coût au km", "tout compris, hors achat")}
          ${this._tile(elec ? "mdi:ev-station" : "mdi:gas-station", cons ? nf(cons.avg, 1) : "–", cons ? cons.unit : "Consommation", cons ? `dernière : ${nf(cons.last, 1)}` : elec ? "après 2 recharges complètes" : "après 2 pleins complets")}
        </div>
      </div>
      <div class="qa">
        ${[["entretien", "Entretien"], [elec ? "recharge" : "carburant", elec ? "Recharge" : "Plein"], ["reparation", "Réparation"], ["frais", "Frais"], ["km", "Relevé km"]].map(([t, l]) => `<button class="qb" data-new="${t}" style="--c:${TYPES[t].c}"><ha-icon icon="${TYPES[t].i}"></ha-icon><span>${l}</span></button>`).join("")}
      </div>
      <div class="cols">
        <section><div class="sh"><h4>À venir</h4><button class="lnk" data-act="add-rem"><ha-icon icon="mdi:plus"></ha-icon>Rappel</button></div>
          ${rems.length ? rems.map((r) => this._remRow(r, true)).join("") : `<div class="empty sm">Aucun rappel. Ajoutez le prochain contrôle technique ou la prochaine vidange : vous serez prévenu à l'avance.</div>`}
          ${this._rems().length > 4 ? `<button class="lnk more" data-tab="rem">Tous les rappels →</button>` : ""}</section>
        <section><div class="sh"><h4>Dernières opérations</h4><button class="lnk" data-tab="log">Historique →</button></div>
          ${recs.length ? `<div class="tl">${recs.map((r) => this._recRow(r)).join("")}</div>` : `<div class="empty sm">Rien pour l'instant : ajoutez un entretien, un plein ou une dépense avec les boutons ci-dessus.</div>`}</section>
      </div>`;
  }
  _tile(icon, val, label, sub) { return `<div class="tile"><ha-icon icon="${icon}"></ha-icon><b>${val}</b><span>${label}</span><small>${sub || ""}</small></div>`; }
  _miniBar(byType) {
    const tot = Object.values(byType).reduce((a, b) => a + b, 0) || 1;
    return `<span class="mbar">${Object.entries(byType).map(([t, v]) => `<i style="width:${(v / tot) * 100}%;background:${TYPES[t].c}" title="${TYPES[t].l} : ${this._money(v)}"></i>`).join("")}</span>`;
  }

  _recRow(r) {
    const t = TYPES[r.type] || TYPES.entretien, f = r.fuel || {};
    const fuel = (r.type === "carburant" || r.type === "recharge") && f.qty ? `${nf(f.qty, r.type === "recharge" ? 1 : 2)} ${r.type === "recharge" ? "kWh" : "L"}` : "";
    const sub = [fdate(r.date), r.odometer != null ? km(r.odometer) : "", fuel].filter(Boolean).join(" · ");
    return `<button class="rr" data-rec="${r.id}" style="--c:${t.c}"><span class="ri"><ha-icon icon="${t.i}"></ha-icon></span>
      <span class="rt"><b>${esc(r.title || t.l)}</b><small>${sub}${r.source === "auto" ? " · auto" : ""}${(r.files || []).length ? ` · <ha-icon class="clip" icon="mdi:paperclip"></ha-icon>${r.files.length}` : ""}</small></span>
      ${r.type !== "km" ? `<span class="rc">${this._money(r.cost, r.cost % 1 ? 2 : 0)}</span>` : ""}</button>`;
  }

  _remRow(r, compact = false) {
    const parts = [];
    if (r.days_left != null) parts.push(r.days_left < 0 ? `dépassé de ${-r.days_left} j` : r.days_left === 0 ? "aujourd'hui" : r.days_left < 60 ? `dans ${r.days_left} j` : fdate(r.due_date, { day: "numeric", month: "long", year: "numeric" }));
    if (r.km_left != null) parts.push(r.km_left <= 0 ? `dépassé de ${nf(-r.km_left)} km` : `dans ${nf(r.km_left)} km`);
    const est = r.km_left != null && r.estimated_date && r.days_left == null && r.km_left > 0 ? ` · vers le ${fdate(r.estimated_date, { day: "numeric", month: "short" })}` : "";
    let pct = null;
    const last = (r.history || []).slice(-1)[0];
    if (r.days_left != null && r.due_date) {
      const due = pdate(r.due_date);
      const start = last ? pdate(last.date) : r.every_months ? new Date(due.getFullYear(), due.getMonth() - r.every_months, due.getDate()) : r.created ? new Date(r.created * 1000) : null;
      if (start) { const tot = (due - start) / 864e5; pct = tot > 0 ? 1 - r.days_left / tot : null; }
    } else if (r.km_left != null && r.due_km) {
      const startKm = last && last.odometer != null ? last.odometer : r.every_km ? r.due_km - r.every_km : null;
      if (startKm != null) { const tot = r.due_km - startKm; pct = tot > 0 ? 1 - r.km_left / tot : null; }
    }
    pct = pct == null ? null : Math.max(0.03, Math.min(1, pct));
    const icon = r.state === "overdue" ? "mdi:alert-circle" : r.state === "soon" ? "mdi:clock-alert-outline" : "mdi:calendar-check";
    const every = !compact && (r.every_months || r.every_km) ? ` · tous les ${[r.every_months ? `${r.every_months} mois` : "", r.every_km ? `${nf(r.every_km)} km` : ""].filter(Boolean).join(" / ")}` : "";
    return `<div class="rem ${r.state}">
      <button class="rmain" data-rem="${r.id}"><ha-icon icon="${icon}"></ha-icon><span class="rt"><b>${esc(r.title)}</b><small>${parts.join(" · ") || "—"}${est}${every}</small>
      ${pct != null ? `<span class="prog"><i style="width:${pct * 100}%"></i></span>` : ""}</span></button>
      <button class="pill sm" data-done="${r.id}"><ha-icon icon="mdi:check"></ha-icon>Fait</button></div>`;
  }

  // ------------------------------------------------------------ historique
  _log() {
    const v = this._veh(); if (!v) return "";
    const elec = v.energy === "electrique";
    const F = [["all", "Tout"], ["entretien", "Entretien"], ["reparation", "Réparations"], [elec ? "recharge" : "carburant", elec ? "Recharges" : "Carburant"], ["frais", "Frais"], ["amelioration", "Équipement"], ["km", "Relevés"]];
    return `<div class="bar"><div class="chips">${F.map(([k, l]) => `<button class="chip ${this._filter === k ? "on" : ""}" data-filter="${k}" ${k !== "all" ? `style="--c:${TYPES[k].c}"` : ""}>${l}</button>`).join("")}</div>
        <input class="search" placeholder="Rechercher…" value="${esc(this._q)}"></div>
      <div class="lst">${this._logList()}</div>`;
  }
  _logList() {
    const v = this._veh();
    const q = norm(this._q);
    let recs;
    if (this._filter === "carburant" || this._filter === "recharge") recs = this._recs(v.id, ["carburant", "recharge"]);
    else recs = this._recs().filter((r) => (this._filter === "all" ? r.type !== "km" : r.type === this._filter));
    if (q) recs = recs.filter((r) => norm(`${r.title} ${r.notes} ${(r.tags || []).join(" ")} ${r.category || ""} ${TYPES[r.type].l}`).includes(q));
    const groups = {};
    const lim = this._lim || 40;
    recs.slice(0, lim).forEach((r) => { const k = (r.date || "").slice(0, 7); (groups[k] = groups[k] || []).push(r); });
    const more = recs.length - lim;
    const total = recs.reduce((a, r) => a + (COST_TYPES.includes(r.type) ? r.cost || 0 : 0), 0);
    return `<div class="lsum"><span>${recs.length} opération${recs.length > 1 ? "s" : ""}</span><b>${this._money(total)}</b>
        <button class="pill sm" data-act="new-any"><ha-icon icon="mdi:plus"></ha-icon>Ajouter</button></div>
      ${recs.length ? Object.entries(groups).map(([k, rs]) => {
        const [yy, mm] = k.split("-");
        const sum = rs.reduce((a, r) => a + (COST_TYPES.includes(r.type) ? r.cost || 0 : 0), 0);
        return `<div class="mg"><div class="mh"><span>${MONTHS[Number(mm) - 1] || ""} ${yy}</span><span>${sum ? this._money(sum) : ""}</span></div><div class="tl">${rs.map((r) => this._recRow(r)).join("")}</div></div>`;
      }).join("") + (more > 0 ? `<button class="pill more2" data-act="more">Afficher la suite · ${more} de plus</button>` : "") : `<div class="empty">Aucune opération${q ? " pour cette recherche" : ""}.</div>`}`;
  }

  // ------------------------------------------------------------ rappels
  _remView() {
    const rems = this._rems();
    const done = rems.flatMap((r) => (r.history || []).map((h) => ({ ...h, title: r.title }))).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
    const sugg = REM_PRESETS.map((p, i) => ({ ...p, i })).filter((p) => !rems.some((r) => norm(r.title) === norm(p.title)));
    return `<div class="sh"><h4>Rappels · ${esc(this._veh().name)}</h4><button class="pill sm main" data-act="add-rem"><ha-icon icon="mdi:plus"></ha-icon>Nouveau rappel</button></div>
      ${rems.length ? rems.map((r) => this._remRow(r)).join("") : `<div class="empty">Aucun rappel pour cette voiture.</div>`}
      ${sugg.length ? `<div class="sh"><h4>Suggestions</h4></div><div class="chips">${sugg.map((p) => `<button class="chip" data-preset="${p.i}">+ ${esc(p.title)}</button>`).join("")}</div>` : ""}
      ${done.length ? `<div class="sh"><h4>Derniers passages</h4></div><div class="tl">${done.map((h) => `<div class="rr flat" style="--c:#0abfbf"><span class="ri"><ha-icon icon="mdi:check"></ha-icon></span><span class="rt"><b>${esc(h.title)}</b><small>${fdate(h.date)}${h.odometer != null ? ` · ${km(h.odometer)}` : ""}</small></span></div>`).join("")}</div>` : ""}
      <div class="hint">Vous êtes prévenu ${this._s.settings.notify_days} jours ou ${nf(this._s.settings.notify_km)} km avant l'échéance (réglable pour chaque rappel, et dans Réglages).</div>`;
  }

  // ------------------------------------------------------------ vue compacte (une voiture)
  _compact() {
    const v = this._veh(); if (!v) return `<div class="empty">Voiture introuvable.</div>`;
    const sm = v.summary || {}, n = this._rems()[0], elec = v.energy === "electrique";
    return `<div class="cmp">
      <div class="cph ${v.image ? "" : "no"}" ${this._img(v.image)}>${v.image ? "" : `<ha-icon icon="mdi:car-side"></ha-icon>`}</div>
      <div class="ctx"><small>${esc(v.year || "")}${v.plate ? ` · ${esc(v.plate)}` : ""}</small><b>${esc(v.name)}</b>
        <span>${km(sm.odometer)} · ${this._money(sm.cost_year)} en ${new Date().getFullYear()}</span></div></div>
      ${n ? this._remRow(n, true) : ""}
      <div class="qa sm">${[["entretien", "Entretien"], [elec ? "recharge" : "carburant", elec ? "Recharge" : "Plein"], ["frais", "Frais"], ["km", "Km"]].map(([t, l]) => `<button class="qb" data-new="${t}" style="--c:${TYPES[t].c}"><ha-icon icon="${TYPES[t].i}"></ha-icon><span>${l}</span></button>`).join("")}</div>`;
  }

  // ------------------------------------------------------------ insights
  _periodRange() {
    const now = new Date(), p = this._period;
    if (p === "12m") return [iso(new Date(now.getFullYear(), now.getMonth() - 11, 1)), todayIso(), "12 derniers mois"];
    if (p === "all") return ["0000-01-01", "9999-12-31", "depuis le début"];
    return [`${p}-01-01`, `${p}-12-31`, `en ${p}`];
  }
  _months(from, to) {
    const out = []; let d = pdate(from), end = pdate(to);
    d = new Date(d.getFullYear(), d.getMonth(), 1);
    while (d <= end && out.length < 240) { out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
    return out;
  }
  // kilomètres parcourus par mois (relevés interpolés en fin de mois)
  _kmByMonth(vid, months) {
    const pts = Object.values(this._s.records).filter((r) => r.vehicle_id === vid && r.odometer != null && r.date).map((r) => [pdate(r.date).getTime(), r.odometer]).sort((a, b) => a[0] - b[0]);
    const v = this._s.vehicles[vid];
    if (v && v.purchase_date && v.initial_odometer != null) pts.unshift([pdate(v.purchase_date).getTime(), v.initial_odometer]);
    for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1]) pts[i] = [pts[i][0], pts[i - 1][1]]; // relevé incohérent : on ne recule pas
    if (pts.length < 2) return months.map(() => null);
    const at = (t) => {
      if (t < pts[0][0] || t > pts[pts.length - 1][0]) return null;
      let i = pts.findIndex((p) => p[0] >= t); if (i <= 0) return pts[0][1];
      const [t0, o0] = pts[i - 1], [t1, o1] = pts[i];
      return t1 === t0 ? o1 : o0 + ((o1 - o0) * (t - t0)) / (t1 - t0);
    };
    return months.map((m) => {
      const [y, mm] = m.split("-").map(Number);
      const a = at(new Date(y, mm - 1, 1).getTime()), b = at(Math.min(new Date(y, mm, 1).getTime(), pts[pts.length - 1][0]));
      const a2 = a == null && new Date(y, mm - 1, 1).getTime() < pts[0][0] && new Date(y, mm, 1).getTime() > pts[0][0] ? pts[0][1] : a;
      return a2 != null && b != null ? Math.max(0, b - a2) : null;
    });
  }
  _stats() {
    const v = this._veh(); if (!v) return "";
    const all = this._scope === "all";
    const vids = all ? this._vehicles().map((x) => x.id) : [v.id];
    const [from, to, label] = this._periodRange();
    const years = [...new Set(Object.values(this._s.records).filter((r) => vids.includes(r.vehicle_id)).map((r) => (r.date || "").slice(0, 4)).filter(Boolean))].sort().reverse();
    const inP = (r) => r.date >= from && r.date <= to;
    const recs = Object.values(this._s.records).filter((r) => vids.includes(r.vehicle_id) && inP(r));
    const costs = recs.filter((r) => COST_TYPES.includes(r.type));
    const total = costs.reduce((a, r) => a + (r.cost || 0), 0);
    const firstDate = costs.map((r) => r.date).sort()[0];
    const months = this._months(this._period === "all" ? (firstDate || todayIso()) : from, this._period === "all" || this._period === "12m" ? todayIso() : (to > todayIso() ? todayIso() : to));
    const byMonth = months.map((m) => { const o = {}; costs.filter((r) => r.date.startsWith(m)).forEach((r) => { o[r.type] = (o[r.type] || 0) + (r.cost || 0); }); return o; });
    const byType = {}; costs.forEach((r) => { byType[r.type] = (byType[r.type] || 0) + (r.cost || 0); });
    const kmM = vids.map((id) => this._kmByMonth(id, months)).reduce((acc, arr) => acc.map((x, i) => (x == null && arr[i] == null ? null : (x || 0) + (arr[i] || 0))), months.map(() => null));
    const kmTot = kmM.reduce((a, b) => a + (b || 0), 0);
    const energyRecs = recs.filter((r) => (r.type === "carburant" || r.type === "recharge") && r.fuel && r.fuel.qty);
    const fuelCost = energyRecs.reduce((a, r) => a + (r.cost || 0), 0);
    const elecOnly = vids.every((id) => this._s.vehicles[id].energy === "electrique");
    const unit = elecOnly ? "kWh" : "L";
    const qty = energyRecs.filter((r) => (r.type === "recharge") === elecOnly).reduce((a, r) => a + r.fuel.qty, 0);
    const priceU = qty ? energyRecs.filter((r) => (r.type === "recharge") === elecOnly).reduce((a, r) => a + (r.cost || 0), 0) / qty : null;
    const nMonths = Math.max(1, months.length);
    // consommation et prix unitaire dans le temps (voiture sélectionnée)
    const cons = this._consSeries(v.id).filter((p) => p.date >= from && p.date <= to);
    const priceSeries = this._recs(v.id, [v.energy === "electrique" ? "recharge" : "carburant"]).filter((r) => inP(r) && r.fuel && r.fuel.qty && r.cost).map((r) => ({ date: r.date, value: r.cost / r.fuel.qty })).reverse();
    // postes les plus coûteux
    const top = {}; costs.filter((r) => r.type !== "carburant" && r.type !== "recharge").forEach((r) => { const k = r.title || TYPES[r.type].l; top[k] = top[k] || { t: r.type, v: 0, n: 0 }; top[k].v += r.cost || 0; top[k].n++; });
    const topL = Object.entries(top).sort((a, b) => b[1].v - a[1].v).slice(0, 6);
    // dépenses à venir (12 mois) : rappels, avec le coût moyen des passages précédents
    const upcoming = this._upcoming(vids);
    const vehOpts = this._vehicles().length > 1;
    return `<div class="bar"><div class="chips">
        ${[["12m", "12 mois"], ...years.slice(0, 5).map((y) => [y, y]), ["all", "Tout"]].map(([k, l]) => `<button class="chip ${this._period === k ? "on" : ""}" data-period="${k}">${l}</button>`).join("")}</div>
        ${vehOpts ? `<div class="seg"><button class="${all ? "" : "on"}" data-scope="one">${esc(v.make || v.name)}</button><button class="${all ? "on" : ""}" data-scope="all">Toutes</button></div>` : ""}</div>
      <div class="kpis">
        ${this._kpi(this._money(total), `Dépensé ${label}`, `${this._money(total / nMonths)} / mois`)}
        ${this._kpi(kmTot ? km(Math.round(kmTot)) : "–", "Kilomètres parcourus", kmTot ? `${nf(kmTot / nMonths)} km / mois` : "ajoutez des relevés")}
        ${this._kpi(kmTot > 100 ? `${nf(total / kmTot, 2)} ${this._cur()}` : "–", "Coût au km", kmTot > 100 ? `dont énergie ${nf(fuelCost / kmTot, 2)} ${this._cur()}` : "")}
        ${this._kpi(this._money(fuelCost), elecOnly ? "Recharges" : "Carburant", qty ? `${nf(qty, 0)} ${unit} · ${nf(priceU, elecOnly ? 3 : 3)} ${this._cur()}/${unit}` : "")}
        ${!all && cons.length ? this._kpi(nf(cons.reduce((a, p) => a + p.value, 0) / cons.length, 1), cons.unit || (v.energy === "electrique" ? "kWh/100 km" : "L/100 km"), `${cons.length} mesures`) : ""}
        ${this._kpi(String(costs.length), "Opérations", `${costs.filter((r) => r.type === "entretien" || r.type === "reparation").length} entretiens et réparations`)}
      </div>
      <div class="charts">
        <section class="card2 wide"><h4>Dépenses par mois</h4>${this._stack(months, byMonth)}<div class="legend">${COST_TYPES.filter((t) => byType[t]).map((t) => `<span><i style="background:${TYPES[t].c}"></i>${TYPES[t].l}</span>`).join("")}</div></section>
        <section class="card2"><h4>Répartition</h4>${this._donut(byType, total)}</section>
        <section class="card2"><h4>Kilomètres par mois</h4>${this._bars(months, kmM, "#0abfbf", (x) => km(Math.round(x)))}</section>
        ${!all ? `<section class="card2"><h4>Consommation <small>${v.energy === "electrique" ? "kWh/100 km" : "L/100 km"}</small></h4>${this._line(cons, "#e3a21a", 1)}</section>
        <section class="card2"><h4>Prix ${v.energy === "electrique" ? "du kWh" : "du litre"}</h4>${this._line(priceSeries, "#22c55e", 3)}</section>` : ""}
        <section class="card2"><h4>Plus gros postes</h4>${topL.length ? `<div class="toplist">${topL.map(([k, o]) => `<div><i style="background:${TYPES[o.t].c}"></i><span>${esc(k)}${o.n > 1 ? ` <small>×${o.n}</small>` : ""}</span><b>${this._money(o.v)}</b></div>`).join("")}</div>` : `<div class="empty sm">Aucune dépense sur la période.</div>`}</section>
        <section class="card2"><h4>À prévoir sur 12 mois</h4>${upcoming.items.length ? `<div class="toplist">${upcoming.items.map((u) => `<div><i style="background:${u.state === "overdue" ? "#ef4444" : u.state === "soon" ? "#f59e0b" : "#0abfbf"}"></i><span>${esc(u.title)}${all ? ` <small>${esc(u.car)}</small>` : ""}<small> · ${u.when}</small></span><b>${u.cost != null ? `≈ ${this._money(u.cost)}` : "?"}</b></div>`).join("")}</div><div class="hint">Estimation d'après le coût de vos passages précédents : ≈ ${this._money(upcoming.total)}.</div>` : `<div class="empty sm">Aucune échéance dans les 12 mois.</div>`}</section>
        ${all ? this._compare() : ""}
      </div>`;
  }
  _consSeries(vid) {
    const v = this._s.vehicles[vid]; const kind = v.energy === "electrique" ? "recharge" : "carburant";
    const recs = this._recs(vid, [kind]).filter((r) => r.odometer != null && r.fuel && r.fuel.qty).reverse();
    const out = []; let acc = 0, last = null;
    recs.forEach((r) => {
      if (r.fuel.missed) { acc = 0; last = null; }
      acc += r.fuel.qty;
      if (r.fuel.full !== false) { if (last && r.odometer > last.odometer) out.push({ date: r.date, value: (acc / (r.odometer - last.odometer)) * 100 }); last = r; acc = 0; }
    });
    out.unit = kind === "recharge" ? "kWh/100 km" : "L/100 km";
    return out;
  }
  _upcoming(vids) {
    const lim = new Date(); lim.setFullYear(lim.getFullYear() + 1);
    const items = [];
    vids.forEach((id) => this._rems(id).forEach((r) => {
      const ds = [r.due_date, r.km_left != null ? r.estimated_date : null].filter(Boolean).map(pdate); const d = ds.length ? new Date(Math.min(...ds)) : null;
      if (!d || d > lim) return;
      const past = this._recs(id).filter((x) => (x.reminder_id === r.id || norm(x.title) === norm(r.title)) && x.cost);
      const cost = past.length ? past.slice(0, 3).reduce((a, x) => a + x.cost, 0) / Math.min(3, past.length) : null;
      items.push({ title: r.title, car: this._s.vehicles[id].make || this._s.vehicles[id].name, state: r.state, d, when: r.state === "overdue" ? "en retard" : fdate(iso(d), { month: "short", year: "numeric" }), cost });
    }));
    items.sort((a, b) => a.d - b.d);
    return { items: items.slice(0, 8), total: items.reduce((a, u) => a + (u.cost || 0), 0) };
  }
  _compare() {
    const rows = this._vehicles().map((v) => {
      const recs = this._recs(v.id, COST_TYPES);
      const tot = recs.reduce((a, r) => a + (r.cost || 0), 0);
      const first = recs.map((r) => r.date).sort()[0];
      const years = first ? Math.max(1 / 12, (Date.now() - pdate(first)) / (365.25 * 864e5)) : null;
      return { v, tot, perYear: years ? tot / years : null, cpk: (v.summary || {}).cost_per_km };
    });
    const max = Math.max(...rows.map((r) => r.perYear || 0), 1);
    return `<section class="card2 wide"><h4>Comparaison des voitures <small>dépense moyenne par an</small></h4><div class="cmpbars">${rows.map((r) => `<div class="cb"><span class="cn">${esc(r.v.name)}</span><span class="ct"><i style="width:${((r.perYear || 0) / max) * 100}%"></i></span><b>${r.perYear != null ? this._money(r.perYear) : "–"}</b><small>${r.cpk != null ? `${nf(r.cpk, 2)} ${this._cur()}/km` : ""}</small></div>`).join("")}</div></section>`;
  }
  _kpi(v, l, s) { return `<div class="kpi"><b>${v}</b><span>${l}</span><small>${s || ""}</small></div>`; }

  // --- petits graphiques SVG
  _stack(months, data) {
    const W = 1000, H = 200, P = 34, n = months.length || 1;
    const totals = data.map((o) => Object.values(o).reduce((a, b) => a + b, 0));
    const max = Math.max(...totals, 1), bw = Math.max(3, (W - P) / n * 0.68), step = (W - P) / n;
    const lab = (i) => { const [y, m] = months[i].split("-"); return n <= 14 || i % Math.ceil(n / 12) === 0 ? `<text x="${P + i * step + step / 2}" y="${H + 14}" text-anchor="middle">${MONTHS[Number(m) - 1].replace(".", "")}${n > 14 || m === "01" ? ` ${y.slice(2)}` : ""}</text>` : ""; };
    let bars = "";
    data.forEach((o, i) => {
      let y = H;
      COST_TYPES.forEach((t) => { if (!o[t]) return; const h = (o[t] / max) * (H - 10); y -= h; bars += `<rect x="${P + i * step + (step - bw) / 2}" y="${y}" width="${bw}" height="${Math.max(h, 0.5)}" rx="2" fill="${TYPES[t].c}"><title>${months[i]} · ${TYPES[t].l} : ${this._money(o[t])}</title></rect>`; });
      if (totals[i] && n <= 14) bars += `<text class="v" x="${P + i * step + step / 2}" y="${y - 4}" text-anchor="middle">${nf(totals[i])}</text>`;
    });
    return `<svg class="ch" viewBox="0 0 ${W} ${H + 20}">${[0.5, 1].map((f) => `<line x1="${P}" x2="${W}" y1="${H - f * (H - 10)}" y2="${H - f * (H - 10)}" class="grid"/><text x="0" y="${H - f * (H - 10) + 4}">${nf(max * f)}</text>`).join("")}${bars}${months.map((_, i) => lab(i)).join("")}</svg>`;
  }
  _bars(months, vals, color, fmt) {
    if (!vals.some((x) => x)) return `<div class="empty sm">Pas assez de relevés kilométriques.</div>`;
    const W = 520, H = 170, n = months.length || 1, step = W / n, bw = Math.max(2, step * 0.65), max = Math.max(...vals.map((x) => x || 0), 1);
    return `<svg class="ch" viewBox="0 0 ${W} ${H + 16}">${vals.map((x, i) => x ? `<rect x="${i * step + (step - bw) / 2}" y="${H - (x / max) * (H - 8)}" width="${bw}" height="${(x / max) * (H - 8)}" rx="2" fill="${color}"><title>${months[i]} : ${fmt(x)}</title></rect>` : "").join("")}
      ${months.map((m, i) => (i % Math.ceil(n / 6) === 0 ? `<text x="${i * step + step / 2}" y="${H + 13}" text-anchor="middle">${MONTHS[Number(m.split("-")[1]) - 1].replace(".", "")}</text>` : "")).join("")}</svg>
      <div class="chs">max ${fmt(max)} · moyenne ${fmt(vals.reduce((a, b) => a + (b || 0), 0) / Math.max(1, vals.filter((x) => x).length))}</div>`;
  }
  _line(series, color, dec) {
    if (series.length < 2) return `<div class="empty sm">Pas encore assez de données.</div>`;
    const W = 520, H = 170, vals = series.map((p) => p.value);
    const lo = Math.min(...vals), hi = Math.max(...vals), rng = hi - lo || 1;
    const t0 = pdate(series[0].date).getTime(), t1 = pdate(series[series.length - 1].date).getTime(), tr = t1 - t0 || 1;
    const pts = series.map((p) => [((pdate(p.date).getTime() - t0) / tr) * (W - 8) + 4, H - 8 - ((p.value - lo) / rng) * (H - 20)]);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return `<svg class="ch" viewBox="0 0 ${W} ${H}"><path d="${d} L${pts[pts.length - 1][0]},${H} L${pts[0][0]},${H} Z" fill="${color}" opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
      ${pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" fill="${color}"><title>${fdate(series[i].date)} : ${nf(series[i].value, dec)}</title></circle>`).join("")}</svg>
      <div class="chs">min ${nf(lo, dec)} · moy. ${nf(avg, dec)} · max ${nf(hi, dec)}</div>`;
  }
  _donut(byType, total) {
    if (!total) return `<div class="empty sm">Aucune dépense sur la période.</div>`;
    const R = 46, C = 2 * Math.PI * R; let off = 0;
    const segs = COST_TYPES.filter((t) => byType[t]).map((t) => { const f = byType[t] / total; const s = `<circle r="${R}" cx="60" cy="60" fill="none" stroke="${TYPES[t].c}" stroke-width="16" stroke-dasharray="${f * C} ${C}" stroke-dashoffset="${-off * C}" transform="rotate(-90 60 60)"><title>${TYPES[t].l} : ${this._money(byType[t])}</title></circle>`; off += f; return s; }).join("");
    return `<div class="donut"><svg viewBox="0 0 120 120">${segs}<text x="60" y="58" text-anchor="middle" class="dt">${nf(total)}</text><text x="60" y="74" text-anchor="middle" class="ds">${this._cur()}</text></svg>
      <div class="dl">${COST_TYPES.filter((t) => byType[t]).sort((a, b) => byType[b] - byType[a]).map((t) => `<div><i style="background:${TYPES[t].c}"></i><span>${TYPES[t].l}</span><b>${nf((byType[t] / total) * 100)} %</b></div>`).join("")}</div></div>`;
  }

  // ------------------------------------------------------------ réglages
  _settings() {
    const s = this._s.settings;
    const notifs = Object.keys((this._hass.services || {}).notify || {}).filter((k) => !["send_message", "persistent_notification"].includes(k)).sort();
    const admin = this._isAdmin();
    return `<div class="set">
      <section class="card2"><h4><ha-icon icon="mdi:bell-outline"></ha-icon>Notifications des rappels</h4>
        <div class="grid2">
          <label>Prévenir avant (jours)<input class="f" type="number" min="0" data-s="notify_days" value="${s.notify_days}"></label>
          <label>ou avant (km)<input class="f" type="number" min="0" step="100" data-s="notify_km" value="${s.notify_km}"></label>
          <label>Heure de l'envoi<input class="f" type="number" min="0" max="23" data-s="notify_hour" value="${s.notify_hour}"></label>
          <label class="chk"><input type="checkbox" data-s="persistent" ${s.persistent ? "checked" : ""}> Notification dans Home Assistant</label>
        </div>
        <div class="lbl">Envoyer aussi sur</div>
        <div class="chips">${notifs.length ? notifs.map((n) => `<label class="chip chk2 ${s.notify_targets.includes(`notify.${n}`) ? "on" : ""}"><input type="checkbox" data-target="notify.${n}" ${s.notify_targets.includes(`notify.${n}`) ? "checked" : ""}>${esc(n.replace(/^mobile_app_/, "📱 ").replace(/_/g, " "))}</label>`).join("") : `<span class="muted">Aucun service de notification.</span>`}</div>
        ${admin ? `<div class="row end"><button class="pill main" data-act="save-settings"><ha-icon icon="mdi:content-save"></ha-icon>Enregistrer</button></div>` : `<div class="muted">Réservé aux administrateurs.</div>`}
      </section>
      <section class="card2"><h4><ha-icon icon="mdi:database-import-outline"></ha-icon>Importer depuis LubeLogger</h4>
        <p class="muted">Récupérez vos voitures, entretiens, réparations, pleins, frais, relevés et rappels. Relancer l'import met à jour sans créer de doublons.</p>
        <div class="row"><button class="pill main" data-act="import" ${admin ? "" : "disabled"}><ha-icon icon="mdi:api"></ha-icon>Par l'API LubeLogger</button>
        <button class="pill" data-act="import-csv"><ha-icon icon="mdi:file-delimited-outline"></ha-icon>Par un fichier CSV</button></div>
      </section>
      <section class="card2"><h4><ha-icon icon="mdi:information-outline"></ha-icon>Dans Home Assistant</h4>
        <p class="muted">Chaque voiture a ses entités : kilométrage, prochain entretien, dépenses de l'année, coût au km, consommation et « Entretien à prévoir ». Un évènement <code>holm_cars_reminder</code> est émis à chaque alerte, pour vos automatisations.</p>
        <p class="muted">HOLM Cars ${VERSION} · <a href="https://github.com/kaaribou/holm-cars" target="_blank" rel="noopener">GitHub</a></p></section>
    </div>`;
  }

  // ------------------------------------------------------------ événements
  _bind() {
    const r = this.shadowRoot;
    const on = (sel, fn) => r.querySelectorAll(sel).forEach((el) => el.addEventListener("click", (e) => { e.stopPropagation(); fn(el, e); }));
    on("[data-tab]", (el) => { this._tab = el.dataset.tab; this._render(); });
    on("[data-vid]", (el) => { this._vid = el.dataset.vid; this._render(); });
    on("[data-filter]", (el) => { this._filter = el.dataset.filter; this._lim = 40; this._render(); });
    const lb = r.querySelector(".lst"); if (lb) { const m = lb.querySelector('[data-act="more"]'); if (m) m.addEventListener("click", () => { this._lim = (this._lim || 40) + 60; lb.innerHTML = this._logList(); this._bindList(lb); }); }
    on("[data-period]", (el) => { this._period = el.dataset.period; this._render(); });
    on("[data-scope]", (el) => { this._scope = el.dataset.scope; this._render(); });
    on("[data-new]", (el) => this._recordModal({ type: el.dataset.new }));
    on("[data-rec]", (el) => this._recordModal(this._s.records[el.dataset.rec]));
    on("[data-rem]", (el) => this._reminderModal(this._s.reminders[el.dataset.rem]));
    on("[data-done]", (el) => this._doneModal(this._s.reminders[el.dataset.done]));
    on("[data-preset]", (el) => { const p = REM_PRESETS[Number(el.dataset.preset)]; this._reminderModal({ title: p.title, every_months: p.every_months, every_km: p.every_km, record_type: p.record }); });
    on('[data-act="add-vehicle"]', () => this._vehicleModal({}));
    on('[data-act="edit-vehicle"]', () => this._vehicleModal(this._veh()));
    on('[data-act="add-rem"]', () => this._reminderModal({}));
    on('[data-act="new-any"]', () => this._recordModal({ type: this._filter !== "all" ? this._filter : "entretien" }));
    on('[data-act="import"]', () => this._importModal());
    on('[data-act="import-csv"]', () => this._csvModal());
    on('[data-act="save-settings"]', () => {
      const s = {};
      r.querySelectorAll("[data-s]").forEach((i) => { s[i.dataset.s] = i.type === "checkbox" ? i.checked : i.value; });
      s.notify_targets = [...r.querySelectorAll("[data-target]")].filter((i) => i.checked).map((i) => i.dataset.target);
      this._do(this._ws("settings/save", { settings: s }), "Réglages enregistrés");
    });
    r.querySelectorAll("[data-target]").forEach((i) => i.addEventListener("change", () => i.closest(".chip").classList.toggle("on", i.checked)));
    const q = r.querySelector("input.search");
    if (q) q.addEventListener("input", () => { this._q = q.value; const box = r.querySelector(".lst"); if (box) { box.innerHTML = this._logList(); this._bindList(box); } });
  }
  _bindList(box) {
    box.querySelectorAll("[data-rec]").forEach((el) => el.addEventListener("click", () => this._recordModal(this._s.records[el.dataset.rec])));
    const m = box.querySelector('[data-act="more"]'); if (m) m.addEventListener("click", () => { this._lim = (this._lim || 40) + 60; box.innerHTML = this._logList(); this._bindList(box); });
    const n = box.querySelector('[data-act="new-any"]'); if (n) n.addEventListener("click", () => this._recordModal({ type: this._filter !== "all" ? this._filter : "entretien" }));
  }

  // ------------------------------------------------------------ fenêtres
  _modal(title, html, opts = {}) {
    this._close();
    const root = document.createElement("div");
    root.className = "modal-root";
    root.innerHTML = `<div class="ov"><div class="mdl ${opts.wide ? "wide" : ""}"><div class="mh2"><b>${title}</b><button class="ib mclose"><ha-icon icon="mdi:close"></ha-icon></button></div><div class="mb">${html}</div></div></div>`;
    this.shadowRoot.appendChild(root);
    root.querySelector(".ov").addEventListener("click", (e) => { if (e.target.classList.contains("ov")) this._close(); });
    root.querySelector(".mclose").addEventListener("click", () => this._close());
    return root.querySelector(".mb");
  }
  _close() { const r = this.shadowRoot && this.shadowRoot.querySelector(".modal-root"); if (r) r.remove(); this._refreshModal = null; }
  _val(mb, name) { const el = mb.querySelector(`[name="${name}"]`); if (!el) return undefined; return el.type === "checkbox" ? el.checked : el.value.trim(); }
  _entities(filter) {
    return Object.values(this._hass.states).filter(filter).map((s) => s.entity_id).sort();
  }
  _entityField(label, name, value, filter, help = "") {
    const id = `dl-${name}`;
    return `<label class="full">${label}<input class="f" name="${name}" list="${id}" value="${esc(value || "")}" placeholder="aucune">
      <datalist id="${id}">${this._entities(filter).map((e) => `<option value="${e}">${esc((this._hass.states[e].attributes || {}).friendly_name || e)}</option>`).join("")}</datalist>${help ? `<small>${help}</small>` : ""}</label>`;
  }

  // --- voiture
  _vehicleModal(v) {
    const isNew = !v.id, ch = v.charge || {};
    const unitIs = (s, units) => units.includes(String((s.attributes || {}).unit_of_measurement || "").toLowerCase());
    let image = v.image || "";
    const mb = this._modal(isNew ? "Nouvelle voiture" : `Modifier · ${esc(v.name)}`, `
      <div class="vimg ${image ? "" : "no"}" ${this._img(image)}><label class="pill sm glass"><ha-icon icon="mdi:camera"></ha-icon>Photo<input type="file" accept="image/*" hidden name="photo"></label></div>
      <div class="grid2">
        <label>Marque<input class="f" name="make" value="${esc(v.make || "")}" placeholder="Dacia"></label>
        <label>Modèle<input class="f" name="model" value="${esc(v.model || "")}" placeholder="Sandero"></label>
        <label>Année<input class="f" name="year" type="number" value="${esc(v.year || "")}"></label>
        <label>Immatriculation<input class="f" name="plate" value="${esc(v.plate || "")}" placeholder="AB-123-CD"></label>
        <label>Énergie<select class="f" name="energy">${Object.entries(ENERGY).map(([k, l]) => `<option value="${k}" ${(v.energy || "essence") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Nom affiché<input class="f" name="name" value="${esc(isNew ? "" : v.name || "")}" placeholder="marque et modèle"></label>
        <label>Kilométrage à l'achat<input class="f" name="initial_odometer" type="number" value="${esc(v.initial_odometer ?? "")}"></label>
        <label>VIN<input class="f" name="vin" value="${esc(v.vin || "")}"></label>
        <label>Date d'achat<input class="f" name="purchase_date" type="date" value="${esc(v.purchase_date || "")}"></label>
        <label>Prix d'achat<input class="f" name="purchase_price" type="number" step="0.01" value="${esc(v.purchase_price ?? "")}"></label>
      </div>
      <details ${v.odometer_entity || ch.energy_entity ? "open" : ""}><summary><ha-icon icon="mdi:car-connected"></ha-icon>Voiture connectée</summary>
        <div class="grid2">
          ${this._entityField("Compteur kilométrique", "odometer_entity", v.odometer_entity, (s) => s.entity_id.startsWith("sensor.") && (unitIs(s, ["km", "mi"]) || (s.attributes || {}).device_class === "distance"), "Le kilométrage se met à jour tout seul.")}
          <div class="echarge ${["electrique", "hybride_rechargeable"].includes(v.energy) ? "" : "hide"}">
            <div class="lbl">Recharges automatiques</div>
            <div class="grid2">
              ${this._entityField("En charge (état)", "charging_entity", ch.charging_entity, (s) => /^(binary_sensor|sensor|switch)\./.test(s.entity_id) && /charg/i.test(`${s.entity_id} ${(s.attributes || {}).friendly_name || ""} ${(s.attributes || {}).device_class || ""}`))}
              ${this._entityField("Énergie chargée (kWh)", "energy_entity", ch.energy_entity, (s) => s.entity_id.startsWith("sensor.") && unitIs(s, ["kwh", "wh"]))}
              <label>Ce compteur est<select class="f" name="energy_mode"><option value="total" ${ch.energy_mode !== "session" ? "selected" : ""}>cumulé (total depuis toujours)</option><option value="session" ${ch.energy_mode === "session" ? "selected" : ""}>par recharge (repart de zéro)</option></select></label>
              <label>Prix du kWh (${this._cur()})<input class="f" name="price" type="number" step="0.0001" value="${esc(ch.price ?? "")}" placeholder="0,2016"></label>
              ${this._entityField("ou prix depuis une entité", "price_entity", ch.price_entity, (s) => s.entity_id.startsWith("sensor.") && /kwh/i.test((s.attributes || {}).unit_of_measurement || "") && /€|eur/i.test((s.attributes || {}).unit_of_measurement || ""))}
              ${this._entityField("Niveau de batterie (%)", "soc_entity", ch.soc_entity, (s) => s.entity_id.startsWith("sensor.") && (s.attributes || {}).device_class === "battery")}
            </div>
            <small class="muted">Chaque fin de charge crée une recharge : énergie, coût, kilométrage.</small>
          </div>
        </div></details>
      ${!isNew ? `<details ${v.archived ? "open" : ""}><summary><ha-icon icon="mdi:archive-outline"></ha-icon>Vente</summary><div class="grid2">
        <label>Date de vente<input class="f" name="sold_date" type="date" value="${esc(v.sold_date || "")}"></label>
        <label>Prix de vente<input class="f" name="sold_price" type="number" step="0.01" value="${esc(v.sold_price ?? "")}"></label>
        <label class="chk"><input type="checkbox" name="archived" ${v.archived ? "checked" : ""}> Voiture vendue (grisée dans le garage)</label></div></details>` : ""}
      <div class="row end">${!isNew ? `<button class="pill danger" data-x="del"><ha-icon icon="mdi:delete-outline"></ha-icon>Supprimer</button><span class="sp"></span>` : ""}
        <button class="pill main" data-x="save"><ha-icon icon="mdi:check"></ha-icon>${isNew ? "Ajouter" : "Enregistrer"}</button></div>`, { wide: true });
    const sel = mb.querySelector('[name="energy"]');
    sel.addEventListener("change", () => mb.querySelector(".echarge").classList.toggle("hide", !["electrique", "hybride_rechargeable"].includes(sel.value)));
    mb.querySelector('[name="photo"]').addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const box = mb.querySelector(".vimg"); box.classList.add("busy");
      try { const up = await this._do(this._upload(f)); image = up.name; box.classList.remove("no"); box.style.backgroundImage = `url('${URL.createObjectURL(f)}')`; }
      finally { box.classList.remove("busy"); }
    });
    mb.querySelector('[data-x="save"]').addEventListener("click", async () => {
      const g = (n) => this._val(mb, n);
      const d = { id: v.id, image, make: g("make"), model: g("model"), year: g("year"), plate: g("plate").toUpperCase(), energy: g("energy"), vin: g("vin"),
        initial_odometer: num(g("initial_odometer")), purchase_date: g("purchase_date") || null, purchase_price: num(g("purchase_price")),
        odometer_entity: g("odometer_entity") || null,
        charge: { charging_entity: g("charging_entity") || null, energy_entity: g("energy_entity") || null, energy_mode: g("energy_mode"),
          price: num(g("price")), price_entity: g("price_entity") || null, soc_entity: g("soc_entity") || null } };
      if (g("name")) d.name = g("name"); else if (isNew || !v.name || v.name === [v.make, v.model].filter(Boolean).join(" ")) d.name = [d.make, d.model].filter(Boolean).join(" ") || "Ma voiture";
      if (!isNew) { d.sold_date = g("sold_date") || null; d.sold_price = num(g("sold_price")); d.archived = !!g("archived"); }
      const saved = await this._do(this._ws("vehicle/save", { vehicle: d }), isNew ? "Voiture ajoutée" : "Voiture enregistrée");
      this._vid = saved.id; this._close(); this._render();
    });
    const del = mb.querySelector('[data-x="del"]');
    if (del) del.addEventListener("click", async () => {
      const n = this._recs(v.id).length;
      if (!confirm(`Supprimer « ${v.name} » et ses ${n} opérations ? Pour garder l'historique d'une voiture vendue, cochez plutôt « Voiture vendue ».`)) return;
      await this._do(this._ws("vehicle/delete", { vehicle_id: v.id }), "Voiture supprimée");
      this._vid = null; this._close();
    });
  }

  // --- opération
  _recordModal(rec) {
    const v = this._veh(); if (!v) return;
    let r = { vehicle_id: v.id, date: todayIso(), odometer: (v.summary || {}).odometer ?? "", cost: "", files: [], fuel: { full: true }, ...rec };
    if (rec && rec.vehicle_id && this._s.vehicles[rec.vehicle_id]) r.vehicle_id = rec.vehicle_id;
    const isNew = !r.id;
    let files = [...(r.files || [])];
    const draw = () => {
      const t = r.type, isFuel = t === "carburant" || t === "recharge", f = r.fuel || {};
      const unit = t === "recharge" ? "kWh" : "L";
      const titles = [...new Set([...(PRESETS[t] || []), ...this._recs(r.vehicle_id, [t]).map((x) => x.title).filter(Boolean)])];
      return `<div class="types">${Object.entries(TYPES).map(([k, o]) => `<button class="tchip ${k === t ? "on" : ""}" data-t="${k}" style="--c:${o.c}"><ha-icon icon="${o.i}"></ha-icon>${o.l}</button>`).join("")}</div>
        <div class="grid2">
          <label>Date<input class="f" type="date" name="date" value="${esc(r.date)}"></label>
          <label>Kilométrage<input class="f" type="number" name="odometer" value="${esc(r.odometer ?? "")}" placeholder="km au compteur"></label>
          ${t !== "km" ? `<label class="full">${isFuel ? "Libellé" : "Intervention"}<input class="f" name="title" list="dl-titles" value="${esc(r.title || (isFuel ? (t === "recharge" ? "Recharge" : "Plein") : ""))}" placeholder="${t === "frais" ? "Assurance, péage…" : "Vidange, pneus…"}"><datalist id="dl-titles">${titles.map((x) => `<option value="${esc(x)}">`).join("")}</datalist></label>` : ""}
          ${isFuel ? `<label>Quantité (${unit})<input class="f" type="number" step="0.01" name="qty" value="${esc(f.qty ?? "")}"></label>` : ""}
          ${t !== "km" ? `<label>Coût (${this._cur()})<input class="f" type="number" step="0.01" name="cost" value="${esc(r.cost ?? "")}"></label>` : ""}
          ${isFuel ? `<div class="full unitp" data-unitp></div>
            <label class="chk"><input type="checkbox" name="full" ${f.full !== false ? "checked" : ""}> ${t === "recharge" ? "Recharge complète" : "Plein complet"}</label>
            <label class="chk"><input type="checkbox" name="missed" ${f.missed ? "checked" : ""}> Un plein précédent manque</label>` : ""}
          ${t === "recharge" ? `<label>Batterie au départ (%)<input class="f" type="number" name="soc_start" value="${esc(f.soc_start ?? "")}"></label><label>Batterie à l'arrivée (%)<input class="f" type="number" name="soc_end" value="${esc(f.soc_end ?? "")}"></label>
            <label class="full">Lieu<select class="f" name="category">${["Domicile", "Borne publique", "Superchargeur", "Travail", "Autre"].map((x) => `<option ${r.category === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>` : ""}
          ${t === "carburant" ? `<label class="full">Station<input class="f" name="category" value="${esc(r.category || "")}" placeholder="facultatif"></label>` : ""}
          <label class="full">Notes<textarea class="f" name="notes" rows="2">${esc(r.notes || "")}</textarea></label>
          ${t !== "km" ? `<label class="full">Étiquettes<input class="f" name="tags" value="${esc((r.tags || []).join(", "))}" placeholder="garantie, garage Dupont…"></label>` : ""}
        </div>
        ${t !== "km" ? `<div class="lbl">Factures et photos</div><div class="files">${files.map((x, i) => `<span class="file">${/^image\//.test(x.mime || "") || /\.(jpe?g|png|webp|gif)$/i.test(x.name) ? `<span class="th" ${this._img(x.name)}></span>` : `<ha-icon icon="mdi:file-pdf-box"></ha-icon>`}<a data-sig="${esc(x.name)}" href="${esc(this._signed(x.name))}" target="_blank" rel="noopener">${esc(x.label || x.name)}</a><button class="ib xs" data-rmf="${i}"><ha-icon icon="mdi:close"></ha-icon></button></span>`).join("")}
          <label class="pill sm"><ha-icon icon="mdi:paperclip"></ha-icon>Ajouter<input type="file" multiple accept="image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.odt,.txt" hidden name="files"></label></div>` : ""}
        ${r.source && r.source !== "manual" ? `<div class="muted sm">Origine : ${{ auto: "relevé automatique", lubelogger: "import LubeLogger", csv: "import CSV" }[r.source] || r.source}</div>` : ""}
        <div class="row end">${!isNew ? `<button class="pill danger" data-x="del"><ha-icon icon="mdi:delete-outline"></ha-icon>Supprimer</button><span class="sp"></span>` : ""}
          <button class="pill main" data-x="save"><ha-icon icon="mdi:check"></ha-icon>${isNew ? "Ajouter" : "Enregistrer"}</button></div>`;
    };
    const mb = this._modal(isNew ? `Nouvelle opération · ${esc(v.name)}` : esc(r.title || TYPES[r.type].l), draw(), { wide: true });
    const collect = () => {
      const g = (n) => this._val(mb, n);
      if (g("date") !== undefined) r.date = g("date");
      if (g("odometer") !== undefined) r.odometer = g("odometer");
      if (g("title") !== undefined) r.title = g("title");
      if (g("cost") !== undefined) r.cost = g("cost");
      if (g("notes") !== undefined) r.notes = g("notes");
      if (g("tags") !== undefined) r.tags = g("tags").split(",").map((x) => x.trim()).filter(Boolean);
      if (g("category") !== undefined) r.category = g("category");
      r.fuel = { ...(r.fuel || {}) };
      ["qty", "soc_start", "soc_end"].forEach((k) => { if (g(k) !== undefined) r.fuel[k] = num(g(k)); });
      if (g("full") !== undefined) r.fuel.full = g("full");
      if (g("missed") !== undefined) r.fuel.missed = g("missed");
    };
    const unitPrice = () => {
      const el = mb.querySelector("[data-unitp]"); if (!el) return;
      const q = num(this._val(mb, "qty")), c = num(this._val(mb, "cost"));
      el.textContent = q && c ? `soit ${nf(c / q, 3)} ${this._cur()} / ${r.type === "recharge" ? "kWh" : "L"}` : "";
    };
    const bind = () => {
      mb.querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", () => { collect(); r.type = b.dataset.t; mb.innerHTML = draw(); bind(); }));
      mb.querySelectorAll('[name="qty"],[name="cost"]').forEach((i) => i.addEventListener("input", unitPrice)); unitPrice();
      mb.querySelectorAll("[data-rmf]").forEach((b) => b.addEventListener("click", () => { collect(); files.splice(Number(b.dataset.rmf), 1); mb.innerHTML = draw(); bind(); }));
      const fi = mb.querySelector('[name="files"]');
      if (fi) fi.addEventListener("change", async () => {
        collect();
        const lbl = fi.closest("label"); lbl.classList.add("busy");
        try { for (const f of fi.files) files.push(await this._do(this._upload(f))); } finally { mb.innerHTML = draw(); bind(); }
      });
      mb.querySelector('[data-x="save"]').addEventListener("click", async () => {
        collect();
        const d = { ...r, files, odometer: num(r.odometer), cost: num(r.cost) || 0 };
        if (d.type === "km" && d.odometer == null) return this._toast("Indiquez le kilométrage");
        delete d.created;
        await this._do(this._ws("record/save", { record: d }), isNew ? "Opération ajoutée" : "Opération enregistrée");
        this._close();
      });
      const del = mb.querySelector('[data-x="del"]');
      if (del) del.addEventListener("click", async () => { if (!confirm("Supprimer cette opération et ses fichiers ?")) return; await this._do(this._ws("record/delete", { record_id: r.id })); this._close(); });
    };
    bind();
  }

  // --- rappel
  _reminderModal(rem) {
    const v = this._veh(); if (!v) return;
    const r = { vehicle_id: v.id, ...rem }, isNew = !r.id, s = this._s.settings;
    const odo = (v.summary || {}).odometer;
    const mb = this._modal(isNew ? `Nouveau rappel · ${esc(v.name)}` : esc(r.title), `
      <div class="grid2">
        <label class="full">Quoi ?<input class="f" name="title" list="dl-rem" value="${esc(r.title || "")}" placeholder="Contrôle technique, vidange…"><datalist id="dl-rem">${REM_PRESETS.map((p) => `<option value="${esc(p.title)}">`).join("")}</datalist></label>
        <label>Échéance (date)<input class="f" type="date" name="due_date" value="${esc(r.due_date || "")}"></label>
        <label>Échéance (km)<input class="f" type="number" name="due_km" value="${esc(r.due_km ?? "")}" placeholder="${odo != null ? `actuel : ${nf(odo)}` : ""}"></label>
        <label>Puis tous les (mois)<input class="f" type="number" name="every_months" value="${esc(r.every_months ?? "")}" placeholder="non périodique"></label>
        <label>ou tous les (km)<input class="f" type="number" step="500" name="every_km" value="${esc(r.every_km ?? "")}"></label>
        <label>Prévenir (jours avant)<input class="f" type="number" name="notify_days" value="${esc(r.notify_days ?? "")}" placeholder="${s.notify_days} (par défaut)"></label>
        <label>Prévenir (km avant)<input class="f" type="number" name="notify_km" value="${esc(r.notify_km ?? "")}" placeholder="${s.notify_km} (par défaut)"></label>
        <label class="full">Une fois fait, enregistrer comme<select class="f" name="record_type">${["entretien", "reparation", "frais", "amelioration"].map((k) => `<option value="${k}" ${(r.record_type || "entretien") === k ? "selected" : ""}>${TYPES[k].l}</option>`).join("")}</select></label>
        <label class="full">Notes<textarea class="f" name="notes" rows="2">${esc(r.notes || "")}</textarea></label>
      </div>
      <div class="muted sm">Date et kilométrage : le premier atteint déclenche le rappel. Périodique : il se reprogramme quand vous le marquez « Fait ».</div>
      <div class="row end">${!isNew ? `<button class="pill danger" data-x="del"><ha-icon icon="mdi:delete-outline"></ha-icon>Supprimer</button><span class="sp"></span>` : ""}
        <button class="pill main" data-x="save"><ha-icon icon="mdi:check"></ha-icon>${isNew ? "Ajouter" : "Enregistrer"}</button></div>`);
    const dd = mb.querySelector('[name="due_date"]'), em = mb.querySelector('[name="every_months"]'), ek = mb.querySelector('[name="every_km"]'), dk = mb.querySelector('[name="due_km"]');
    // propositions d'échéance d'après la périodicité
    if (isNew && r.every_months && !r.due_date) { const d = new Date(); d.setMonth(d.getMonth() + Number(r.every_months)); dd.value = iso(d); }
    if (isNew && r.every_km && r.due_km == null && odo != null) dk.value = Math.round((odo + Number(r.every_km)) / 100) * 100;
    mb.querySelector('[data-x="save"]').addEventListener("click", async () => {
      const g = (n) => this._val(mb, n);
      if (!g("title")) return this._toast("Indiquez le rappel");
      const d = { id: r.id, vehicle_id: r.vehicle_id, title: g("title"), due_date: g("due_date") || null, due_km: num(g("due_km")), every_months: num(g("every_months")), every_km: num(g("every_km")),
        notify_days: num(g("notify_days")), notify_km: num(g("notify_km")), record_type: g("record_type"), notes: g("notes") };
      if (!d.due_date && d.due_km == null) return this._toast("Indiquez une date ou un kilométrage");
      await this._do(this._ws("reminder/save", { reminder: d }), isNew ? "Rappel ajouté" : "Rappel enregistré");
      this._close();
    });
    const del = mb.querySelector('[data-x="del"]');
    if (del) del.addEventListener("click", async () => { if (!confirm(`Supprimer le rappel « ${r.title} » ?`)) return; await this._do(this._ws("reminder/delete", { reminder_id: r.id })); this._close(); });
    void em; void ek;
  }
  _doneModal(rem) {
    if (!rem) return;
    const v = this._s.vehicles[rem.vehicle_id];
    const next = rem.every_months || rem.every_km;
    const mb = this._modal(`${esc(rem.title)} : c'est fait`, `
      <div class="grid2">
        <label>Date<input class="f" type="date" name="date" value="${todayIso()}"></label>
        <label>Kilométrage<input class="f" type="number" name="odometer" value="${esc((v.summary || {}).odometer ?? "")}"></label>
        <label>Coût (${this._cur()})<input class="f" type="number" step="0.01" name="cost" placeholder="facultatif"></label>
        <label>Enregistrer comme<select class="f" name="record_type"><option value="">ne pas enregistrer d'opération</option>${["entretien", "reparation", "frais", "amelioration"].map((k) => `<option value="${k}" ${(rem.record_type || "entretien") === k ? "selected" : ""}>${TYPES[k].l}</option>`).join("")}</select></label>
        <label class="full">Notes<textarea class="f" name="notes" rows="2"></textarea></label>
      </div>
      <div class="muted sm">${next ? `Le rappel sera reprogrammé : ${[rem.every_months ? `dans ${rem.every_months} mois` : "", rem.every_km ? `dans ${nf(rem.every_km)} km` : ""].filter(Boolean).join(" ou ")}.` : "Ce rappel n'est pas périodique : il sera retiré."}</div>
      <div class="row end"><button class="pill main" data-x="ok"><ha-icon icon="mdi:check"></ha-icon>Valider</button></div>`);
    mb.querySelector('[data-x="ok"]').addEventListener("click", async () => {
      const g = (n) => this._val(mb, n);
      await this._do(this._ws("reminder/done", { reminder_id: rem.id, date: g("date"), odometer: num(g("odometer")), cost: num(g("cost")), record_type: g("record_type") || null, notes: g("notes") }), "Bien noté 👍");
      this._close();
    });
  }

  // --- import LubeLogger (API)
  _importModal() {
    const saved = (() => { try { return JSON.parse(localStorage.getItem("holm-cars-lube") || "{}"); } catch (e) { return {}; } })();
    const mb = this._modal("Importer depuis LubeLogger", `
      <p class="muted">Adresse de votre LubeLogger, vue depuis Home Assistant (par exemple <code>http://192.168.1.20:8080</code>). Identifiant et mot de passe d'un compte LubeLogger, ou une clé d'API. Ils servent uniquement à cet import et ne sont pas enregistrés.</p>
      <div class="grid2">
        <label class="full">Adresse<input class="f" name="url" value="${esc(saved.url || "")}" placeholder="http://nas:8080"></label>
        <label>Identifiant<input class="f" name="username" value="${esc(saved.username || "")}" autocomplete="username"></label>
        <label>Mot de passe<input class="f" type="password" name="password" autocomplete="current-password"></label>
        <label class="full">ou clé d'API<input class="f" type="password" name="api_key" placeholder="facultatif"></label>
      </div>
      <div class="row end"><button class="pill main" data-x="test"><ha-icon icon="mdi:magnify"></ha-icon>Voir les voitures</button></div>
      <div class="res"></div>`, { wide: true });
    const creds = () => ({ url: this._val(mb, "url"), username: this._val(mb, "username"), password: this._val(mb, "password"), api_key: this._val(mb, "api_key") });
    const res = mb.querySelector(".res");
    mb.querySelector('[data-x="test"]').addEventListener("click", async (e) => {
      const b = e.currentTarget; b.classList.add("busy"); b.disabled = true; res.innerHTML = `<div class="muted">Connexion à LubeLogger…</div>`;
      try {
        const c = creds();
        try { localStorage.setItem("holm-cars-lube", JSON.stringify({ url: c.url, username: c.username })); } catch (err) { /* ignore */ }
        const p = await this._ws("lubelogger/preview", c);
        const L = { servicerecords: "entretiens", repairrecords: "réparations", upgraderecords: "équipements", gasrecords: "pleins", taxrecords: "frais", odometerrecords: "relevés", reminders: "rappels" };
        res.innerHTML = `<div class="lbl">${p.vehicles.length} voiture${p.vehicles.length > 1 ? "s" : ""} trouvée${p.vehicles.length > 1 ? "s" : ""}</div>
          ${p.vehicles.map((v) => `<label class="lv"><input type="checkbox" checked data-lv="${v.id}"><span><b>${esc(v.name)}</b> ${v.plate ? `<code>${esc(v.plate)}</code>` : ""}<small>${Object.entries(v.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${L[k] || k}`).join(" · ") || "aucune donnée"}</small></span></label>`).join("")}
          <label class="chk"><input type="checkbox" name="include_files" checked> Récupérer aussi les factures et documents joints</label>
          <div class="row end"><button class="pill main" data-x="go"><ha-icon icon="mdi:database-import"></ha-icon>Importer</button></div>`;
        res.querySelector('[data-x="go"]').addEventListener("click", async (ev) => {
          const g = ev.currentTarget; g.classList.add("busy"); g.disabled = true; g.innerHTML = `<ha-icon icon="mdi:timer-sand"></ha-icon>Import en cours…`;
          try {
            const ids = [...res.querySelectorAll("[data-lv]")].filter((i) => i.checked).map((i) => String(i.dataset.lv));
            const st = await this._ws("lubelogger/import", { ...creds(), vehicle_ids: ids, include_files: res.querySelector('[name="include_files"]').checked });
            res.innerHTML = `<div class="okbox"><ha-icon icon="mdi:check-circle"></ha-icon><div><b>Import terminé</b><br>${st.vehicles} voiture${st.vehicles > 1 ? "s" : ""}, ${st.records} opérations ajoutées${st.updated ? `, ${st.updated} mises à jour` : ""}, ${st.reminders} rappels, ${st.files} fichiers.</div></div>
              <div class="row end"><button class="pill main" data-x="close">Fermer</button></div>`;
            res.querySelector('[data-x="close"]').addEventListener("click", () => { this._close(); this._tab = "home"; this._render(); });
          } catch (err) { g.classList.remove("busy"); g.disabled = false; g.innerHTML = `<ha-icon icon="mdi:database-import"></ha-icon>Réessayer`; this._toast(`Import : ${err.message || err}`); }
        });
      } catch (err) { res.innerHTML = `<div class="errbox">${esc(err.message || err)}</div>`; }
      finally { b.classList.remove("busy"); b.disabled = false; }
    });
  }

  // --- import CSV
  _csvModal() {
    const vs = this._vehicles();
    if (!vs.length) return this._toast("Ajoutez d'abord la voiture concernée");
    const mb = this._modal("Importer un fichier CSV", `
      <p class="muted">Dans LubeLogger, chaque onglet (Entretien, Réparations, Carburant, Frais, Odomètre…) a un bouton d'export CSV. Importez-les un par un : le type est détecté tout seul, les doublons sont ignorés.</p>
      <div class="grid2">
        <label>Voiture<select class="f" name="vid">${vs.map((v) => `<option value="${v.id}" ${v.id === this._vid ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label>
        <label>Type<select class="f" name="kind"><option value="">détection automatique</option>${["entretien", "reparation", "amelioration", "carburant", "frais", "km"].map((k) => `<option value="${k}">${TYPES[k].l}</option>`).join("")}</select></label>
        <label class="full">Fichier<input class="f" type="file" accept=".csv,text/csv" name="file"></label>
      </div>
      <div class="muted sm">Entretien, réparations et équipements ont le même format : choisissez le type pour ces fichiers-là.</div>
      <div class="row end"><button class="pill main" data-x="go"><ha-icon icon="mdi:upload"></ha-icon>Importer</button></div><div class="res"></div>`);
    mb.querySelector('[data-x="go"]').addEventListener("click", async () => {
      const f = mb.querySelector('[name="file"]').files[0];
      if (!f) return this._toast("Choisissez un fichier");
      const text = await f.text();
      const r = await this._do(this._ws("csv/import", { vehicle_id: this._val(mb, "vid"), content: text, kind: this._val(mb, "kind") || null }));
      mb.querySelector(".res").innerHTML = `<div class="okbox"><ha-icon icon="mdi:check-circle"></ha-icon><div><b>${r.added} ${TYPES[r.kind] ? TYPES[r.kind].l.toLowerCase() : ""} importé${r.added > 1 ? "s" : ""}</b>${r.skipped ? ` · ${r.skipped} ignoré${r.skipped > 1 ? "s" : ""} (doublons ou lignes vides)` : ""}<br><small>Dates lues au format ${r.day_first ? "jour/mois" : "mois/jour"}.</small></div></div>`;
      mb.querySelector('[name="file"]').value = "";
    });
  }

  getCardSize() { return this._c && this._c.view === "vehicle" ? 4 : 12; }
  getGridOptions() { return this._c && this._c.view === "vehicle" ? { columns: 6, rows: "auto", min_columns: 4 } : { columns: 12, rows: "auto", min_columns: 6 }; }
  static getStubConfig() { return { title: "Garage" }; }
  static getConfigElement() { return document.createElement("holm-cars-card-editor"); }
}

const STYLE = `
:host { display:block; --ac:#0abfbf; --ac2:#e3a21a; --sf:color-mix(in srgb, var(--primary-text-color) 6%, transparent); --sf2:color-mix(in srgb, var(--primary-text-color) 10%, transparent); --bd:color-mix(in srgb, var(--primary-text-color) 11%, transparent); --mt:var(--secondary-text-color); }
ha-card { padding:14px; box-sizing:border-box; overflow:hidden; }
.hd, .bd { container-type:inline-size; min-width:0; }
ha-card.noframe { background:none !important; box-shadow:none !important; border:none !important; backdrop-filter:none !important; }
button { font:inherit; color:inherit; cursor:pointer; }
code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; padding:1px 6px; border-radius:6px; background:var(--sf2); letter-spacing:.04em; }
.hd { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
.tt { display:flex; align-items:center; gap:8px; font-size:17px; font-weight:700; margin-right:auto; color:var(--primary-text-color); }
.tt ha-icon { color:var(--ac); }
.tabs { display:flex; gap:3px; padding:3px; border-radius:14px; background:var(--sf); }
.tab { display:flex; align-items:center; gap:6px; border:0; background:none; padding:7px 11px; border-radius:11px; font-size:13px; font-weight:600; color:var(--mt); position:relative; }
.tab ha-icon { --mdc-icon-size:18px; }
.tab.on { background:color-mix(in srgb, var(--ac) 22%, transparent); color:var(--primary-text-color); }
.tab em { font-style:normal; font-size:10.5px; min-width:16px; height:16px; line-height:16px; border-radius:8px; background:#f59e0b; color:#111; padding:0 4px; text-align:center; }
@container (max-width: 720px) { .tab span { display:none; } .tab { padding:8px 11px; } }
.empty, .muted { color:var(--mt); font-size:13px; line-height:1.5; }
.empty { padding:22px 8px; text-align:center; }
.empty.sm { padding:12px 6px; font-size:12.5px; }
.sm { font-size:12px; }
.hint { margin-top:12px; font-size:11.5px; color:var(--mt); text-align:center; opacity:.85; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:12px; }
.row.end { justify-content:flex-end; } .row.center { justify-content:center; } .sp { flex:1; }
.pill { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--bd); background:var(--sf); padding:8px 13px; border-radius:11px; font-size:13px; font-weight:600; color:var(--primary-text-color); white-space:nowrap; text-decoration:none; }
.pill ha-icon { --mdc-icon-size:17px; }
.pill.sm { padding:5px 10px; font-size:12px; border-radius:9px; }
.pill.main { background:var(--ac); border-color:var(--ac); color:#06191b; }
.pill.danger { color:var(--error-color, #e05252); }
.pill.glass { background:rgba(0,0,0,.45); border-color:rgba(255,255,255,.25); color:#fff; backdrop-filter:blur(6px); }
.pill.busy, .busy { opacity:.6; pointer-events:none; }
.pill:disabled { opacity:.5; cursor:default; }
.lnk { border:0; background:none; color:var(--ac); font-weight:600; font-size:12.5px; padding:2px 4px; display:inline-flex; align-items:center; gap:3px; }
.lnk ha-icon { --mdc-icon-size:16px; }
.lnk.more { margin-top:6px; }
.ib { width:34px; height:34px; border-radius:10px; border:0; background:var(--sf); display:grid; place-items:center; flex:none; color:var(--primary-text-color); }
.ib ha-icon { --mdc-icon-size:19px; }
.ib.glass { background:rgba(0,0,0,.45); color:#fff; backdrop-filter:blur(6px); }
.ib.xs { width:22px; height:22px; border-radius:7px; } .ib.xs ha-icon { --mdc-icon-size:14px; }
/* accueil */
.welcome { text-align:center; padding:30px 10px; }
.welcome > ha-icon { --mdc-icon-size:56px; color:var(--ac); }
.welcome h3 { margin:8px 0 4px; font-size:19px; } .welcome p { color:var(--mt); margin:0 0 6px; }
/* garage */
.garage { display:flex; gap:10px; overflow-x:auto; padding:2px 2px 10px; margin-bottom:6px; scrollbar-width:thin; scroll-snap-type:x mandatory; }
.gv { position:relative; flex:none; width:200px; display:flex; flex-direction:column; text-align:left; border:1px solid var(--bd); background:var(--sf); border-radius:16px; padding:0; overflow:hidden; scroll-snap-align:start; transition:transform .15s, border-color .15s, box-shadow .15s; }
.gv:hover { transform:translateY(-2px); }
.gv.on { border-color:var(--ac); box-shadow:0 0 0 1px var(--ac), 0 8px 24px color-mix(in srgb, var(--ac) 22%, transparent); }
.gv.arch { opacity:.55; }
.gph { height:96px; background:var(--sf2) center/cover no-repeat; display:grid; place-items:center; }
.gph.no ha-icon { --mdc-icon-size:46px; color:var(--mt); opacity:.6; }
.gtx { padding:8px 11px 10px; display:flex; flex-direction:column; gap:1px; }
.gtx small { font-size:11px; color:var(--mt); } .gtx b { font-size:14.5px; } .gtx span { font-size:13px; color:var(--mt); margin-bottom:3px; }
.gtx code { align-self:flex-start; }
.dot { position:absolute; top:8px; right:8px; width:11px; height:11px; border-radius:50%; border:2px solid rgba(0,0,0,.4); }
.dot.soon { background:#f59e0b; } .dot.overdue { background:#ef4444; }
.gv.add { width:96px; align-items:center; justify-content:center; gap:4px; border-style:dashed; color:var(--mt); font-size:12px; font-weight:600; background:none; }
.gv.add ha-icon { --mdc-icon-size:26px; color:var(--ac); }
/* tableau de bord */
.hero { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(0,1fr); gap:12px; }
@container (max-width: 640px) { .hero { grid-template-columns:minmax(0,1fr); } }
.hph { position:relative; min-height:200px; border-radius:18px; background:var(--sf2) center/cover no-repeat; overflow:hidden; display:grid; place-items:center; }
.hph.no > ha-icon { --mdc-icon-size:80px; color:var(--mt); opacity:.4; }
.hov { position:absolute; inset:auto 0 0 0; padding:40px 14px 12px; display:flex; align-items:flex-end; justify-content:space-between; gap:10px; background:linear-gradient(180deg, transparent, rgba(0,0,0,.72)); color:#fff; }
.hov small { opacity:.85; font-size:12px; } .hov h2 { margin:1px 0 4px; font-size:21px; line-height:1.15; } .hov code { background:rgba(255,255,255,.18); color:#fff; }
.tiles { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px; }
.tile { border:1px solid var(--bd); background:var(--sf); border-radius:16px; padding:12px; display:flex; flex-direction:column; gap:2px; min-width:0; }
.tile > ha-icon { --mdc-icon-size:20px; color:var(--ac); margin-bottom:2px; }
.tile b { font-size:20px; font-weight:800; letter-spacing:-.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tile span { font-size:12.5px; color:var(--mt); font-weight:600; } .tile small { font-size:11.5px; color:var(--mt); margin-top:auto; padding-top:4px; }
.mbar { display:flex; height:6px; border-radius:3px; overflow:hidden; background:var(--sf2); margin-top:4px; } .mbar i { display:block; height:100%; }
.qa { display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:8px; margin:12px 0; }
.qa.sm { grid-template-columns:repeat(4, minmax(0,1fr)); margin:10px 0 0; }
.qb { display:flex; flex-direction:column; align-items:center; gap:5px; padding:11px 4px; border-radius:14px; border:1px solid color-mix(in srgb, var(--c) 35%, transparent); background:color-mix(in srgb, var(--c) 12%, transparent); font-size:12px; font-weight:700; }
.qb ha-icon { color:var(--c); --mdc-icon-size:22px; }
.qb:hover { background:color-mix(in srgb, var(--c) 22%, transparent); }
@container (max-width: 460px) { .qa { grid-template-columns:repeat(3, minmax(0,1fr)); } }
.cols { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:14px; }
@container (max-width: 640px) { .cols { grid-template-columns:minmax(0,1fr); } }
.sh { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:6px 0 8px; }
.sh h4 { margin:0; font-size:14px; }
/* lignes */
.tl { display:flex; flex-direction:column; gap:6px; }
.rr { display:flex; align-items:center; gap:10px; width:100%; text-align:left; border:1px solid var(--bd); background:var(--sf); border-radius:13px; padding:8px 10px; }
.rr:hover { border-color:color-mix(in srgb, var(--c) 50%, transparent); }
.rr.flat { cursor:default; }
.ri { width:34px; height:34px; border-radius:10px; display:grid; place-items:center; flex:none; background:color-mix(in srgb, var(--c) 18%, transparent); color:var(--c); }
.ri ha-icon { --mdc-icon-size:19px; }
.rt { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
.rt b { font-size:13.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .rt small { font-size:11.5px; color:var(--mt); }
.clip { --mdc-icon-size:12px; vertical-align:-2px; }
.rc { font-weight:700; font-size:13.5px; white-space:nowrap; }
.rem { display:flex; align-items:center; gap:8px; border:1px solid var(--bd); background:var(--sf); border-radius:13px; padding:6px 8px 6px 10px; margin-bottom:6px; }
.rem.soon { border-color:color-mix(in srgb, #f59e0b 55%, transparent); background:color-mix(in srgb, #f59e0b 9%, transparent); }
.rem.overdue { border-color:color-mix(in srgb, #ef4444 60%, transparent); background:color-mix(in srgb, #ef4444 10%, transparent); }
.rmain { flex:1; min-width:0; display:flex; align-items:center; gap:10px; border:0; background:none; text-align:left; padding:3px 0; }
.rmain > ha-icon { --mdc-icon-size:22px; color:var(--ac); flex:none; }
.rem.soon .rmain > ha-icon { color:#f59e0b; } .rem.overdue .rmain > ha-icon { color:#ef4444; }
.prog { display:block; height:4px; border-radius:2px; background:var(--sf2); margin-top:5px; overflow:hidden; } .prog i { display:block; height:100%; background:var(--ac); border-radius:2px; }
.rem.soon .prog i { background:#f59e0b; } .rem.overdue .prog i { background:#ef4444; }
/* historique */
.bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:4px 0 10px; }
.chips { display:flex; gap:6px; flex-wrap:wrap; }
.chip { border:1px solid var(--bd); background:var(--sf); border-radius:999px; padding:5px 11px; font-size:12.5px; font-weight:600; color:var(--mt); display:inline-flex; align-items:center; gap:6px; }
.chip.on { color:var(--primary-text-color); border-color:var(--c, var(--ac)); background:color-mix(in srgb, var(--c, var(--ac)) 18%, transparent); }
.chip.chk2 input { display:none; }
input.search, .f { min-width:0; box-sizing:border-box; padding:9px 12px; border-radius:11px; border:1px solid var(--bd); background:var(--card-background-color, transparent); color:var(--primary-text-color); font:inherit; font-size:14px; width:100%; }
input.search { flex:1; min-width:140px; width:auto; }
textarea.f { resize:vertical; }
.lsum { display:flex; align-items:center; gap:10px; margin-bottom:8px; font-size:13px; color:var(--mt); } .lsum b { color:var(--primary-text-color); margin-right:auto; }
.mg { margin-bottom:12px; }
.pill.more2 { width:100%; justify-content:center; margin-top:4px; }
.mh { display:flex; justify-content:space-between; font-size:12px; font-weight:700; color:var(--mt); text-transform:uppercase; letter-spacing:.05em; margin:4px 4px 6px; }
/* insights */
.seg { display:flex; padding:3px; border-radius:11px; background:var(--sf); margin-left:auto; } .seg button { border:0; background:none; padding:5px 11px; border-radius:9px; font-size:12.5px; font-weight:600; color:var(--mt); } .seg button.on { background:color-mix(in srgb, var(--ac) 22%, transparent); color:var(--primary-text-color); }
.kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(150px,100%), 1fr)); gap:10px; margin-bottom:12px; }
.kpi { border:1px solid var(--bd); background:var(--sf); border-radius:15px; padding:11px 12px; display:flex; flex-direction:column; gap:2px; }
.kpi b { font-size:19px; font-weight:800; } .kpi span { font-size:12px; font-weight:600; color:var(--mt); } .kpi small { font-size:11px; color:var(--mt); }
.charts { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:12px; }
@container (max-width: 640px) { .charts { grid-template-columns:minmax(0,1fr); } }
.card2 { border:1px solid var(--bd); background:var(--sf); border-radius:16px; padding:12px; min-width:0; }
.card2.wide { grid-column:1 / -1; }
.card2 h4 { margin:0 0 10px; font-size:13.5px; display:flex; align-items:center; gap:7px; } .card2 h4 small { font-weight:500; color:var(--mt); } .card2 h4 ha-icon { --mdc-icon-size:18px; color:var(--ac); }
.ch { width:100%; height:auto; display:block; overflow:visible; }
.ch text { font-size:10px; fill:var(--mt); } .ch text.v { font-size:9.5px; fill:var(--primary-text-color); font-weight:700; }
.ch .grid { stroke:var(--bd); stroke-dasharray:3 4; }
.chs { font-size:11.5px; color:var(--mt); margin-top:6px; text-align:center; }
.legend { display:flex; flex-wrap:wrap; gap:4px 12px; margin-top:8px; font-size:11.5px; color:var(--mt); } .legend i, .toplist i, .dl i { display:inline-block; width:9px; height:9px; border-radius:3px; margin-right:5px; flex:none; }
.donut { display:flex; align-items:center; gap:14px; } .donut svg { width:120px; flex:none; } .dt { font-size:17px; font-weight:800; fill:var(--primary-text-color); } .ds { font-size:10px; fill:var(--mt); }
.dl { flex:1; display:flex; flex-direction:column; gap:5px; font-size:12.5px; } .dl div { display:flex; align-items:center; } .dl span { flex:1; } .dl b { font-weight:700; }
.toplist { display:flex; flex-direction:column; gap:7px; font-size:12.5px; } .toplist div { display:flex; align-items:center; gap:4px; } .toplist span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .toplist small { color:var(--mt); }
.cmpbars { display:flex; flex-direction:column; gap:9px; } .cb { display:grid; grid-template-columns:minmax(70px, 160px) minmax(0,1fr) auto auto; gap:10px; align-items:center; font-size:12.5px; }
.cn { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600; } .ct { height:9px; border-radius:5px; background:var(--sf2); overflow:hidden; } .ct i { display:block; height:100%; background:linear-gradient(90deg, var(--ac), #22c55e); border-radius:5px; } .cb small { color:var(--mt); min-width:70px; text-align:right; }
/* réglages */
.set { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(300px,100%), 1fr)); gap:12px; }
.lbl { font-size:12px; font-weight:700; color:var(--mt); margin:12px 0 6px; text-transform:uppercase; letter-spacing:.05em; }
/* vue compacte */
.cmp { display:flex; gap:12px; align-items:center; margin-bottom:10px; }
.cph { width:110px; height:72px; border-radius:13px; background:var(--sf2) center/cover no-repeat; flex:none; display:grid; place-items:center; } .cph.no ha-icon { --mdc-icon-size:36px; color:var(--mt); }
.ctx { display:flex; flex-direction:column; gap:1px; min-width:0; } .ctx small { font-size:11.5px; color:var(--mt); } .ctx b { font-size:16px; } .ctx span { font-size:12.5px; color:var(--mt); }
/* fenêtres */
.ov { position:fixed; inset:0; z-index:10; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; padding:14px; backdrop-filter:blur(3px); }
.mdl { width:min(520px, 100%); max-height:calc(100vh - 28px); overflow:auto; background:var(--card-background-color, #1c1f24); color:var(--primary-text-color); border-radius:20px; border:1px solid var(--bd); box-shadow:0 20px 60px rgba(0,0,0,.5); }
.mdl.wide { width:min(680px, 100%); }
.mh2 { position:sticky; top:0; z-index:1; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 14px; background:inherit; border-bottom:1px solid var(--bd); } .mh2 b { font-size:15.5px; }
.mb { padding:14px; }
.grid2 { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px; }
@media (max-width: 520px) { .grid2 { grid-template-columns:minmax(0,1fr); } }
.grid2 label, label.full { display:flex; flex-direction:column; gap:4px; font-size:12px; font-weight:600; color:var(--mt); }
.grid2 label small { font-weight:500; }
.grid2 .full, .grid2 .echarge, .grid2 .unitp { grid-column:1 / -1; }
.grid2 label.chk, label.chk { flex-direction:row; align-items:center; gap:8px; font-size:13px; color:var(--primary-text-color); }
.unitp { font-size:12.5px; color:var(--ac); font-weight:600; min-height:4px; }
.hide { display:none !important; }
details { border:1px solid var(--bd); border-radius:13px; padding:8px 12px; margin-top:12px; }
details summary { cursor:pointer; font-weight:700; font-size:13px; display:flex; align-items:center; gap:7px; list-style:none; } details summary ha-icon { --mdc-icon-size:18px; color:var(--ac); }
details[open] summary { margin-bottom:10px; }
.vimg { height:150px; border-radius:15px; background:var(--sf2) center/cover no-repeat; display:flex; align-items:flex-end; justify-content:flex-end; padding:10px; margin-bottom:12px; }
.types { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
.tchip { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--bd); background:var(--sf); border-radius:10px; padding:6px 10px; font-size:12.5px; font-weight:600; color:var(--mt); }
.tchip ha-icon { --mdc-icon-size:16px; color:var(--c); }
.tchip.on { color:var(--primary-text-color); border-color:var(--c); background:color-mix(in srgb, var(--c) 18%, transparent); }
.files { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.file { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--bd); border-radius:10px; padding:4px 4px 4px 6px; font-size:12px; max-width:100%; }
.file a { color:var(--primary-text-color); text-decoration:none; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.file .th { width:30px; height:30px; border-radius:7px; background:var(--sf2) center/cover no-repeat; flex:none; }
.file ha-icon { color:#ef4444; }
.lv { display:flex; gap:10px; align-items:flex-start; padding:8px 10px; border:1px solid var(--bd); border-radius:12px; margin-bottom:6px; } .lv span { display:flex; flex-direction:column; gap:2px; font-size:13px; } .lv small { color:var(--mt); }
.okbox, .errbox { display:flex; gap:10px; align-items:flex-start; padding:12px; border-radius:13px; margin-top:12px; font-size:13px; line-height:1.5; }
.okbox { background:color-mix(in srgb, #22c55e 14%, transparent); border:1px solid color-mix(in srgb, #22c55e 40%, transparent); } .okbox ha-icon { color:#22c55e; }
.errbox { background:color-mix(in srgb, #ef4444 12%, transparent); border:1px solid color-mix(in srgb, #ef4444 40%, transparent); }
`;

// ------------------------------------------------------------ éditeur visuel
class HolmCarsCardEditor extends HTMLElement {
  setConfig(c) { this._c = { ...c }; this._render(); }
  set hass(h) {
    this._hass = h;
    if (!this._loaded && h.connection) {
      this._loaded = true;
      h.connection.subscribeMessage((m) => { this._vehicles = Object.values(m.state.vehicles || {}); this._render(); if (this._unsub) { this._unsub(); this._unsub = null; } }, { type: "holm_cars/subscribe" })
        .then((u) => { this._unsub = u; if (this._vehicles) { u(); this._unsub = null; } }).catch(() => {});
    }
    if (this._form) this._form.hass = h;
    else this._render();
  }
  _render() {
    if (!this._hass || !this._c) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.addEventListener("value-changed", (e) => {
        const c = { ...e.detail.value };
        Object.keys(c).forEach((k) => { if (c[k] === "" || c[k] == null) delete c[k]; });
        this._c = c;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: c }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    const vs = this._vehicles || [];
    this._form.hass = this._hass;
    this._form.schema = [
      { name: "title", selector: { text: {} } },
      { name: "view", selector: { select: { mode: "dropdown", options: [{ value: "full", label: "Complète (garage, historique, rappels, insights)" }, { value: "vehicle", label: "Compacte : une seule voiture" }] } } },
      ...(this._c.view === "vehicle" ? [{ name: "vehicle", selector: { select: { mode: "dropdown", options: vs.map((v) => ({ value: v.id, label: v.name })) } } }] : []),
      { name: "show_frame", selector: { boolean: {} } },
    ];
    this._form.data = { title: "Garage", view: "full", show_frame: true, ...this._c };
    this._form.computeLabel = (s) => ({ title: "Titre", view: "Affichage", vehicle: "Voiture", show_frame: "Afficher le cadre de la carte" }[s.name] || s.name);
  }
}

if (!customElements.get("holm-cars-card")) customElements.define("holm-cars-card", HolmCarsCard);
if (!customElements.get("holm-cars-card-editor")) customElements.define("holm-cars-card-editor", HolmCarsCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "holm-cars-card")) {
  window.customCards.push({ type: "holm-cars-card", name: "HOLM Cars", description: "Entretien, dépenses, carburant, recharges et statistiques de vos voitures.", preview: false, documentationURL: "https://github.com/kaaribou/holm-cars" });
}
console.info(`%c HOLM-CARS %c ${VERSION} `, "background:#0abfbf;color:#06191b;border-radius:3px 0 0 3px", "background:#123;color:#fff;border-radius:0 3px 3px 0");
})();
