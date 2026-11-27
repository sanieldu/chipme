/* chipme — poker buy-in counter & settle-up ledger.
   Everything lives in localStorage so a refresh never loses the game. */
(() => {
  "use strict";

  const KEY = "chipme:v1";
  const PRESETS = [20, 25, 50];
  // clay-chip palette (edge spots + inlay are derived from the base colour in CSS)
  const CHIP_COLORS = ["#d63a3a", "#1f8fd6", "#1e9b4a", "#f07a2c", "#232325", "#5b3aa6", "#f2c230", "#f1ede3"];
  const PRESET_COLORS = ["#1f8fd6", "#1e9b4a", "#f07a2c"];   // $20 blue, $25 green, $50 orange
  // blind levels -> the chip values a home game would use for them (cents)
  const BLINDS = [
    { sb: 10, bb: 20, chips: [10, 50, 100, 500] },
    { sb: 25, bb: 50, chips: [25, 100, 500, 2500] },
    { sb: 50, bb: 100, chips: [50, 100, 500, 2500] },
    { sb: 100, bb: 200, chips: [100, 500, 2500, 10000] },
    { sb: 200, bb: 500, chips: [100, 500, 2500, 10000] },
  ];
  const LADDER = [5, 10, 25, 50, 100, 200, 500, 1000, 2500, 10000, 50000];
  const RANK = [
    { name: "white", color: "#f1ede3" },
    { name: "red", color: "#d63a3a" },
    { name: "green", color: "#1e9b4a" },
    { name: "black", color: "#232325" },
  ];
  const AV_COLORS = ["#b5332e", "#33518f", "#2e7a4f", "#a07a32", "#c0622b", "#2c7f86", "#a4466e", "#6f6a5e"];

  const $ = (s, el = document) => el.querySelector(s);
  const app = $("#app");
  const fx = $("#fx");
  const modal = $("#modal");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------- state ---------------- */
  const fresh = () => ({
    stage: "setup",          // setup | table | settle
    buyIn: 20,
    players: [],             // {id, name, color, busted, final}
    log: [],                 // {id, pid, type: buyin|rebuy|bust|back, amount, ts}
    blinds: null,            // {sb, bb} in cents; asked before showing chip counts
    settleAnyway: false,
    startedAt: null,
  });

  let state = load();
  let undoSnap = null;

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && Array.isArray(s.players)) return { ...fresh(), ...s };
    } catch (_) {}
    return fresh();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
  }
  function commit(mutator, { undoable = false, msg } = {}) {
    if (undoable) undoSnap = JSON.stringify(state);
    mutator(state);
    save();
    render();
    if (msg) toast(msg, undoable);
  }
  // keep multiple tabs in sync
  addEventListener("storage", (e) => { if (e.key === KEY) { state = load(); render(); } });

  const uid = () => Math.random().toString(36).slice(2, 9);
  const cents = (n) => Math.round(n * 100) / 100;
  const money = (n, sign = false) => {
    const v = cents(n);
    const s = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
    return (v < 0 ? "−$" : sign && v > 0 ? "+$" : "$") + s;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = (n) => n.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const player = (id) => state.players.find((p) => p.id === id);
  const totalIn = (pid) => state.log.filter((l) => l.pid === pid && (l.type === "buyin" || l.type === "rebuy")).reduce((a, l) => a + l.amount, 0);
  const potTotal = () => state.players.reduce((a, p) => a + totalIn(p.id), 0);
  const entries = (pid) => state.log.filter((l) => l.pid === pid && (l.type === "buyin" || l.type === "rebuy")).length;
  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  /* ---------------- blinds & chip breakdown ----------------
     All math in cents. The smallest chip covers the small blind; about 10 big
     blinds go in small chips for posting/betting, ~30% in the 2nd chip, the rest
     in the 3rd, with the 4th used once a stack holds lots of the 3rd. */
  const blindLabel = (c) => (c < 100 ? `${c}¢` : `$${c / 100}`);
  const blindsText = (b) => `${blindLabel(b.sb)}/${blindLabel(b.bb)}`;

  function chipSet(b) {
    const preset = BLINDS.find((x) => x.sb === b.sb && x.bb === b.bb);
    if (preset) return preset.chips;
    // custom blinds: smallest chip divides both blinds, then each chip >= 4x the last
    const d0 = [...LADDER].reverse().find((v) => b.sb % v === 0 && b.bb % v === 0) || 5;
    const set = [d0];
    while (set.length < 4) {
      const next = LADDER.find((v) => v >= set[set.length - 1] * 4);
      if (!next) break;
      set.push(next);
    }
    return set;
  }

  function chipBreakdown(amount, blinds) {
    let total = Math.round(amount * 100);
    if (!(total > 0) || !blinds) return null;
    const d = chipSet(blinds);
    const leftover = total % d[0];
    total -= leftover;
    const n = d.map(() => 0);
    n[0] = Math.floor(Math.min(blinds.bb * 10, total * 0.25) / d[0]);
    let rem = total - n[0] * d[0];
    if (d[2]) {
      const target = Math.min(rem, Math.round(total * 0.3), d[1] * 20);
      n[2] = Math.max(0, Math.floor((rem - target) / d[2]));
      rem -= n[2] * d[2];
    }
    if (d[1]) { n[1] = Math.floor(rem / d[1]); rem -= n[1] * d[1]; }
    n[0] += rem / d[0];
    if (d[3] && n[2] > 15 && d[3] % d[2] === 0) {
      const k = d[3] / d[2];
      n[3] = Math.floor((n[2] - 10) / k);
      n[2] -= n[3] * k;
    }
    const rows = d.map((c, i) => ({ cents: c, n: n[i], ...RANK[i] })).filter((r) => r.n > 0).reverse();
    return { rows, total: rows.reduce((a, r) => a + r.n, 0), leftover: leftover / 100, bbs: Math.floor(total / blinds.bb) };
  }

  function breakdownHTML(amount, players = 0, compact = false) {
    if (!state.blinds) return compact ? "" : `<div class="breakdown wait muted">Pick the blinds and chipme will tell you how many chips to hand out.</div>`;
    const b = chipBreakdown(amount, state.blinds);
    if (!b) return "";
    const rows = b.rows.map((r) => `
      <li>${chipHTML(r.color, blindLabel(r.cents), compact ? 28 : 34)}
        <span class="grow"><b class="num">${r.n}</b> × ${blindLabel(r.cents)} <span class="muted">${r.name}</span></span>
        ${compact ? "" : `<span class="num muted">${money((r.n * r.cents) / 100)}</span>`}</li>`).join("");
    const bank = players > 1 && !compact
      ? `<p class="muted bank">For ${players} players you'll need ${b.rows.map((r) => `${r.n * players} ${r.name}`).join(", ")}.</p>` : "";
    const left = b.leftover ? `<p class="muted bank">+ ${money(b.leftover)} that can't be made with chips.</p>` : "";
    const short = !compact && b.bbs < 40 ? `<p class="muted bank">Heads up: that's only ${b.bbs} big blinds, a short stack at ${blindsText(state.blinds)}.</p>` : "";
    return `<div class="breakdown ${compact ? "compact" : ""}">
      <div class="bd-head">${compact ? "That's" : "Give each player"} <b class="num">${b.total} chips</b> <span class="muted">· ${b.bbs} big blinds</span></div>
      <ul>${rows}</ul>${bank}${left}${short}</div>`;
  }

  /* ---------------- render ---------------- */
  // the entrance plays on a screen's first paint only, never on the re-renders a tap causes
  let shownStage = null;
  function render() {
    const order = ["setup", "table", "settle"];
    document.querySelectorAll("#steps span").forEach((el) => {
      const i = order.indexOf(el.dataset.step), cur = order.indexOf(state.stage);
      el.className = i === cur ? "on" : i < cur ? "done" : "";
    });
    const fresh = shownStage !== state.stage;
    shownStage = state.stage;
    app.classList.toggle("enter", fresh && !reduced);
    if (fresh) { seatPos = {}; boardShown = false; }
    if (state.stage === "setup") renderSetup(fresh);
    else if (state.stage === "table") renderTable(fresh);
    else renderSettle();
  }
  // moving between screens cross-fades (View Transitions where the browser has them)
  function go(mutator) {
    const run = () => { commit(mutator); scrollTo(0, 0); };
    if (document.startViewTransition && !reduced) return document.startViewTransition(run).finished.catch(() => {});
    run();
    return Promise.resolve();
  }
  const heading = (...lines) => `<h1>${lines.map((l) => `<span class="ln"><span>${l}</span></span>`).join("")}</h1>`;
  const sec = (label, body, d = 0) => `<section class="sec reveal" style="--d:${d}"><h2>${label}</h2><div>${body}</div></section>`;

  function avatar(p) {
    return `<span class="avatar" style="--av:${p.color}">${esc(initials(p.name))}</span>`;
  }

  // a clay chip seen from above: edge spots, darker inlay, gold value
  function chipHTML(color, label = "", size = 40, attrs = "") {
    const tone = color === "#f1ede3" ? " white" : color === "#f2c230" ? " yellow" : "";
    return `<span class="chip${tone}" style="--c:${color};--size:${size}px" ${attrs}><span>${label}</span></span>`;
  }
  // a chip stack seen from the side
  function stackHTML(n, color) {
    return `<span class="side-stack" style="--c:${color}">${"<i></i>".repeat(Math.max(1, n))}</span>`;
  }

  /* ----- the poker table: one seat per player, spaced evenly around the rail ----- */
  let seatPos = {};   // pid -> [x%, y%] from the last render, so seats glide when one is added
  // the table as a technical drawing: outer rail, felt edge, dashed betting line, ticks and a dimension line
  const PLAN = `<svg class="plan" viewBox="0 0 1000 560" aria-hidden="true">
      <rect class="rail-o d" pathLength="1" x="8" y="8" width="984" height="544" rx="272"/>
      <rect class="rail-i d" pathLength="1" x="44" y="44" width="912" height="472" rx="236"/>
      <rect class="bet" x="170" y="140" width="660" height="280" rx="140"/>
      <path class="tick" d="M500 44v14M500 502v14M44 280h14M942 280h14"/>
    </svg>`;
  function tableHTML(mode, draw) {
    const ps = state.players;
    const n = ps.length;
    const seats = ps.map((p, i) => {
      const a = Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
      const x = 50 + 50 * Math.cos(a), y = 50 + 50 * Math.sin(a);
      const sx = 50 + 32 * Math.cos(a), sy = 50 + 21 * Math.sin(a);   // stack spot on the felt
      const tin = totalIn(p.id);
      const stack = mode === "table" && tin > 0 && !p.busted
        ? `<div class="felt-stack" style="left:${sx}%;top:${sy}%">${stackHTML(Math.min(7, Math.max(2, Math.round((tin / state.buyIn) * 3))), CHIP_COLORS[i % 7])}</div>` : "";
      const code = `S-${String(i + 1).padStart(2, "0")}`;
      return `${stack}<div class="seat ${p.busted ? "out" : ""}" data-seat="${p.id}" data-x="${x}" data-y="${y}" style="left:${x}%;top:${y}%">
          ${avatar(p)}
          <span class="seat-tag"><i>${code}</i><b>${esc(p.name)}</b>${mode === "table" ? `<em>${p.busted ? "out" : money(tin)}</em>` : ""}</span>
          ${mode === "setup" ? `<button class="seat-x" data-rm="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>` : ""}
        </div>`;
    }).join("");
    const center = mode === "table"
      ? `<div class="felt-center" id="pot"><span class="felt-label">Total pot</span><span class="felt-pot" id="potTotal">${money(potTotal())}</span></div>`
      : `<div class="felt-center"><span class="felt-logo">chipme</span><span class="felt-label">${n ? `${String(n).padStart(2, "0")} seat${n === 1 ? "" : "s"} taken` : "Add a player to take a seat"}</span></div>`;
    const blinds = state.blinds ? blindsText(state.blinds) : "—";
    return `<div class="poker ${mode} ${draw && !reduced ? "draw" : ""}">
      <span class="poker-note tl">T-01 · No-limit hold'em</span>
      ${PLAN}${center}
      <div class="seats">${seats}</div>
      <span class="poker-note br">${String(n).padStart(2, "0")} seats · ${blinds}</span>
    </div>`;
  }
  function animateSeats() {
    const next = {};
    app.querySelectorAll(".seat").forEach((el) => {
      const id = el.dataset.seat, x = +el.dataset.x, y = +el.dataset.y;
      next[id] = [x, y];
      const prev = seatPos[id];
      if (reduced) return;
      if (!prev) el.classList.add("pop");
      else if (prev[0] !== x || prev[1] !== y)
        el.animate([{ left: prev[0] + "%", top: prev[1] + "%" }, { left: x + "%", top: y + "%" }], { duration: 600, easing: "cubic-bezier(.22,1,.36,1)" });
    });
    seatPos = next;
  }

  /* ----- setup ----- */
  let blindsCustomOpen = false;
  function renderSetup(fresh) {
    const custom = !PRESETS.includes(state.buyIn);
    const bl = state.blinds;
    const customBlinds = blindsCustomOpen || (bl && !BLINDS.some((b) => b.sb === bl.sb && b.bb === bl.bb));
    const n = state.players.length;
    app.innerHTML = `
      ${heading("Shuffle up", "and deal.")}
      <p class="sub">Seat your friends, pick the stakes, and chipme keeps the ledger.</p>

      <div class="reveal" style="--d:1">${tableHTML("setup", fresh)}</div>

      ${sec(`Players <span class="muted mono">${String(n).padStart(2, "0")}</span>`, `
        <form id="addForm" class="row">
          <input id="nameIn" class="input grow" placeholder="Friend's name" maxlength="24" autocomplete="off" aria-label="Friend's name" />
          <button class="btn primary" type="submit">Take a seat <kbd>↵</kbd></button>
        </form>
        ${n < 2 ? `<p class="muted hint">Seat at least two players to start. Press <kbd class="mono">N</kbd> to jump here.</p>` : ""}`, 2)}

      ${sec("Buy-in", `
        <div class="presets" id="presets">
          ${PRESETS.map((v, i) => `<button class="preset ${state.buyIn === v ? "sel" : ""}" data-v="${v}" aria-label="$${v} buy-in">${chipHTML(PRESET_COLORS[i], v, 64)}</button>`).join("")}
        </div>
        <div class="row custom-row">
          <label class="muted" for="customBuy">Custom</label>
          <div class="money grow"><input id="customBuy" class="input" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="Any amount" value="${custom ? state.buyIn : ""}" /></div>
        </div>`, 3)}

      ${sec("Blinds", `
        <div class="pills" id="blinds">
          ${BLINDS.map((b, i) => `<button class="pill ${bl && !customBlinds && bl.sb === b.sb && bl.bb === b.bb ? "sel" : ""}" data-b="${i}">${blindsText(b)}</button>`).join("")}
          <button class="pill ${customBlinds ? "sel" : ""}" data-b="custom">Custom</button>
        </div>
        ${customBlinds ? `
          <form class="row" id="customBlinds" style="margin-top:12px">
            <div class="money grow"><input id="sbIn" class="input" type="number" inputmode="decimal" min="0.05" step="0.05" placeholder="Small" aria-label="Small blind" value="${bl ? bl.sb / 100 : ""}" /></div>
            <span class="muted">/</span>
            <div class="money grow"><input id="bbIn" class="input" type="number" inputmode="decimal" min="0.05" step="0.05" placeholder="Big" aria-label="Big blind" value="${bl ? bl.bb / 100 : ""}" /></div>
            <button class="btn" type="submit">Set</button>
          </form>` : ""}
        ${breakdownHTML(state.buyIn, n)}`, 4)}

      <div class="bar"><div class="bar-inner">
        <button class="btn felt block" id="start" ${state.players.length < 2 || !(state.buyIn > 0) ? "disabled" : ""}>
          Deal everyone in · ${money(state.buyIn)} each <kbd>D</kbd>
        </button>
      </div></div>`;

    $("#presets").onclick = (e) => {
      const b = e.target.closest(".preset"); if (!b) return;
      commit((s) => { s.buyIn = +b.dataset.v; });
      chipBurst(app.querySelector(`.preset[data-v="${b.dataset.v}"]`), PRESET_COLORS[PRESETS.indexOf(+b.dataset.v)], 6);
    };
    $("#customBuy").onchange = (e) => {
      const v = cents(parseFloat(e.target.value));
      if (v > 0) commit((s) => { s.buyIn = v; });
    };
    $("#blinds").onclick = (e) => {
      const b = e.target.closest(".pill"); if (!b) return;
      if (b.dataset.b === "custom") { blindsCustomOpen = true; render(); $("#sbIn")?.focus(); return; }
      blindsCustomOpen = false;
      const { sb, bb } = BLINDS[+b.dataset.b];
      commit((s) => { s.blinds = { sb, bb }; });
    };
    const cb = $("#customBlinds");
    if (cb) cb.onsubmit = (e) => {
      e.preventDefault();
      const sb = Math.round(parseFloat($("#sbIn").value) * 100);
      const bb = Math.round(parseFloat($("#bbIn").value) * 100);
      if (!(sb > 0)) return $("#sbIn").focus();
      if (!(bb >= sb)) return $("#bbIn").focus();
      if (sb % 5 || bb % 5) return toast("Blinds need to be in 5¢ steps");
      commit((s) => { s.blinds = { sb, bb }; });
    };
    $("#addForm").onsubmit = (e) => {
      e.preventDefault();
      const name = $("#nameIn").value.trim();
      if (!name) return;
      if (state.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return toast(`${name} is already at the table`);
      commit((s) => s.players.push(newPlayer(name)));
      $("#nameIn").focus();
    };
    app.querySelectorAll("[data-rm]").forEach((b) => b.onclick = () => commit((s) => { s.players = s.players.filter((p) => p.id !== b.dataset.rm); }));
    animateSeats();
    $("#start").onclick = () => {
      go((s) => {
        s.stage = "table";
        s.startedAt = Date.now();
        s.players.forEach((p) => { if (!totalIn(p.id)) s.log.push({ id: uid(), pid: p.id, type: "buyin", amount: s.buyIn, ts: Date.now() }); });
      }).then(dealAnimation);
    };
  }

  function newPlayer(name) {
    return { id: uid(), name, color: AV_COLORS[state.players.length % AV_COLORS.length], busted: false, final: null };
  }

  /* ----- table ----- */
  let shownPot = null;   // the pot figure counts up to its new value instead of jumping
  function renderTable(fresh) {
    const total = potTotal();
    const active = state.players.filter((p) => !p.busted).length;
    const rebuys = state.log.filter((l) => l.type === "rebuy").length;

    app.innerHTML = `
      <div class="reveal" style="--d:0">${tableHTML("table", fresh)}</div>
      <div class="pot-meta reveal" style="--d:1">
        <span><b>${active}/${state.players.length}</b> playing</span>
        <span><b>${rebuys}</b> rebuy${rebuys === 1 ? "" : "s"}</span>
        <span><b>${money(state.buyIn)}</b> buy-in</span>
        ${state.blinds ? `<span><b>${blindsText(state.blinds)}</b> blinds</span>` : ""}
      </div>

      ${sec(`Players <span class="muted mono">${String(state.players.length).padStart(2, "0")}</span>`, `
        <div class="players" id="players">
          ${state.players.map((p) => {
            const n = entries(p.id);
            return `
            <div class="pcard ${p.busted ? "busted" : ""}" data-pid="${p.id}">
              ${avatar(p)}
              <div class="info">
                <div class="name">${esc(p.name)}${p.busted ? `<span class="tag bust">out</span>` : n > 1 ? `<span class="tag">×${n}</span>` : ""}</div>
                <div class="meta">${n} buy-in${n === 1 ? "" : "s"}</div>
              </div>
              <div class="in">${money(totalIn(p.id))}<small>in</small></div>
              <div class="actions">
                ${p.busted
                  ? `<button class="btn small felt" data-act="rebuy" data-pid="${p.id}">Buy back in</button>`
                  : `<button class="btn small" data-act="rebuy" data-pid="${p.id}">Rebuy</button>
                     <button class="btn small danger" data-act="bust" data-pid="${p.id}">Bust</button>`}
              </div>
            </div>`;
          }).join("")}
        </div>
        <div class="row wrap tools">
          <button class="btn small ghost" id="addLate">Add player <kbd>N</kbd></button>
          <button class="btn small ghost" id="changeBuy">Change buy-in</button>
          <span class="grow"></span>
          <button class="btn small ghost danger" id="reset">New game</button>
        </div>`, 2)}

      ${sec("Ledger", ledgerHTML(), 3)}

      <div class="bar"><div class="bar-inner">
        <button class="btn primary block" id="toSettle">Game over, count the chips <kbd>C</kbd></button>
      </div></div>`;
    countPot(fresh ? 0 : shownPot, total);

    app.querySelectorAll("[data-act]").forEach((b) => b.onclick = () => {
      const p = player(b.dataset.pid);
      if (b.dataset.act === "rebuy") openRebuy(p);
      else bust(p);
    });
    $("#addLate").onclick = openAddLate;
    $("#changeBuy").onclick = openChangeBuy;
    $("#reset").onclick = confirmReset;
    $("#toSettle").onclick = () => go((s) => { s.stage = "settle"; });
    bindLedger();
    animateSeats();
  }

  let potRaf = 0;
  function countPot(from, to) {
    const el = $("#potTotal");
    shownPot = to;
    if (!el) return;
    cancelAnimationFrame(potRaf);
    if (reduced || from == null || from === to) { el.textContent = money(to); return; }
    const t0 = performance.now(), dur = 700;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = money(Math.round((from + (to - from) * e) * 100) / 100);
      if (k < 1) potRaf = requestAnimationFrame(step);
    };
    el.textContent = money(from);
    potRaf = requestAnimationFrame(step);
  }

  function ledgerHTML() {
    if (!state.log.length) return `<div class="card empty">Nothing yet.</div>`;
    const label = { buyin: "bought in", rebuy: "rebought", bust: "busted out", back: "back in" };
    return `<details class="card"><summary>${state.log.length} entr${state.log.length === 1 ? "y" : "ies"}</summary>
      <ul class="ledger">${[...state.log].reverse().map((l) => {
        const p = player(l.pid); if (!p) return "";
        const amt = l.type === "buyin" || l.type === "rebuy";
        return `<li><span class="when">${time(l.ts)}</span><span class="grow"><b>${esc(p.name)}</b> ${label[l.type]}</span>
          ${amt ? `<span class="num">${money(l.amount)}</span>` : ""}
          <button class="x" data-del="${l.id}" aria-label="Delete entry">×</button></li>`;
      }).join("")}</ul></details>`;
  }
  function bindLedger() {
    app.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => {
      const l = state.log.find((x) => x.id === b.dataset.del);
      const p = player(l.pid);
      commit((s) => {
        s.log = s.log.filter((x) => x.id !== l.id);
        if (l.type === "bust") { const pp = s.players.find((x) => x.id === l.pid); if (pp) pp.busted = false; }
      }, { undoable: true, msg: `Removed ${p ? p.name + "'s " : ""}entry` });
      const d = app.querySelector("details.card"); if (d) d.open = true;
    });
  }

  function bust(p) {
    const card = app.querySelector(`.pcard[data-pid="${p.id}"]`);
    commit((s) => {
      s.players.find((x) => x.id === p.id).busted = true;
      s.log.push({ id: uid(), pid: p.id, type: "bust", amount: 0, ts: Date.now() });
    }, { undoable: true, msg: `${p.name} busted out` });
    bustAnimation(p, card);
  }

  function rebuy(p, amount) {
    const wasBusted = p.busted;
    commit((s) => {
      const pp = s.players.find((x) => x.id === p.id);
      pp.busted = false;
      s.log.push({ id: uid(), pid: p.id, type: "rebuy", amount, ts: Date.now() });
    }, { undoable: true, msg: `${p.name} rebought for ${money(amount)}` });
    rebuyAnimation(p, amount, wasBusted);
  }

  /* ----- settle ----- */
  function computeSettle() {
    const rows = state.players.map((p) => ({
      p, in: totalIn(p.id),
      final: p.final == null ? (p.busted ? 0 : null) : p.final,
    }));
    const missing = rows.filter((r) => r.final == null);
    const tin = rows.reduce((a, r) => a + r.in, 0);
    const tout = rows.reduce((a, r) => a + (r.final || 0), 0);
    const diff = cents(tout - tin);
    rows.forEach((r) => { r.net = cents((r.final || 0) - r.in); });
    return { rows, missing, tin, tout, diff };
  }

  function transfersFor(rows, diff) {
    // optionally absorb a mismatch evenly so the books close
    const adj = diff && state.settleAnyway ? diff / rows.length : 0;
    const bal = rows.map((r) => ({ name: r.p.name, color: r.p.color, v: cents(r.net - adj) }));
    const cred = bal.filter((b) => b.v > 0.004).sort((a, b) => b.v - a.v);
    const debt = bal.filter((b) => b.v < -0.004).map((b) => ({ ...b, v: -b.v })).sort((a, b) => b.v - a.v);
    const out = [];
    let i = 0, j = 0;
    while (i < debt.length && j < cred.length) {
      const amt = cents(Math.min(debt[i].v, cred[j].v));
      if (amt >= 0.01) out.push({ from: debt[i], to: cred[j], amt });
      debt[i].v = cents(debt[i].v - amt);
      cred[j].v = cents(cred[j].v - amt);
      if (debt[i].v < 0.01) i++;
      if (cred[j].v < 0.01) j++;
    }
    return out;
  }

  let boardShown = false;
  function renderSettle() {
    const { rows, missing, tin, tout, diff } = computeSettle();
    const balanced = !missing.length && Math.abs(diff) < 0.01;
    const canSettle = !missing.length && (balanced || state.settleAnyway);
    const transfers = canSettle ? transfersFor(rows, diff) : [];
    const ranked = [...rows].sort((a, b) => b.net - a.net);
    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
    const top = ranked[0], bottom = ranked[ranked.length - 1];
    const growBars = canSettle && !boardShown;   // the bars draw once, when the board first appears
    boardShown = canSettle;

    let balHTML;
    if (missing.length) {
      balHTML = `<div class="balance wait"><span class="icon">○</span><div><strong>Waiting on ${missing.length} stack${missing.length === 1 ? "" : "s"}</strong><span class="muted">${missing.map((r) => esc(r.p.name)).join(", ")}</span></div></div>`;
    } else if (balanced) {
      balHTML = `<div class="balance ok"><span class="icon">✓</span><div><strong>Everything balances</strong><span class="muted mono">${money(tout)} counted = ${money(tin)} bought in</span></div></div>`;
    } else {
      balHTML = `<div class="balance off"><span class="icon">▲</span><div class="grow"><strong>Off by ${money(Math.abs(diff))}, ${diff > 0 ? "too many chips" : "chips missing"}</strong>
        <span class="muted"><span class="mono">${money(tout)}</span> counted against <span class="mono">${money(tin)}</span> bought in. Recount, or split the difference evenly.</span>
        <label class="row"><input type="checkbox" id="anyway" ${state.settleAnyway ? "checked" : ""}/> Settle anyway (${money(Math.abs(diff) / rows.length)} per player)</label></div></div>`;
    }

    app.innerHTML = `
      ${heading("Count", "the chips.")}
      <p class="sub">Enter each final stack in dollars. Busted players already sit at $0.</p>

      ${sec("Final stacks", `<div class="card">
        ${rows.map((r) => `
          <div class="stack-row">
            <div class="row">${avatar(r.p)}<div class="grow"><div class="who">${esc(r.p.name)}</div>
              <div class="delta ${r.final == null ? "muted" : r.net > 0 ? "pos" : r.net < 0 ? "neg" : "muted"}" data-delta="${r.p.id}">in ${money(r.in)}${r.final == null ? "" : ` · ${money(r.net, true)}`}</div></div></div>
            <div class="money"><input class="input" type="number" inputmode="decimal" min="0" step="0.01" data-final="${r.p.id}" value="${r.final ?? ""}" placeholder="0" aria-label="${esc(r.p.name)}'s final stack" /></div>
          </div>`).join("")}
      </div>`, 2)}

      ${sec("Balance", balHTML, 3)}

      ${canSettle ? `
        ${sec("E-transfers", transfers.length
          ? `<ul class="transfers">${transfers.map((t) => `<li>
              <span class="avatar" style="--av:${t.from.color}">${esc(initials(t.from.name))}</span>
              <span><b>${esc(t.from.name)}</b><span class="arrow">→</span><b>${esc(t.to.name)}</b></span>
              <span class="amt">${money(t.amt)}</span></li>`).join("")}</ul>
             <div class="row" style="margin-top:12px"><button class="btn small" id="copy">Copy summary</button></div>`
          : `<div class="card empty">Everyone broke even. Nobody owes anything.</div>`, 4)}

        ${sec("Leaderboard", `
          <div class="podium">
            <div class="card"><div class="lbl"><span class="sym pos">▲</span>Top winner</div><div class="who">${esc(top.p.name)}</div><div class="amt ${top.net > 0 ? "pos" : ""}">${money(top.net, true)}</div></div>
            <div class="card"><div class="lbl"><span class="sym neg">▼</span>Biggest loser</div><div class="who">${esc(bottom.p.name)}</div><div class="amt ${bottom.net < 0 ? "neg" : ""}">${money(bottom.net, true)}</div></div>
          </div>
          <div class="card" style="margin-top:12px">
            <ul class="board ${growBars ? "grow" : ""}">${ranked.map((r, i) => {
              const w = (Math.abs(r.net) / maxAbs) * 50;
              return `<li><span class="rank">${String(i + 1).padStart(2, "0")}</span>${avatar(r.p)}<span class="nm">${esc(r.p.name)}</span>
                <span class="bar-wrap"><span class="bar-fill" style="${r.net >= 0 ? `left:50%;width:${w}%;background:var(--green);--o:left` : `right:50%;width:${w}%;background:var(--red);--o:right`}"></span></span>
                <span class="val ${r.net > 0 ? "pos" : r.net < 0 ? "neg" : "muted"}">${money(r.net, true)}</span></li>`;
            }).join("")}</ul>
          </div>`, 5)}` : ""}

      <div class="bar"><div class="bar-inner">
        <button class="btn" id="back">Back to table</button>
        <button class="btn primary grow" id="newGame">New game</button>
      </div></div>`;

    app.querySelectorAll("[data-final]").forEach((inp) => {
      inp.onchange = () => {
        const v = inp.value === "" ? null : Math.max(0, cents(parseFloat(inp.value)));
        const wasBalanced = balanced;
        const id = inp.dataset.final;
        commit((s) => { s.players.find((p) => p.id === id).final = Number.isFinite(v) ? v : null; });
        const now = computeSettle();
        if (!wasBalanced && !now.missing.length && Math.abs(now.diff) < 0.01) confetti();
        const next = app.querySelector(`[data-final="${id}"]`)?.closest(".stack-row")?.nextElementSibling?.querySelector("input");
        if (next && document.activeElement === document.body) next.focus();
      };
    });
    const any = $("#anyway"); if (any) any.onchange = () => commit((s) => { s.settleAnyway = any.checked; });
    const cp = $("#copy"); if (cp) cp.onclick = () => copySummary(transfers, ranked);
    $("#back").onclick = () => go((s) => { s.stage = "table"; });
    $("#newGame").onclick = confirmReset;
  }

  function copySummary(transfers, ranked) {
    const lines = ["♠ chipme settle-up", ""];
    transfers.forEach((t) => lines.push(`${t.from.name} → ${t.to.name}: ${money(t.amt)}`));
    lines.push("", "Results:");
    ranked.forEach((r) => lines.push(`${r.p.name}: ${money(r.net, true)}`));
    const text = lines.join("\n");
    (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast("Copied to clipboard"), () => {
      openModal(`<h3>Summary</h3><textarea class="input" rows="10" style="margin-top:12px">${esc(text)}</textarea><div class="row" style="margin-top:12px"><button class="btn primary block" data-close>Done</button></div>`);
    });
  }

  /* ---------------- modals ---------------- */
  function openModal(html, onOpen) {
    modal.innerHTML = `<div class="modal-body">${html}</div>`;
    modal.showModal();
    modal.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => modal.close());
    onOpen && onOpen(modal);
  }
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.close(); });

  function amountPicker(def) {
    const opts = [...new Set([def / 2, def, def * 1.5, def * 2].map(cents))].filter((v) => v > 0);
    return `<div class="quick">${opts.map((v) => `<button type="button" class="btn small ${v === def ? "primary" : ""}" data-q="${v}">${money(v)}</button>`).join("")}</div>
      <div class="money"><input id="amt" class="input num" type="number" inputmode="decimal" min="0.01" step="0.01" value="${def}" /></div>
      <div id="bd">${breakdownHTML(def, 0, true)}</div>`;
  }
  function bindPicker(m) {
    const amt = $("#amt", m);
    const bd = $("#bd", m);
    const refresh = () => { if (bd) bd.innerHTML = breakdownHTML(parseFloat(amt.value), 0, true); };
    amt.addEventListener("input", () => {
      refresh();
      m.querySelectorAll("[data-q]").forEach((x) => x.classList.toggle("primary", +x.dataset.q === +amt.value));
    });
    m.querySelectorAll("[data-q]").forEach((b) => b.onclick = () => {
      amt.value = b.dataset.q;
      m.querySelectorAll("[data-q]").forEach((x) => x.classList.toggle("primary", x === b));
      refresh();
    });
    amt.select();
    return amt;
  }

  function openRebuy(p) {
    openModal(`
      <form id="f">
        <h3>${p.busted ? "Back in" : "Rebuy"} · ${esc(p.name)}</h3>
        <p class="muted" style="margin:0">Same as the buy-in, or more / less.</p>
        ${amountPicker(state.buyIn)}
        <div class="row" style="margin-top:14px"><button type="button" class="btn" data-close>Cancel</button><button class="btn felt grow">Rebuy</button></div>
      </form>`, (m) => {
      const amt = bindPicker(m);
      $("#f", m).onsubmit = (e) => {
        e.preventDefault();
        const v = cents(parseFloat(amt.value));
        if (!(v > 0)) return amt.focus();
        modal.close();
        rebuy(player(p.id), v);
      };
    });
  }

  function openAddLate() {
    openModal(`
      <form id="f">
        <h3>Pull up a chair</h3>
        <input id="nm" class="input" placeholder="Name" maxlength="24" style="margin-top:12px" autocomplete="off" />
        ${amountPicker(state.buyIn)}
        <div class="row" style="margin-top:14px"><button type="button" class="btn" data-close>Cancel</button><button class="btn felt grow">Buy in</button></div>
      </form>`, (m) => {
      const amt = bindPicker(m);
      $("#nm", m).focus();
      $("#f", m).onsubmit = (e) => {
        e.preventDefault();
        const name = $("#nm", m).value.trim();
        const v = cents(parseFloat(amt.value));
        if (!name) return $("#nm", m).focus();
        if (state.players.some((x) => x.name.toLowerCase() === name.toLowerCase())) return toast(`${name} is already at the table`);
        if (!(v > 0)) return amt.focus();
        modal.close();
        const p = newPlayer(name);
        commit((s) => {
          s.players.push(p);
          s.log.push({ id: uid(), pid: p.id, type: "buyin", amount: v, ts: Date.now() });
        }, { undoable: true, msg: `${name} bought in for ${money(v)}` });
        buyInAnimation(p, v);
      };
    });
  }

  function openChangeBuy() {
    openModal(`
      <form id="f">
        <h3>Default buy-in</h3>
        <p class="muted" style="margin:0">Used as the default for new players and rebuys. Past entries don't change.</p>
        ${amountPicker(state.buyIn)}
        <div class="row" style="margin-top:14px"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary grow">Save</button></div>
      </form>`, (m) => {
      const amt = bindPicker(m);
      $("#f", m).onsubmit = (e) => {
        e.preventDefault();
        const v = cents(parseFloat(amt.value));
        if (!(v > 0)) return amt.focus();
        modal.close();
        commit((s) => { s.buyIn = v; }, { msg: `Buy-in is now ${money(v)}` });
      };
    });
  }

  function confirmReset() {
    openModal(`
      <h3>Start a new game?</h3>
      <p class="muted">This clears the current ledger. Your player list stays so you can run it back.</p>
      <div class="row" style="margin-top:14px"><button class="btn" data-close>Cancel</button><button class="btn danger" id="wipe">Clear all</button><button class="btn primary grow" id="keep">Keep players</button></div>`, (m) => {
      const go = (keep) => {
        modal.close();
        go((s) => {
          const players = keep ? s.players.map((p) => ({ ...p, busted: false, final: null })) : [];
          Object.assign(s, fresh(), { buyIn: s.buyIn, players });
        }, { undoable: true, msg: "New game" });
      };
      $("#keep", m).onclick = () => go(true);
      $("#wipe", m).onclick = () => go(false);
    });
  }

  /* ---------------- toast ---------------- */
  let toastTimer;
  function toast(msg, undo = false) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button id="undo">Undo</button>` : ""}`;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), undo ? 5000 : 2200);
    const u = $("#undo");
    if (u) u.onclick = () => {
      if (!undoSnap) return;
      state = JSON.parse(undoSnap); undoSnap = null;
      save(); render();
      t.classList.remove("show");
    };
  }

  /* ---------------- animations ---------------- */
  const rand = (a, b) => a + Math.random() * (b - a);
  function spawn(cls, html = "", style = {}) {
    const el = document.createElement("div");
    el.className = cls; el.innerHTML = html;
    Object.assign(el.style, style);
    fx.appendChild(el);
    return el;
  }
  function animate(el, frames, opts) {
    if (reduced) { el.remove(); return; }
    const a = el.animate(frames, { fill: "forwards", ...opts });
    a.onfinish = () => el.remove();
    return a;
  }
  function center(el) {
    if (!el) return { x: innerWidth / 2, y: innerHeight / 2 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function bumpPot() {
    const t = $("#potTotal"); if (!t) return;
    t.classList.remove("bump"); void t.offsetWidth; t.classList.add("bump");
  }

  // chips fly from a source to the pot
  function chipsToPot(fromEl, count, color) {
    const pot = $("#pot");
    const a = center(fromEl), b = center(pot);
    for (let i = 0; i < count; i++) {
      const c = color || CHIP_COLORS[i % CHIP_COLORS.length];
      const el = spawn("fx-chip", "", { left: a.x - 15 + "px", top: a.y - 15 + "px" });
      el.style.setProperty("--c", c);
      const dx = b.x - a.x + rand(-30, 30), dy = b.y - a.y + rand(-12, 12);
      const mx = dx / 2 + rand(-30, 30), my = Math.min(dy / 2, 0) - rand(40, 80);
      animate(el, [
        { transform: "translate(0,0) scale(.5)", opacity: 0 },
        { transform: `translate(${mx}px,${my}px) scale(.9)`, opacity: 1, offset: .45 },
        { transform: `translate(${dx}px,${dy}px) scale(.6)`, opacity: 0 },
      ], { duration: rand(750, 950), delay: i * 50, easing: "cubic-bezier(.65,0,.35,1)" });
    }
    setTimeout(bumpPot, reduced ? 0 : 700);
  }

  function floatText(text, at, color) {
    const el = spawn("fx-float", esc(text), { left: at.x + "px", top: at.y + "px", color });
    animate(el, [
      { transform: "translate(-50%,-30%)", opacity: 0 },
      { transform: "translate(-50%,-110%)", opacity: 1, offset: .3 },
      { transform: "translate(-50%,-190%)", opacity: 0 },
    ], { duration: 1300, easing: "cubic-bezier(.22,1,.36,1)" });
  }

  function chipBurst(fromEl, color, n = 8) {
    const a = center(fromEl);
    for (let i = 0; i < n; i++) {
      const el = spawn("fx-chip", "", { left: a.x - 15 + "px", top: a.y - 15 + "px" });
      el.style.setProperty("--c", color || CHIP_COLORS[i % CHIP_COLORS.length]);
      const ang = (Math.PI * 2 * i) / n + rand(-.2, .2), d = rand(44, 80);
      animate(el, [
        { transform: "translate(0,0) scale(.4)", opacity: 0 },
        { transform: `translate(${Math.cos(ang) * d}px,${Math.sin(ang) * d}px) scale(.75)`, opacity: 1, offset: .55 },
        { transform: `translate(${Math.cos(ang) * d * 1.15}px,${Math.sin(ang) * d * 1.15}px) scale(.6)`, opacity: 0 },
      ], { duration: 700, easing: "cubic-bezier(.22,1,.36,1)" });
    }
  }

  // a word rises out of its mask, holds, and lifts away
  function banner(text, color = "var(--ink)") {
    const el = spawn("fx-banner", `<span>${esc(text)}</span>`, { color });
    if (reduced) { el.remove(); return; }
    el.firstChild.animate([
      { transform: "translateY(110%)" },
      { transform: "translateY(0)", offset: .28 },
      { transform: "translateY(0)", offset: .74 },
      { transform: "translateY(-110%)" },
    ], { duration: 1500, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" }).onfinish = () => el.remove();
  }

  // BUY-IN: chips leave every seat for the pot
  function dealAnimation() {
    requestAnimationFrame(() => {
      banner("Shuffle up");
      state.players.forEach((p, i) => {
        setTimeout(() => {
          const seat = app.querySelector(`.seat[data-seat="${p.id}"] .avatar`);
          app.querySelector(`.pcard[data-pid="${p.id}"]`)?.classList.add("flash-in");
          chipsToPot(seat, 3, CHIP_COLORS[i % CHIP_COLORS.length]);
        }, 200 + i * 110);
      });
    });
  }
  function buyInAnimation(p, amount) {
    requestAnimationFrame(() => {
      const card = app.querySelector(`.pcard[data-pid="${p.id}"]`);
      if (card) card.classList.add("flash-in");
      const seat = app.querySelector(`.seat[data-seat="${p.id}"] .avatar`);
      floatText(`+${money(amount)}`, center(seat), "var(--green)");
      chipsToPot(seat, 6, p.color);
      banner(`Welcome, ${p.name}`);
    });
  }

  // REBUY: the seat sends chips to the pot; a busted player comes back
  function rebuyAnimation(p, amount, wasBusted) {
    requestAnimationFrame(() => {
      const card = app.querySelector(`.pcard[data-pid="${p.id}"]`);
      if (card) { card.classList.remove("flash-in"); void card.offsetWidth; card.classList.add("flash-in"); }
      const seat = app.querySelector(`.seat[data-seat="${p.id}"] .avatar`);
      floatText(`+${money(amount)}`, center(seat), "var(--green)");
      chipBurst(seat, null, 8);
      setTimeout(() => chipsToPot(seat, Math.min(10, 3 + Math.round(amount / state.buyIn) * 2)), 200);
      banner(wasBusted ? "Back from the dead" : amount > state.buyIn ? "Reloading" : "Rebuy");
    });
  }

  // BUST: the card shudders once, thin red fracture lines draw out from the seat and fade
  function bustAnimation(p, oldCard) {
    requestAnimationFrame(() => {
      const card = app.querySelector(`.pcard[data-pid="${p.id}"]`);
      if (card) card.classList.add("shake");
      const seat = app.querySelector(`.seat[data-seat="${p.id}"] .avatar`);
      const at = center(seat || card || oldCard);
      if (reduced) return;
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "fx-crack");
      svg.setAttribute("width", innerWidth); svg.setAttribute("height", innerHeight);
      for (let i = 0; i < 7; i++) {
        let x = at.x, y = at.y, d = `M${x},${y}`;
        const ang = (Math.PI * 2 * i) / 7 + rand(-.25, .25);
        for (let s = 0; s < 4; s++) {
          const len = rand(26, 56), a2 = ang + rand(-.45, .45);
          x += Math.cos(a2) * len; y += Math.sin(a2) * len; d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
        }
        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", d); path.setAttribute("fill", "none");
        path.setAttribute("stroke", "var(--red)"); path.setAttribute("stroke-width", "1.2");
        path.setAttribute("pathLength", "1");
        path.style.strokeDasharray = 1; path.style.strokeDashoffset = 1;
        path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 420, delay: i * 25, fill: "forwards", easing: "cubic-bezier(.22,1,.36,1)" });
        svg.appendChild(path);
      }
      fx.appendChild(svg);
      svg.animate([{ opacity: 1 }, { opacity: 1, offset: .55 }, { opacity: 0 }], { duration: 1400, fill: "forwards" }).onfinish = () => svg.remove();
      banner(`${p.name} is out`, "var(--red)");
    });
  }

  function confetti() {
    if (reduced) return;
    for (let i = 0; i < 28; i++) {
      const el = spawn("fx-chip", "", { left: innerWidth / 2 - 11 + "px", top: innerHeight * .42 + "px", width: "22px", height: "22px" });
      el.style.setProperty("--c", CHIP_COLORS[i % CHIP_COLORS.length]);
      const ang = -Math.PI / 2 + rand(-1.1, 1.1), v = rand(160, 320);
      const dx = Math.cos(ang) * v, dy = Math.sin(ang) * v;
      animate(el, [
        { transform: "translate(0,0) scale(.5)", opacity: 0 },
        { transform: `translate(${dx}px,${dy}px) scale(1)`, opacity: 1, offset: .45 },
        { transform: `translate(${dx * 1.1}px,${dy + 260}px) scale(.8)`, opacity: 0 },
      ], { duration: rand(1300, 1800), delay: rand(0, 120), easing: "cubic-bezier(.22,1,.36,1)" });
    }
    banner("Balanced", "var(--green)");
  }

  // shortcuts: N seat or add a player, D deal, C count the chips; never while typing or in a dialog
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || modal.open) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === "n") {
      e.preventDefault();
      if (state.stage === "setup") $("#nameIn")?.focus();
      else if (state.stage === "table") openAddLate();
    } else if (k === "d" && state.stage === "setup") {
      const b = $("#start"); if (b && !b.disabled) b.click();
    } else if (k === "c" && state.stage === "table") {
      $("#toSettle")?.click();
    }
  });

  $("#brand").onclick = () => { if (state.stage !== "setup" && !state.log.length) commit((s) => { s.stage = "setup"; }); };

  render();
})();
