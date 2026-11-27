/* chipme — poker buy-in counter & settle-up ledger.
   Everything lives in localStorage so a refresh never loses the game. */
(() => {
  "use strict";

  const KEY = "chipme:v1";
  // finished games live under their own key, so starting a new game never touches them
  const HKEY = "chipme:history";
  const loadHistory = () => { try { const h = JSON.parse(localStorage.getItem(HKEY)); return Array.isArray(h) ? h : []; } catch (_) { return []; } };
  const saveHistory = (h) => { try { localStorage.setItem(HKEY, JSON.stringify(h)); return true; } catch (_) { return false; } };
  const PRESETS = [20, 25, 50];
  // clay-chip palette (edge spots + inlay are derived from the base colour in CSS)
  const CHIP_COLORS = ["#d63a3a", "#1f8fd6", "#1e9b4a", "#f07a2c", "#232325", "#5b3aa6", "#f2c230", "#f1ede3"];
  const PRESET_COLORS = ["#1f8fd6", "#1e9b4a", "#f07a2c"];   // $20 blue, $25 green, $50 orange
  const CUSTOM_COLOR = "#6b4aa0";                            // the purple C chip: type your own
  // blind levels offered on the setup page (cents); the chip set itself comes from chips.js
  const BLINDS = [
    { sb: 10, bb: 20 }, { sb: 25, bb: 50 }, { sb: 50, bb: 100 }, { sb: 100, bb: 200 }, { sb: 200, bb: 500 },
  ];
  // one colour per chip value; the smallest chip in a game is always white
  const WHITE = { name: "white", color: "#f1ede3" };
  const LOOK = {
    5: { name: "pink", color: "#e07a9a" }, 10: { name: "sky", color: "#5aa3d6" }, 20: { name: "yellow", color: "#f2c230" },
    25: { name: "purple", color: "#7a56a8" }, 50: { name: "orange", color: "#f07a2c" }, 100: { name: "red", color: "#d63a3a" },
    200: { name: "blue", color: "#2b6cb8" }, 500: { name: "green", color: "#1e9b4a" }, 1000: { name: "teal", color: "#1f8f86" },
    2500: { name: "black", color: "#232325" }, 10000: { name: "grey", color: "#8a8e96" },
  };
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
    savedId: null,           // the past-games record this game was saved as
    buyInPicked: false,      // setup asks one thing at a time: players, buy-in, blinds, chips
    setupStep: "players",    // the setup screen showing: players | buyin | blinds | chips
  });

  let state = load();
  let undoSnap = null;

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && Array.isArray(s.players)) {
        if (s.buyInPicked === undefined) s.buyInPicked = !!s.blinds || s.stage !== "setup";
        return { ...fresh(), ...s };
      }
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
  const totalOut = (pid) => state.log.filter((l) => l.pid === pid && l.type === "cashout").reduce((a, l) => a + l.amount, 0);
  // money in play: everything bought in, less what players took home when they cashed out early
  const inPlay = () => state.players.reduce((a, p) => a + totalIn(p.id) - totalOut(p.id), 0);
  const seated = (p) => !p.busted && !p.left;
  const entries = (pid) => state.log.filter((l) => l.pid === pid && (l.type === "buyin" || l.type === "rebuy")).length;
  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  /* ---------------- blinds & chip breakdown (cents) ---------------- */
  const blindLabel = (c) => (c < 100 ? `${c}¢` : money(c / 100));
  const blindsText = (b) => `${blindLabel(b.sb)}/${blindLabel(b.bb)}`;

  // The table's chip set is planned once from the blinds and the main buy-in, so everyone plays
  // with the same chips; a rebuy of another size is counted in that same set.
  const planCache = new Map();
  // The chips a game can use: the ones the blinds need are always in (the smallest chip that
  // divides both blinds, plus a chip for each blind); the host picks the rest and the highest chip.
  function chipOptions(blinds) {
    const C = ChipOpt.CANDS;
    const d0 = [...C].reverse().find((v) => blinds.sb % v === 0 && blinds.bb % v === 0) || 5;
    const required = [...new Set([d0, blinds.sb, blinds.bb].filter((v) => C.includes(v)))].sort((a, b) => a - b);
    const values = C.filter((v) => v >= d0 && v % d0 === 0);
    return { d0, required, values, tops: values.filter((v) => v >= required[required.length - 1]) };
  }
  // the chips in use: the host's pick for these blinds, else the optimiser's suggestion
  function chipSetFor(blinds) {
    const key = `${blinds.sb}/${blinds.bb}`;
    if (state.chips && state.chips.key === key) return state.chips.set;
    const { required } = chipOptions(blinds);
    const T = Math.round(state.buyIn * 100);
    const k = `${key}/${T}`;
    if (!planCache.has(k)) planCache.set(k, ChipOpt.plan(blinds, T));
    return [...new Set([...planCache.get(k).set, ...required])].sort((a, b) => a - b);
  }
  // counts for `T` cents in the chosen set; a stack too small for every chip drops the biggest
  // ones first, so players still get small chips to post blinds and make change
  function countsIn(set, T, bb) {
    for (let k = set.length; k >= 1; k--) {
      const c = ChipOpt.counts(set.slice(0, k), T, bb);
      if (c) return set.map((_, i) => c.n[i] || 0);
    }
    const c = ChipOpt.counts(set, T, bb, false);
    return c ? c.n : set.map((d, i) => (i === 0 ? T / d : 0));
  }
  function tablePlan(blinds) {
    const set = chipSetFor(blinds);
    const T = Math.round(state.buyIn * 100);
    const t = T - (T % set[0]);
    return { set, n: countsIn(set, t, blinds.bb) };
  }
  function chipsHTML(blinds) {
    const { required, values } = chipOptions(blinds);
    const set = chipSetFor(blinds);
    const top = set[set.length - 1];
    const shown = [...new Set([...values.filter((v) => v <= top), ...set])].sort((a, b) => a - b);
    const gaps = set.slice(1).map((v, i) => [set[i], v]).filter(([a, b]) => b / a > 5);
    return `
      <div class="pills" id="denoms">
        ${shown.map((v) => required.includes(v)
          ? `<button class="pill sel locked" type="button" disabled title="Needed for the blinds">${blindLabel(v)}</button>`
          : `<button class="pill ${set.includes(v) ? "sel" : ""}" type="button" data-d="${v}" aria-pressed="${set.includes(v)}">${blindLabel(v)}</button>`).join("")}
      </div>
      <form class="chip-fields" id="chipFields">
        <label class="inline-field"><span class="muted">Highest chip</span>
          <span class="money"><input id="topChip" class="input" type="number" inputmode="decimal" min="0.05" step="0.05" value="${top / 100}" /></span></label>
        ${otherChipOpen
          ? `<span class="inline-field unfold-in"><span class="money"><input id="addChip" class="input" type="number" inputmode="decimal" min="0.05" step="0.05" placeholder="Other value" aria-label="Another chip value" /></span><button class="btn" type="submit">Add</button></span>`
          : `<button class="btn small ghost" type="button" id="otherChip">+ Other value</button>`}
      </form>
      ${gaps.length ? `<p class="muted hint">Big jump from ${gaps.map(([a, b]) => `${blindLabel(a)} to ${blindLabel(b)}`).join(" and ")}: making change will take a lot of small chips.</p>` : ""}`;
  }
  // values outside the usual ones (a $3 or $50 chip) borrow a spare colour
  const SPARE = [{ name: "brown", color: "#8a5a3c" }, { name: "pink", color: "#d0658e" }, { name: "navy", color: "#2c3e6b" }, { name: "lime", color: "#7fae3a" }, { name: "grey", color: "#8a8e96" }];
  const chipLook = (set) => {
    let k = 0;
    return set.map((c, i) => (i === 0 ? WHITE : LOOK[c] || SPARE[k++ % SPARE.length]));
  };

  function chipBreakdown(amount, blinds) {
    let total = Math.round(amount * 100);
    if (!(total > 0) || !blinds) return null;
    const { set, n: planned } = tablePlan(blinds);
    const leftover = total % set[0];
    total -= leftover;
    let n = planned;
    if (total !== Math.round(state.buyIn * 100) - (Math.round(state.buyIn * 100) % set[0])) {
      n = countsIn(set, total, blinds.bb);
    }
    const look = chipLook(set);
    const rows = set.map((c, i) => ({ cents: c, n: n[i], ...look[i] })).filter((r) => r.n > 0).reverse();
    const unused = set.filter((c, i) => !n[i] && c > Math.max(...set.filter((_, j) => n[j])));
    return { rows, unused, total: rows.reduce((a, r) => a + r.n, 0), leftover: leftover / 100, bbs: Math.floor(total / blinds.bb) };
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
    const lots = !compact && b.total > 60 ? `<p class="bank warn">That's ${b.total} chips each: too many to play with. Add a bigger chip value.</p>` : "";
    const box = !compact && b.unused.length ? `<p class="muted bank">${b.unused.map(blindLabel).join(" and ")} chips stay in the box: too big to hand out at this buy-in.</p>` : "";
    const short = !compact && b.bbs < 40 ? `<p class="muted bank">Heads up: that's only ${b.bbs} big blinds, a short stack at ${blindsText(state.blinds)}.</p>` : "";
    return `<div class="breakdown ${compact ? "compact" : ""}">
      <div class="bd-head">${compact ? "That's" : "Give each player"} <b class="num">${b.total} chips</b> <span class="muted">· ${b.bbs} big blinds</span></div>
      <ul>${rows}</ul>${lots}${bank}${left}${box}${short}</div>`;
  }

  /* ---------------- render ---------------- */
  // the entrance plays on a screen's first paint only, never on the re-renders a tap causes
  let shownStage = null;
  let home = false;   // the home screen sits over a saved game without touching it
  const gameOn = () => state.stage !== "setup" || state.log.length > 0;
  function render() {
    const screen = home ? "home" : state.stage === "setup" ? `setup:${setupStep()}` : state.stage;
    const fresh = shownStage !== screen;
    shownStage = screen;
    app.classList.toggle("enter", fresh && !reduced);
    if (fresh) { seatPos = {}; boardShown = false; }
    if (home) renderHome();
    else if (state.stage === "setup") renderSetup(fresh);
    else if (state.stage === "table") renderTable(fresh);
    else renderSettle();
  }
  // moving between screens cross-fades (View Transitions where the browser has them)
  function go(mutator, opts) {
    const run = () => { commit(mutator, opts); scrollTo(0, 0); };
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
  function chipHTML(color, label = "", size = 40, attrs = "", style = "") {
    const tone = color === "#f1ede3" ? " white" : color === "#f2c230" ? " yellow" : "";
    return `<span class="chip${tone}" style="--c:${color};--size:${size}px;${style}" ${attrs}><span>${label}</span></span>`;
  }
  // a chip stack seen from the side
  function stackHTML(n, color) {
    return `<span class="side-stack" style="--c:${color}">${"<i></i>".repeat(Math.max(1, n))}</span>`;
  }
  // a player's chips on the felt: one round stack per denomination, overlapping like a venn
  // diagram, seen at an angle (flattened faces, striped edges built from stacked shadows)
  const VENN = { 1: [[0, 0]], 2: [[-10, 1], [10, -1]], 3: [[0, -6], [12, 4], [-12, 4]], 4: [[0, -8], [13, 0], [-13, 0], [0, 8]] };
  function clusterHTML(amount, fallbackColor) {
    const b = state.blinds && chipBreakdown(amount, state.blinds);
    const rows = b ? b.rows.slice(0, 4) : [{ color: fallbackColor, n: Math.max(4, Math.round((amount / state.buyIn) * 8)) }];
    const spots = VENN[rows.length];
    const stacks = rows.map((r, k) => {
      const layers = Math.min(7, Math.max(1, Math.ceil(r.n / 4)));
      const edge = [];
      for (let l = 1; l <= layers; l++) edge.push(`0 ${l * 2.4}px 0 ${l % 2 ? `color-mix(in srgb, ${r.color} 72%, #000)` : `color-mix(in srgb, ${r.color} 55%, #fff)`}`);
      edge.push(`0 ${layers * 2.4 + 3}px 5px rgba(0,0,0,.28)`);
      const [x, y] = spots[k];
      return { y, html: `<span class="s3" style="--x:${x}px;--y:${y - layers * 1.3}px">${chipHTML(r.color, "", 28, "", `box-shadow:${edge.join(",")}`)}</span>` };
    }).sort((a, c) => a.y - c.y);
    return `<span class="cluster">${stacks.map((s) => s.html).join("")}</span>`;
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
      const sx = 50 + 32 * Math.cos(a), sy = 48 + 19 * Math.sin(a);   // stack spot on the felt
      const tin = totalIn(p.id);
      const stack = mode === "table" && tin > 0 && seated(p)
        ? `<div class="felt-stack" style="left:${sx}%;top:${sy}%">${clusterHTML(tin, CHIP_COLORS[i % 7])}</div>` : "";
      const tag = p.left ? `left · ${money(totalOut(p.id))}` : p.busted ? "out" : money(tin);
      const code = `S-${String(i + 1).padStart(2, "0")}`;
      return `${stack}<div class="seat ${seated(p) ? "" : "out"} ${p.left ? "left" : ""}" data-seat="${p.id}" data-x="${x}" data-y="${y}" style="left:${x}%;top:${y}%">
          ${avatar(p)}
          <span class="seat-tag"><i>${code}</i><b>${esc(p.name)}</b>${mode === "table" ? `<em>${tag}</em>` : ""}</span>
          ${mode === "setup" ? `<button class="seat-x" data-rm="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>` : ""}
        </div>`;
    }).join("");
    const label = mode === "table"
      ? (state.blinds ? `No-limit · ${blindsText(state.blinds)}` : "No-limit hold'em")
      : n ? `${String(n).padStart(2, "0")} seat${n === 1 ? "" : "s"} taken` : "Add a player to take a seat";
    const center = `<div class="felt-center"><span class="felt-logo">chipme</span><span class="felt-label">${label}</span></div>`;
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
        el.animate([{ left: prev[0] + "%", top: prev[1] + "%" }, { left: x + "%", top: y + "%" }], { duration: 800, easing: "cubic-bezier(.22,1,.36,1)" });
    });
    seatPos = next;
  }

  /* ----- home: the game in progress waits here untouched, with past games under it ----- */
  const fmtDate = (ts) => new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  function pastGamesHTML() {
    const hist = loadHistory().sort((a, b) => b.date - a.date);
    if (!hist.length) return `<div class="card empty">No saved games yet. Save one from the cash-out screen when a game ends.</div>`;
    return `<div class="history">${hist.map((g) => `
      <details class="card game">
        <summary>
          <span class="g-head"><b>${fmtDate(g.date)}</b><span class="muted mono">${g.blinds ? blindsText(g.blinds) : "No blinds set"} · ${g.players.length} players · ${money(g.total)} in</span></span>
          <span class="g-res mono"><span><span class="pos">▲</span> ${esc(g.winner.name)} <span class="pos">${money(g.winner.net, true)}</span></span><span><span class="neg">▼</span> ${esc(g.loser.name)} <span class="neg">${money(g.loser.net, true)}</span></span></span>
        </summary>
        <table class="g-table">
          <thead><tr><th>Player</th><th>Bought in</th><th>Left with</th><th>Result</th></tr></thead>
          <tbody>${[...g.players].sort((a, b) => b.net - a.net).map((p) => `<tr>
            <td>${esc(p.name)}${p.buyins > 1 ? ` <span class="muted mono">×${p.buyins}</span>` : ""}</td>
            <td class="mono">${money(p.in)}</td><td class="mono">${money(p.out)}</td>
            <td class="mono ${p.net > 0 ? "pos" : p.net < 0 ? "neg" : "muted"}">${money(p.net, true)}</td></tr>`).join("")}</tbody>
        </table>
        ${g.transfers && g.transfers.length ? `<p class="muted g-pay">${g.transfers.map((t) => `${esc(t.from)} → ${esc(t.to)} ${money(t.amt)}`).join(" · ")}</p>` : ""}
        <div class="row"><span class="grow"></span><button class="btn small ghost danger" data-delgame="${g.id}">Delete</button></div>
      </details>`).join("")}</div>`;
  }
  function renderHome() {
    const where = { setup: "Seating players", table: "Playing", settle: "Counting chips" }[state.stage];
    const n = state.players.length;
    const started = state.startedAt ? time(state.startedAt) : null;
    const hist = loadHistory();
    app.innerHTML = `
      ${heading("chipme")}
      <p class="sub">Buy-ins, rebuys and the settle-up for a home poker game.</p>
      ${gameOn() ? sec("Game in progress", `
        <div class="card saved">
          <div class="saved-row"><span class="muted">Status</span><b>${where}</b></div>
          <div class="saved-row"><span class="muted">Players</span><b>${n ? state.players.map((p) => esc(p.name)).join(", ") : "None yet"}</b></div>
          <div class="saved-row"><span class="muted">Money in play</span><b class="mono">${money(inPlay())}</b></div>
          ${started ? `<div class="saved-row"><span class="muted">Dealt</span><b class="mono">${started}</b></div>` : ""}
        </div>
        <div class="row wrap" style="margin-top:14px">
          <button class="btn primary" id="resume">Resume game <kbd>↵</kbd></button>
          <button class="btn" id="fresh">Start a new game</button>
        </div>`, 2) : sec("Game in progress", `
        <p class="muted lead-in">Nothing on the table right now.</p>
        <button class="btn primary" id="resume">Set up a game</button>`, 2)}
      ${sec(`Past games <span class="muted mono">${String(hist.length).padStart(2, "0")}</span>`, pastGamesHTML(), 3)}`;
    $("#resume").onclick = leaveHome;
    const f = $("#fresh"); if (f) f.onclick = confirmReset;
    app.querySelectorAll("[data-delgame]").forEach((b) => b.onclick = () => {
      const all = loadHistory(), gone = all.find((g) => g.id === b.dataset.delgame);
      saveHistory(all.filter((g) => g.id !== gone.id));
      if (state.savedId === gone.id) commit((s) => { s.savedId = null; });
      render();
      toast(`Deleted the game from ${fmtDate(gone.date)}`, () => { saveHistory([...loadHistory(), gone]); render(); });
    });
    $("#resume").focus({ preventScroll: true });
  }
  function screenSwap(fn) {
    if (document.startViewTransition && !reduced) document.startViewTransition(() => { fn(); scrollTo(0, 0); });
    else { fn(); scrollTo(0, 0); }
  }
  function leaveHome() { screenSwap(() => { home = false; render(); }); }
  function openHome() {
    if (!gameOn() && !loadHistory().length) { scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" }); return; }
    if (home) return;
    screenSwap(() => { home = true; render(); });
  }

  /* ----- setup ----- */
  let blindsCustomOpen = false;
  // Setup is four short screens, one question each: who's playing, the buy-in, the blinds, the
  // chips. A thin row at the top shows the answers so far and steps back to any of them.
  const SETUP = [["players", "Players"], ["buyin", "Buy-in"], ["blinds", "Blinds"], ["chips", "Chips"]];
  let customBuyOpen = false, otherChipOpen = false;
  function canReach(k) {
    const two = state.players.length >= 2;
    return k === "players" || (k === "buyin" && two) || (k === "blinds" && two && state.buyInPicked) || (k === "chips" && two && state.buyInPicked && !!state.blinds);
  }
  const setupStep = () => (canReach(state.setupStep) ? state.setupStep : "players");
  function toStep(k) {
    if (!canReach(k)) return;
    screenSwap(() => { state.setupStep = k; save(); render(); });
  }
  function crumbsHTML(step) {
    const answer = {
      players: state.players.length ? String(state.players.length) : "",
      buyin: state.buyInPicked ? money(state.buyIn) : "",
      blinds: state.blinds ? blindsText(state.blinds) : "",
      chips: "",
    };
    return `<nav class="crumbs reveal" style="--d:0" aria-label="Setup steps">${SETUP.map(([k, label], i) => `
      <button class="crumb ${k === step ? "on" : ""}" data-step="${k}" ${canReach(k) ? "" : "disabled"} ${k === step ? 'aria-current="step"' : ""}>
        <i>${String(i + 1).padStart(2, "0")}</i><span class="lbl">${label}</span>${answer[k] ? `<b>${answer[k]}</b>` : ""}
      </button>`).join('<span class="crumb-line" aria-hidden="true"></span>')}</nav>`;
  }

  function renderSetup(fresh) {
    const step = setupStep();
    const bl = state.blinds;
    const n = state.players.length;
    const custom = state.buyInPicked && !PRESETS.includes(state.buyIn);
    const customBlinds = blindsCustomOpen || (bl && !BLINDS.some((b) => b.sb === bl.sb && b.bb === bl.bb));
    const showCustom = customBuyOpen || custom;
    let body = "", bar = "";

    if (step === "players") {
      body = `
        ${heading("Who's", "playing?")}
        <p class="sub">Seat everyone at the table. Two or more to start.</p>
        <div class="reveal" style="--d:1">${tableHTML("setup", fresh)}</div>
        <form id="addForm" class="row reveal" style="--d:2">
          <input id="nameIn" class="input grow" placeholder="Friend's name" maxlength="24" autocomplete="off" aria-label="Friend's name" />
          <button class="btn primary" type="submit">Take a seat <kbd>↵</kbd></button>
        </form>`;
      bar = `<button class="btn felt block" id="next" ${n < 2 ? "disabled" : ""}>${n < 2 ? `Seat ${2 - n} more to continue` : "Next: the buy-in"}</button>`;
    } else if (step === "buyin") {
      body = `
        ${heading("What's the", "buy-in?")}
        <p class="sub">What each player puts in to start. Tap a chip.</p>
        <div class="presets big reveal" style="--d:1" id="presets">
          ${PRESETS.map((v, i) => `<button class="preset ${state.buyInPicked && state.buyIn === v ? "sel" : ""}" data-v="${v}" aria-label="$${v} buy-in">${chipHTML(PRESET_COLORS[i], v, 84)}</button>`).join("")}
          <button class="preset ${showCustom ? "sel" : ""}" data-v="custom" aria-label="Custom buy-in" aria-expanded="${showCustom}">${chipHTML(CUSTOM_COLOR, "C", 84)}</button>
        </div>
        ${showCustom ? `
          <form class="row custom-row unfold-in" id="customForm">
            <div class="money grow"><input id="customBuy" class="input" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="Any amount" aria-label="Custom buy-in" value="${custom ? state.buyIn : ""}" /></div>
            <button class="btn primary" type="submit">Set buy-in</button>
          </form>` : ""}`;
    } else if (step === "blinds") {
      body = `
        ${heading("What are", "the blinds?")}
        <p class="sub">Small blind and big blind.</p>
        <div class="pills big reveal" style="--d:1" id="blinds">
          ${BLINDS.map((b, i) => `<button class="pill ${bl && !customBlinds && bl.sb === b.sb && bl.bb === b.bb ? "sel" : ""}" data-b="${i}">${blindsText(b)}</button>`).join("")}
          <button class="pill ${customBlinds ? "sel" : ""}" data-b="custom">Custom</button>
        </div>
        ${customBlinds ? `
          <form class="row unfold-in" id="customBlinds" style="margin-top:14px">
            <div class="money grow"><input id="sbIn" class="input" type="number" inputmode="decimal" min="0.05" step="0.05" placeholder="Small" aria-label="Small blind" value="${bl ? bl.sb / 100 : ""}" /></div>
            <span class="muted">/</span>
            <div class="money grow"><input id="bbIn" class="input" type="number" inputmode="decimal" min="0.05" step="0.05" placeholder="Big" aria-label="Big blind" value="${bl ? bl.bb / 100 : ""}" /></div>
            <button class="btn primary" type="submit">Set</button>
          </form>` : ""}`;
    } else {
      body = `
        ${heading("Which chips", "do you have?")}
        <p class="sub">The blind chips are always in. Turn the rest on or off.</p>
        <div class="reveal" style="--d:1">${chipsHTML(bl)}</div>
        <div class="reveal" style="--d:2">${breakdownHTML(state.buyIn, n)}</div>`;
      bar = `<button class="btn felt block" id="start">Deal everyone in · ${money(state.buyIn)} each <kbd>D</kbd></button>`;
    }

    app.innerHTML = `${crumbsHTML(step)}${body}${bar ? `<div class="bar"><div class="bar-inner">${bar}</div></div>` : ""}`;

    app.querySelectorAll(".crumb").forEach((c) => c.onclick = () => { if (c.dataset.step !== step) toStep(c.dataset.step); });
    const nx = $("#next"); if (nx) nx.onclick = () => toStep("buyin");

    const af = $("#addForm");
    if (af) af.onsubmit = (e) => {
      e.preventDefault();
      const name = $("#nameIn").value.trim();
      if (!name) { if (state.players.length >= 2) toStep("buyin"); return; }
      if (state.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return toast(`${name} is already at the table`);
      commit((s) => s.players.push(newPlayer(name)));
      $("#nameIn").focus();
    };
    app.querySelectorAll("[data-rm]").forEach((b) => b.onclick = () => commit((s) => { s.players = s.players.filter((p) => p.id !== b.dataset.rm); }));
    animateSeats();

    const pr = $("#presets");
    if (pr) pr.onclick = (e) => {
      const b = e.target.closest(".preset"); if (!b) return;
      if (b.dataset.v === "custom") { customBuyOpen = true; render(); $("#customBuy")?.focus(); return; }
      customBuyOpen = false;
      commit((s) => { s.buyIn = +b.dataset.v; s.buyInPicked = true; });
      chipBurst(app.querySelector(`.preset[data-v="${b.dataset.v}"]`), PRESET_COLORS[PRESETS.indexOf(+b.dataset.v)], 6);
      setTimeout(() => toStep("blinds"), reduced ? 0 : 520);
    };
    const cfm = $("#customForm");
    if (cfm) cfm.onsubmit = (e) => {
      e.preventDefault();
      const inp = $("#customBuy"), v = cents(parseFloat(inp.value));
      if (!(v > 0)) return inp.focus();
      customBuyOpen = false;
      commit((s) => { s.buyIn = v; s.buyInPicked = true; });
      toStep("blinds");
    };

    const blp = $("#blinds");
    if (blp) blp.onclick = (e) => {
      const b = e.target.closest(".pill"); if (!b) return;
      if (b.dataset.b === "custom") { blindsCustomOpen = true; render(); $("#sbIn")?.focus(); return; }
      blindsCustomOpen = false;
      const { sb, bb } = BLINDS[+b.dataset.b];
      commit((s) => { s.blinds = { sb, bb }; });
      setTimeout(() => toStep("chips"), reduced ? 0 : 360);
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
      toStep("chips");
    };

    if (step === "chips") {
      const dn = $("#denoms");
      if (dn) dn.onclick = (e) => {
        const b = e.target.closest("[data-d]"); if (!b) return;
        const v = +b.dataset.d, set = chipSetFor(bl);
        const next = set.includes(v) ? set.filter((x) => x !== v) : [...set, v].sort((a, c) => a - c);
        commit((s) => { s.chips = { key: `${bl.sb}/${bl.bb}`, set: next }; });
      };
      // a typed chip value must be a multiple of the smallest chip, so blinds and change still work
      const chipValue = (input, min) => {
        const { d0 } = chipOptions(bl);
        const v = Math.round(parseFloat(input.value) * 100);
        if (!(v > 0)) { input.focus(); return null; }
        if (v % d0) { toast(`Chip values need to be multiples of ${blindLabel(d0)}`); input.focus(); return null; }
        if (min && v < min) { toast(`The highest chip can't be below ${blindLabel(min)}: the blinds need it`); input.value = min / 100; return null; }
        return v;
      };
      const saveSet = (next) => commit((s) => { s.chips = { key: `${bl.sb}/${bl.bb}`, set: [...new Set(next)].sort((a, c) => a - c) }; });
      const tc = $("#topChip");
      if (tc) tc.onchange = () => {
        const { required } = chipOptions(bl);
        const top = chipValue(tc, required[required.length - 1]);
        if (top) saveSet([...chipSetFor(bl).filter((x) => x < top), top, ...required]);
      };
      const oc = $("#otherChip");
      if (oc) oc.onclick = () => { otherChipOpen = true; render(); $("#addChip")?.focus(); };
      const cf = $("#chipFields");
      if (cf) cf.onsubmit = (e) => {
        e.preventDefault();
        const add = $("#addChip");
        if (!add) return;
        const v = chipValue(add);
        if (!v) return;
        const set = chipSetFor(bl);
        if (set.includes(v)) return toast(`${blindLabel(v)} is already in`);
        otherChipOpen = false;
        saveSet([...set, v]);
        toast(v > set[set.length - 1] ? `Added ${blindLabel(v)} as the highest chip` : `Added ${blindLabel(v)}`);
      };
    }

    const st = $("#start");
    if (st) st.onclick = () => {
      go((s) => {
        s.stage = "table";
        s.startedAt = Date.now();
        s.players.forEach((p) => { if (!totalIn(p.id)) s.log.push({ id: uid(), pid: p.id, type: "buyin", amount: s.buyIn, ts: Date.now() }); });
      }).then(dealAnimation);
    };
    if (step === "players" && !fresh && !n) $("#nameIn")?.focus({ preventScroll: true });
  }

  function newPlayer(name) {
    return { id: uid(), name, color: AV_COLORS[state.players.length % AV_COLORS.length], busted: false, final: null };
  }

  /* ----- table ----- */
  let shownPot = null;   // the pot figure counts up to its new value instead of jumping
  function renderTable(fresh) {
    const total = inPlay();   // everything bought in so far, not a hand's pot
    const active = state.players.filter(seated).length;
    const rebuys = state.log.filter((l) => l.type === "rebuy").length;
    const gone = state.players.filter((p) => p.left).length;

    app.innerHTML = `
      <div class="bank reveal" style="--d:0" id="pot">
        <div class="bank-fig">
          <span class="bank-lbl">Money in play</span>
          <span class="bank-val" id="potTotal">${money(total)}</span>
        </div>
        <div class="bank-meta">
          <span><b>${active}/${state.players.length}</b> playing</span>
          <span><b>${rebuys}</b> rebuy${rebuys === 1 ? "" : "s"}</span>
          ${gone ? `<span><b>${gone}</b> cashed out</span>` : ""}
          <span><b>${money(state.buyIn)}</b> buy-in</span>
        </div>
      </div>
      <div class="reveal" style="--d:1">${tableHTML("table", fresh)}</div>

      ${sec(`Players <span class="muted mono">${String(state.players.length).padStart(2, "0")}</span>`, `
        <div class="players" id="players">
          ${state.players.map((p) => {
            const n = entries(p.id), tin = totalIn(p.id), tout = totalOut(p.id);
            const tag = p.left ? `<span class="tag">left</span>` : p.busted ? `<span class="tag bust">out</span>` : n > 1 ? `<span class="tag">×${n}</span>` : "";
            const meta = p.left
              ? `cashed out ${money(tout)} · <span class="${tout - tin >= 0 ? "pos" : "neg"}">${money(tout - tin, true)}</span>`
              : `${n} buy-in${n === 1 ? "" : "s"}${tout ? ` · cashed ${money(tout)}` : ""}`;
            return `
            <div class="pcard ${seated(p) ? "" : "busted"} ${p.left ? "left" : ""}" data-pid="${p.id}">
              ${avatar(p)}
              <div class="info">
                <div class="name">${esc(p.name)}${tag}</div>
                <div class="meta">${meta}</div>
              </div>
              <div class="in">${money(tin)}<small>in</small></div>
              <div class="actions">
                ${seated(p)
                  ? `<button class="btn small" data-act="rebuy" data-pid="${p.id}">Rebuy</button>
                     <button class="btn small" data-act="cashout" data-pid="${p.id}">Cash out</button>
                     <button class="btn small danger" data-act="bust" data-pid="${p.id}">Bust</button>`
                  : `<button class="btn small felt" data-act="rebuy" data-pid="${p.id}">Buy back in</button>`}
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
      else if (b.dataset.act === "cashout") openCashOut(p);
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
    const t0 = performance.now(), dur = 950;
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
    const label = { buyin: "bought in", rebuy: "rebought", bust: "busted out", back: "back in", cashout: "cashed out" };
    return `<details class="card"><summary>${state.log.length} entr${state.log.length === 1 ? "y" : "ies"}</summary>
      <ul class="ledger">${[...state.log].reverse().map((l) => {
        const p = player(l.pid); if (!p) return "";
        const amt = l.type === "buyin" || l.type === "rebuy" || l.type === "cashout";
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
        const pp = s.players.find((x) => x.id === l.pid);
        if (pp && l.type === "bust") pp.busted = false;
        if (pp && l.type === "cashout") pp.left = false;
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
    const wasBusted = p.busted || p.left;
    commit((s) => {
      const pp = s.players.find((x) => x.id === p.id);
      pp.busted = false; pp.left = false;
      s.log.push({ id: uid(), pid: p.id, type: "rebuy", amount, ts: Date.now() });
    }, { undoable: true, msg: `${p.name} rebought for ${money(amount)}` });
    rebuyAnimation(p, amount, wasBusted);
  }

  /* ----- settle ----- */
  function computeSettle() {
    // a player's result = chips at the end + whatever they cashed out early - everything they put in
    const rows = state.players.map((p) => ({
      p, in: totalIn(p.id), cashed: totalOut(p.id),
      final: p.final == null ? (seated(p) ? null : 0) : p.final,
    }));
    const missing = rows.filter((r) => r.final == null);
    const tin = rows.reduce((a, r) => a + r.in, 0);
    const tout = rows.reduce((a, r) => a + (r.final || 0) + r.cashed, 0);
    const diff = cents(tout - tin);
    rows.forEach((r) => { r.net = cents((r.final || 0) + r.cashed - r.in); });
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
      <p class="sub">Enter each final stack in dollars. Busted players sit at $0, and anyone who cashed out is already counted.</p>

      ${sec("Final stacks", `<div class="card">
        ${rows.map((r) => `
          <div class="stack-row">
            <div class="row">${avatar(r.p)}<div class="grow"><div class="who">${esc(r.p.name)}</div>
              <div class="delta ${r.final == null ? "muted" : r.net > 0 ? "pos" : r.net < 0 ? "neg" : "muted"}" data-delta="${r.p.id}">in ${money(r.in)}${r.cashed && !r.p.left ? ` · cashed ${money(r.cashed)}` : ""}${r.final == null ? "" : ` · ${money(r.net, true)}`}</div></div></div>
            ${r.p.left
              ? `<div class="left-amt"><span class="muted">cashed out</span><b>${money(r.cashed)}</b></div>`
              : `<div class="money"><input class="input" type="number" inputmode="decimal" min="0" step="0.01" data-final="${r.p.id}" value="${r.final ?? ""}" placeholder="0" aria-label="${esc(r.p.name)}'s final stack" /></div>`}
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

      ${sec("Save", canSettle
        ? `<p class="muted lead-in">Keeps the date, blinds, players, buy-ins and results on this device, under Past games on the home screen.</p>
           <button class="btn ${state.savedId ? "" : "primary"}" id="saveGame">${state.savedId ? "Saved · save changes" : "Save game"}</button>`
        : `<p class="muted lead-in">Enter every stack and the game can be saved.</p>`, 6)}

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
    const sg = $("#saveGame"); if (sg) sg.onclick = () => saveGame(rows, transfers, tin);
    $("#back").onclick = () => go((s) => { s.stage = "table"; });
    $("#newGame").onclick = confirmReset;
  }

  // one finished game, as kept under Past games
  function saveGame(rows, transfers, tin) {
    const ranked = [...rows].sort((a, b) => b.net - a.net);
    const pick = (r) => ({ name: r.p.name, net: r.net });
    const rec = {
      id: state.savedId || uid(),
      date: state.startedAt || Date.now(),
      savedAt: Date.now(),
      blinds: state.blinds,
      buyIn: state.buyIn,
      total: tin,
      players: rows.map((r) => ({ name: r.p.name, color: r.p.color, in: r.in, buyins: entries(r.p.id), out: cents((r.final || 0) + r.cashed), net: r.net })),
      winner: pick(ranked[0]),
      loser: pick(ranked[ranked.length - 1]),
      transfers: transfers.map((t) => ({ from: t.from.name, to: t.to.name, amt: t.amt })),
    };
    const hist = loadHistory().filter((g) => g.id !== rec.id);
    hist.push(rec);
    if (!saveHistory(hist)) return toast("Couldn't save: this browser is blocking storage");
    const again = !!state.savedId;
    commit((s) => { s.savedId = rec.id; }, { msg: again ? "Saved game updated" : "Game saved to Past games" });
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

  // One player leaves with their chips while everyone else keeps playing. Their result is fixed
  // now; who pays whom is still worked out with everyone at the end.
  function openCashOut(p) {
    const tin = totalIn(p.id);
    openModal(`
      <form id="f">
        <h3>Cash out · ${esc(p.name)}</h3>
        <p class="muted" style="margin:0">Count just their stack. Everyone else keeps playing.</p>
        <label class="field-lbl" for="amt">Leaving with</label>
        <div class="money"><input id="amt" class="input" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0" /></div>
        <p class="advice" id="advice"></p>
        <div class="row" style="margin-top:14px"><button type="button" class="btn" data-close>Cancel</button><button class="btn felt grow">Cash out</button></div>
      </form>`, (m) => {
      const amt = $("#amt", m);
      const show = () => {
        const v = cents(parseFloat(amt.value));
        if (!(v >= 0) || amt.value === "") { $("#advice", m).innerHTML = `Bought in for <b>${money(tin)}</b>.`; return; }
        const net = cents(v - tin);
        $("#advice", m).innerHTML = net === 0
          ? `Bought in for <b>${money(tin)}</b>: they leave even.`
          : `Bought in for <b>${money(tin)}</b>: they leave <b class="${net > 0 ? "pos" : "neg"}">${money(net, true)}</b>. They're settled up with everyone at the end of the night.`;
      };
      amt.addEventListener("input", show); show(); amt.focus();
      $("#f", m).onsubmit = (e) => {
        e.preventDefault();
        const v = cents(parseFloat(amt.value));
        if (!(v >= 0) || amt.value === "") return amt.focus();
        if (v > inPlay()) return toast(`Only ${money(inPlay())} is in play`);
        modal.close();
        commit((s) => {
          const pp = s.players.find((x) => x.id === p.id);
          pp.left = true; pp.busted = false;
          s.log.push({ id: uid(), pid: p.id, type: "cashout", amount: v, ts: Date.now() });
        }, { undoable: true, msg: `${p.name} cashed out ${money(v)} (${money(v - tin, true)})` });
        cashOutAnimation(p, v);
      };
    });
  }

  // Where does the big blind fall for someone joining mid-game? Seats run clockwise in list order
  // and the big blind moves one seat clockwise each hand.
  function bbAdvice(name, afterId, bbId) {
    const who = esc(name || "The new player");
    const order = [];
    state.players.forEach((p) => { if (!p.busted) order.push(p.id); if (p.id === afterId) order.push("NEW"); });
    if (!order.includes("NEW")) order.push("NEW");
    const len = order.length, bb = order.indexOf(bbId), nw = order.indexOf("NEW");
    const bbAmt = state.blinds ? blindLabel(state.blinds.bb) : "one big blind";
    if (bb < 0 || len < 3) return `${who} can be dealt in next hand.`;
    const dist = (nw - bb + len) % len;   // seats clockwise from the big blind to the new seat
    if (dist === 1) return `<b>No premium.</b> ${who} sits right after the big blind, so the blind reaches them next hand: they just post the normal ${bbAmt} big blind and play.`;
    if (dist === len - 1) return `<b>Wait for the button.</b> ${who} sits just before the big blind, which puts them between the button and the small blind next hand. Most house rules deal them in once the button passes, or let them post ${bbAmt} to play now.`;
    return `<b>Premium of ${bbAmt}.</b> To play next hand ${who} posts a big blind (${bbAmt}) on top of the blinds. Or they wait ${dist - 1} hand${dist - 1 === 1 ? "" : "s"} for the big blind to reach them and pay nothing extra.`;
  }

  function openAddLate() {
    const active = state.players.filter((p) => !p.busted);
    const last = state.players[state.players.length - 1];
    const bbDefault = active.some((p) => p.id === state.bbPid) ? state.bbPid : active[0]?.id;
    const opts = (list, sel) => list.map((p) => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}</option>`).join("");
    openModal(`
      <form id="f">
        <h3>Pull up a chair</h3>
        <label class="field-lbl" for="nm">Name</label>
        <input id="nm" class="input" placeholder="Name" maxlength="24" autocomplete="off" />
        <div class="field-pair">
          <div><label class="field-lbl" for="after">Sits after</label><select id="after" class="input">${opts(state.players, last?.id)}</select></div>
          <div><label class="field-lbl" for="bbOn">Big blind is on</label><select id="bbOn" class="input">${opts(active, bbDefault)}</select></div>
        </div>
        <p class="advice" id="advice"></p>
        ${amountPicker(state.buyIn)}
        <div class="row" style="margin-top:14px"><button type="button" class="btn" data-close>Cancel</button><button class="btn felt grow">Buy in</button></div>
      </form>`, (m) => {
      const amt = bindPicker(m);
      const advise = () => { $("#advice", m).innerHTML = bbAdvice($("#nm", m).value.trim(), $("#after", m).value, $("#bbOn", m).value); };
      ["#nm", "#after", "#bbOn"].forEach((s) => $(s, m).addEventListener("input", advise));
      advise();
      $("#nm", m).focus();
      $("#f", m).onsubmit = (e) => {
        e.preventDefault();
        const name = $("#nm", m).value.trim();
        const v = cents(parseFloat(amt.value));
        if (!name) return $("#nm", m).focus();
        if (state.players.some((x) => x.name.toLowerCase() === name.toLowerCase())) return toast(`${name} is already at the table`);
        if (!(v > 0)) return amt.focus();
        const afterId = $("#after", m).value, bbId = $("#bbOn", m).value;
        modal.close();
        const p = newPlayer(name);
        commit((s) => {
          const at = s.players.findIndex((x) => x.id === afterId);
          s.players.splice(at < 0 ? s.players.length : at + 1, 0, p);
          s.bbPid = bbId;
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
      const reset = (keep) => {
        modal.close();
        home = false;
        go((s) => {
          const players = keep ? s.players.map((p) => ({ ...p, busted: false, left: false, final: null })) : [];
          Object.assign(s, fresh(), { buyIn: s.buyIn, blinds: s.blinds, buyInPicked: s.buyInPicked, players, setupStep: "players" });
        }, { undoable: true, msg: keep ? "New game, same players" : "Table cleared" });
      };
      $("#keep", m).onclick = () => reset(true);
      $("#wipe", m).onclick = () => reset(false);
    });
  }

  /* ---------------- toast ---------------- */
  let toastTimer;
  // undo: true rolls the game back to before the last change; a function undoes something else
  function toast(msg, undo = false) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button id="undo">Undo</button>` : ""}`;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), undo ? 5000 : 2200);
    const u = $("#undo");
    if (u && typeof undo === "function") u.onclick = () => { undo(); t.classList.remove("show"); };
    else if (u) u.onclick = () => {
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
      ], { duration: rand(1000, 1250), delay: i * 70, easing: "cubic-bezier(.65,0,.35,1)" });
    }
    setTimeout(bumpPot, reduced ? 0 : 950);
  }

  function floatText(text, at, color) {
    const el = spawn("fx-float", esc(text), { left: at.x + "px", top: at.y + "px", color });
    animate(el, [
      { transform: "translate(-50%,-30%)", opacity: 0 },
      { transform: "translate(-50%,-110%)", opacity: 1, offset: .3 },
      { transform: "translate(-50%,-190%)", opacity: 0 },
    ], { duration: 1700, easing: "cubic-bezier(.22,1,.36,1)" });
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
      ], { duration: 950, easing: "cubic-bezier(.22,1,.36,1)" });
    }
  }

  // a word rises out of its mask, holds, and lifts away
  function banner(text, color = "var(--ink)", duration = 1950) {
    const el = spawn("fx-banner", `<span>${esc(text)}</span>`, { color });
    if (reduced) { el.remove(); return; }
    el.firstChild.animate([
      { transform: "translateY(110%)" },
      { transform: "translateY(0)", offset: .28 },
      { transform: "translateY(0)", offset: .74 },
      { transform: "translateY(-110%)" },
    ], { duration, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" }).onfinish = () => el.remove();
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
        }, 260 + i * 150);
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
      setTimeout(() => chipsToPot(seat, Math.min(10, 3 + Math.round(amount / state.buyIn) * 2)), 280);
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
        path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 560, delay: i * 35, fill: "forwards", easing: "cubic-bezier(.22,1,.36,1)" });
        svg.appendChild(path);
      }
      fx.appendChild(svg);
      svg.animate([{ opacity: 1 }, { opacity: 1, offset: .55 }, { opacity: 0 }], { duration: 1800, fill: "forwards" }).onfinish = () => svg.remove();
      banner(`${p.name} is out`, "var(--red)");
    });
  }

  // CASH OUT: chips travel from the money-in-play figure back to the seat
  function cashOutAnimation(p, amount) {
    requestAnimationFrame(() => {
      const seat = app.querySelector(`.seat[data-seat="${p.id}"] .avatar`);
      const from = center($("#pot")), to = center(seat);
      if (!reduced) for (let i = 0; i < 5; i++) {
        const el = spawn("fx-chip", "", { left: from.x - 15 + "px", top: from.y - 15 + "px" });
        el.style.setProperty("--c", CHIP_COLORS[i % CHIP_COLORS.length]);
        const dx = to.x - from.x + rand(-20, 20), dy = to.y - from.y + rand(-10, 10);
        animate(el, [
          { transform: "translate(0,0) scale(.5)", opacity: 0 },
          { transform: `translate(${dx / 2}px,${dy / 2 - 50}px) scale(.9)`, opacity: 1, offset: .45 },
          { transform: `translate(${dx}px,${dy}px) scale(.6)`, opacity: 0 },
        ], { duration: rand(1000, 1250), delay: i * 70, easing: "cubic-bezier(.65,0,.35,1)" });
      }
      floatText(money(amount), center(seat), "var(--ink)");
      banner(`${p.name} cashes out`);
    });
  }

  // BALANCED: no burst. The balance card fills with a slow green wash, a handful of chips drift
  // up from its tick and fade, and the word rises and settles at an unhurried pace.
  function confetti() {
    if (reduced) return;
    requestAnimationFrame(() => {
      const card = app.querySelector(".balance.ok");
      card?.classList.add("calm");
      const at = center(card?.querySelector(".icon"));
      for (let i = 0; i < 9; i++) {
        const el = spawn("fx-chip", "", { left: at.x - 9 + "px", top: at.y - 9 + "px", width: "18px", height: "18px" });
        el.style.setProperty("--c", CHIP_COLORS[i % CHIP_COLORS.length]);
        const dx = rand(-70, 70), rise = rand(90, 170);
        animate(el, [
          { transform: "translate(0,0) scale(.6)", opacity: 0 },
          { transform: `translate(${dx * .5}px,${-rise * .5}px) scale(.9)`, opacity: .9, offset: .35 },
          { transform: `translate(${dx}px,${-rise}px) scale(.8)`, opacity: 0 },
        ], { duration: rand(2600, 3300), delay: 300 + i * 120, easing: "cubic-bezier(.22,1,.36,1)" });
      }
      banner("Balanced", "var(--green)", 3200);
    });
  }

  // shortcuts: N seat or add a player, D deal, C count the chips; never while typing or in a dialog
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || modal.open || home) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === "n") {
      e.preventDefault();
      if (state.stage === "setup") { if (setupStep() !== "players") toStep("players"); else $("#nameIn")?.focus(); }
      else if (state.stage === "table") openAddLate();
    } else if (k === "d" && state.stage === "setup") {
      const b = $("#start"); if (b && !b.disabled) b.click();
    } else if (k === "c" && state.stage === "table") {
      $("#toSettle")?.click();
    }
  });

  $("#brand").onclick = openHome;

  render();
})();
