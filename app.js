/* chipme — poker buy-in counter & settle-up ledger.
   Everything lives in localStorage so a refresh never loses the game. */
(() => {
  "use strict";

  const KEY = "chipme:v1";
  const PRESETS = [20, 25, 50];
  const CHIP_COLORS = ["#3e63dd", "#e5484d", "#18a058", "#1c1d1f", "#8e4ec6", "#e8b33b", "#f76b15", "#12a594"];
  // standard home-game chip set
  const DENOMS = [
    { v: 25, cents: 2500, name: "black", color: "#1c1d1f" },
    { v: 5, cents: 500, name: "green", color: "#18a058" },
    { v: 1, cents: 100, name: "red", color: "#e5484d" },
    { v: 0.25, cents: 25, name: "white", color: "#f4f2ec" },
  ];
  const AV_COLORS = ["#e5484d", "#3e63dd", "#18a058", "#8e4ec6", "#f76b15", "#12a594", "#d6409f", "#978365"];

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

  /* ---------------- chip breakdown ----------------
     ~$5 in whites for blinds, ~30% in reds, the rest in greens
     (blacks once a stack has lots of greens). Works in cents to avoid float drift. */
  function chipBreakdown(amount) {
    let cents = Math.round(amount * 100);
    if (!(cents > 0)) return null;
    const leftover = cents % 25;          // can't be made with chips
    cents -= leftover;
    const count = { 2500: 0, 500: 0, 100: 0, 25: 0 };
    count[25] = Math.floor(Math.min(cents * 0.25, 500) / 25);
    let rem = cents - count[25] * 25;
    const redTarget = Math.min(rem, Math.round(cents * 0.3));
    count[500] = Math.max(0, Math.floor((rem - redTarget) / 500));
    rem -= count[500] * 500;
    count[100] = Math.floor(rem / 100);
    count[25] += Math.round((rem - count[100] * 100) / 25);
    if (count[500] > 10) {
      count[2500] = Math.floor((count[500] - 6) / 5);
      count[500] -= count[2500] * 5;
    }
    const rows = DENOMS.filter((d) => count[d.cents] > 0).map((d) => ({ ...d, n: count[d.cents] }));
    return { rows, total: rows.reduce((a, r) => a + r.n, 0), leftover: leftover / 100 };
  }

  function chipLabel(d) { return d.v < 1 ? `${d.v * 100}¢` : `$${d.v}`; }

  function breakdownHTML(amount, players = 0, compact = false) {
    const b = chipBreakdown(amount);
    if (!b) return "";
    const rows = b.rows.map((r) => `
      <li><span class="denom-chip" style="--c:${r.color}">${chipLabel(r)}</span>
        <span class="grow"><b class="num">${r.n}</b> × ${chipLabel(r)} <span class="muted">${r.name}</span></span>
        ${compact ? "" : `<span class="num muted">${money((r.n * r.cents) / 100)}</span>`}</li>`).join("");
    const bank = players > 1 && !compact
      ? `<p class="muted bank">For ${players} players you'll need ${b.rows.map((r) => `${r.n * players} ${r.name}`).join(", ")}.</p>` : "";
    const left = b.leftover ? `<p class="muted bank">+ ${money(b.leftover)} that can't be made with chips.</p>` : "";
    return `<div class="breakdown ${compact ? "compact" : ""}">
      <div class="bd-head">${compact ? "That's" : "Give each player"} <b class="num">${b.total} chips</b></div>
      <ul>${rows}</ul>${bank}${left}</div>`;
  }

  /* ---------------- render ---------------- */
  function render() {
    const order = ["setup", "table", "settle"];
    document.querySelectorAll("#steps span").forEach((el) => {
      const i = order.indexOf(el.dataset.step), cur = order.indexOf(state.stage);
      el.className = i === cur ? "on" : i < cur ? "done" : "";
    });
    if (state.stage === "setup") renderSetup();
    else if (state.stage === "table") renderTable();
    else renderSettle();
  }

  function avatar(p) {
    return `<span class="avatar" style="--av:${p.color}">${esc(initials(p.name))}</span>`;
  }

  /* ----- setup ----- */
  function renderSetup() {
    const custom = !PRESETS.includes(state.buyIn);
    app.innerHTML = `
      <h1>Shuffle up &amp; deal.</h1>
      <p class="sub">Pick the buy-in, add your friends, and chipme keeps the ledger.</p>

      <h2>Buy-in</h2>
      <div class="presets" id="presets">
        ${PRESETS.map((v, i) => `<button class="preset ${state.buyIn === v ? "sel" : ""}" data-v="${v}" style="--c:${CHIP_COLORS[i]}">$${v}</button>`).join("")}
      </div>
      <div class="row" style="margin-top:12px">
        <label class="muted" for="customBuy" style="font-size:14px">Custom</label>
        <div class="money grow"><input id="customBuy" class="input num" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="Any amount" value="${custom ? state.buyIn : ""}" /></div>
      </div>
      ${breakdownHTML(state.buyIn, state.players.length)}

      <h2>Players <span class="muted" style="text-transform:none;letter-spacing:0">· ${state.players.length}</span></h2>
      <form id="addForm" class="row">
        <input id="nameIn" class="input grow" placeholder="Friend's name" maxlength="24" autocomplete="off" />
        <button class="btn primary" type="submit">Add</button>
      </form>
      ${state.players.length
        ? `<ul class="player-list">${state.players.map((p) => `<li>${avatar(p)}<span class="grow">${esc(p.name)}</span><button class="x" data-rm="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></li>`).join("")}</ul>`
        : `<div class="empty"><span class="big">🃏</span>Add at least two players to start.</div>`}

      <div class="bar"><div class="bar-inner">
        <button class="btn felt block" id="start" ${state.players.length < 2 || !(state.buyIn > 0) ? "disabled" : ""}>
          Deal everyone in · ${money(state.buyIn)} each
        </button>
      </div></div>`;

    $("#presets").onclick = (e) => {
      const b = e.target.closest(".preset"); if (!b) return;
      commit((s) => { s.buyIn = +b.dataset.v; });
      chipBurst(b, CHIP_COLORS[PRESETS.indexOf(+b.dataset.v)], 6);
    };
    $("#customBuy").onchange = (e) => {
      const v = cents(parseFloat(e.target.value));
      if (v > 0) commit((s) => { s.buyIn = v; });
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
    $("#start").onclick = () => {
      commit((s) => {
        s.stage = "table";
        s.startedAt = Date.now();
        s.players.forEach((p) => { if (!totalIn(p.id)) s.log.push({ id: uid(), pid: p.id, type: "buyin", amount: s.buyIn, ts: Date.now() }); });
      });
      dealAnimation();
    };
  }

  function newPlayer(name) {
    return { id: uid(), name, color: AV_COLORS[state.players.length % AV_COLORS.length], busted: false, final: null };
  }

  /* ----- table ----- */
  function renderTable() {
    const total = potTotal();
    const active = state.players.filter((p) => !p.busted).length;
    const rebuys = state.log.filter((l) => l.type === "rebuy").length;
    const stacks = Math.min(5, Math.max(1, Math.ceil(total / (state.buyIn * 2))));

    app.innerHTML = `
      <div class="pot" id="pot" style="margin-top:12px">
        <div class="pot-label">In the pot</div>
        <div class="pot-total num" id="potTotal">${money(total)}</div>
        <div class="pot-meta">
          <span>🪑 ${active}/${state.players.length} playing</span>
          <span>🔁 ${rebuys} rebuy${rebuys === 1 ? "" : "s"}</span>
          <span>💵 ${money(state.buyIn)} buy-in</span>
        </div>
        <div class="pot-stack" aria-hidden="true">
          ${Array.from({ length: stacks }, (_, c) => `<div class="col">${Array.from({ length: 3 + ((c * 7 + total) % 6) }, () => `<span class="mini-chip" style="--c:${CHIP_COLORS[c % CHIP_COLORS.length]}"></span>`).join("")}</div>`).join("")}
        </div>
      </div>

      <div class="players" id="players">
        ${state.players.map((p, i) => {
          const n = entries(p.id);
          return `
          <div class="pcard ${p.busted ? "busted" : ""}" data-pid="${p.id}" style="animation-delay:${i * 30}ms">
            ${avatar(p)}
            <div class="info">
              <div class="name">${esc(p.name)}${p.busted ? `<span class="tag bust">busted</span>` : n > 1 ? `<span class="tag">×${n}</span>` : ""}</div>
              <div class="meta">${n} buy-in${n === 1 ? "" : "s"}</div>
            </div>
            <div class="in num">${money(totalIn(p.id))}<small>in</small></div>
            <div class="actions">
              ${p.busted
                ? `<button class="btn small felt" data-act="rebuy" data-pid="${p.id}">↻ Rebuy</button>`
                : `<button class="btn small" data-act="rebuy" data-pid="${p.id}">+ Rebuy</button>
                   <button class="btn small danger" data-act="bust" data-pid="${p.id}">Bust</button>`}
            </div>
          </div>`;
        }).join("")}
      </div>

      <div class="row wrap" style="margin-top:12px">
        <button class="btn small ghost" id="addLate">+ Add player</button>
        <button class="btn small ghost" id="changeBuy">Change buy-in</button>
        <span class="grow"></span>
        <button class="btn small ghost danger" id="reset">New game</button>
      </div>

      <h2>Ledger</h2>
      ${ledgerHTML()}

      <div class="bar"><div class="bar-inner">
        <button class="btn primary block" id="toSettle">Game over → count chips</button>
      </div></div>`;

    app.querySelectorAll("[data-act]").forEach((b) => b.onclick = () => {
      const p = player(b.dataset.pid);
      if (b.dataset.act === "rebuy") openRebuy(p);
      else bust(p);
    });
    $("#addLate").onclick = openAddLate;
    $("#changeBuy").onclick = openChangeBuy;
    $("#reset").onclick = confirmReset;
    $("#toSettle").onclick = () => commit((s) => { s.stage = "settle"; });
    bindLedger();
  }

  function ledgerHTML() {
    if (!state.log.length) return `<div class="card empty">Nothing yet.</div>`;
    const label = { buyin: "bought in", rebuy: "rebought", bust: "busted out 💀", back: "back in" };
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

  function renderSettle() {
    const { rows, missing, tin, tout, diff } = computeSettle();
    const balanced = !missing.length && Math.abs(diff) < 0.01;
    const canSettle = !missing.length && (balanced || state.settleAnyway);
    const transfers = canSettle ? transfersFor(rows, diff) : [];
    const ranked = [...rows].sort((a, b) => b.net - a.net);
    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
    const top = ranked[0], bottom = ranked[ranked.length - 1];

    let balHTML;
    if (missing.length) {
      balHTML = `<div class="balance wait"><span class="icon">⏳</span><div><strong>Waiting on ${missing.length} stack${missing.length === 1 ? "" : "s"}</strong><span class="muted">${missing.map((r) => esc(r.p.name)).join(", ")}</span></div></div>`;
    } else if (balanced) {
      balHTML = `<div class="balance ok"><span class="icon">✓</span><div><strong>Everything balances</strong><span class="muted">${money(tout)} counted = ${money(tin)} bought in</span></div></div>`;
    } else {
      balHTML = `<div class="balance off"><span class="icon">!</span><div class="grow"><strong>Off by ${money(Math.abs(diff))} — ${diff > 0 ? "too many chips" : "chips missing"}</strong>
        <span class="muted">${money(tout)} counted vs ${money(tin)} bought in. Recount, or split the difference evenly.</span>
        <label class="row" style="margin-top:8px;font-size:14px;gap:8px"><input type="checkbox" id="anyway" ${state.settleAnyway ? "checked" : ""}/> Settle anyway (${money(Math.abs(diff) / rows.length)} per player)</label></div></div>`;
    }

    app.innerHTML = `
      <h1>Count 'em up.</h1>
      <p class="sub">Enter everyone's final chip stack (in dollars). Busted players are already at $0.</p>

      <div class="card">
        ${rows.map((r) => `
          <div class="stack-row">
            <div class="row">${avatar(r.p)}<div class="grow"><div style="font-weight:700">${esc(r.p.name)}</div>
              <div class="delta num ${r.final == null ? "muted" : r.net > 0 ? "pos" : r.net < 0 ? "neg" : "muted"}" data-delta="${r.p.id}">in ${money(r.in)}${r.final == null ? "" : ` · ${money(r.net, true)}`}</div></div></div>
            <div class="money"><input class="input num" type="number" inputmode="decimal" min="0" step="0.01" data-final="${r.p.id}" value="${r.final ?? ""}" placeholder="0" /></div>
          </div>`).join("")}
      </div>

      <h2>Balance check</h2>
      ${balHTML}

      ${canSettle ? `
        <h2>Who e-transfers who</h2>
        ${transfers.length
          ? `<ul class="transfers">${transfers.map((t, i) => `<li style="animation-delay:${i * 60}ms">
              <span class="avatar" style="--av:${t.from.color}">${esc(initials(t.from.name))}</span>
              <span><b>${esc(t.from.name)}</b> <span class="arrow">→</span> <b>${esc(t.to.name)}</b></span>
              <span class="amt num">${money(t.amt)}</span></li>`).join("")}</ul>
             <div class="row" style="margin-top:10px"><button class="btn small" id="copy">Copy summary</button></div>`
          : `<div class="card empty">Everyone broke even. Nobody owes anything 🤝</div>`}

        <h2>Leaderboard</h2>
        <div class="podium">
          <div class="card"><span class="crown">👑</span><div class="lbl">Top winner</div><div class="who">${esc(top.p.name)}</div><div class="amt num ${top.net > 0 ? "pos" : ""}">${money(top.net, true)}</div></div>
          <div class="card"><span class="crown">🐟</span><div class="lbl">Biggest loser</div><div class="who">${esc(bottom.p.name)}</div><div class="amt num ${bottom.net < 0 ? "neg" : ""}">${money(bottom.net, true)}</div></div>
        </div>
        <div class="card" style="margin-top:10px">
          <ul class="board" style="margin:0">${ranked.map((r) => {
            const w = (Math.abs(r.net) / maxAbs) * 50;
            return `<li>${avatar(r.p)}<span style="width:84px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.p.name)}</span>
              <span class="bar-wrap"><span class="bar-fill" style="${r.net >= 0 ? `left:50%;width:${w}%;background:var(--green)` : `right:50%;width:${w}%;background:var(--red)`}"></span></span>
              <span class="num ${r.net > 0 ? "pos" : r.net < 0 ? "neg" : "muted"}" style="width:72px;text-align:right;font-weight:700">${money(r.net, true)}</span></li>`;
          }).join("")}</ul>
        </div>` : ""}

      <div class="bar"><div class="bar-inner">
        <button class="btn" id="back">← Table</button>
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
    $("#back").onclick = () => commit((s) => { s.stage = "table"; });
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
        commit((s) => {
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
      const el = spawn("fx-chip", "", { left: a.x - 17 + "px", top: a.y - 17 + "px", "--c": c });
      el.style.setProperty("--c", c);
      const dx = b.x - a.x + rand(-60, 60), dy = b.y - a.y + rand(-20, 20);
      const mx = dx / 2 + rand(-80, 80), my = Math.min(dy / 2, 0) - rand(80, 160);
      animate(el, [
        { transform: "translate(0,0) scale(.4) rotate(0)", opacity: 0 },
        { transform: `translate(${mx}px,${my}px) scale(1.1) rotate(${rand(180, 360)}deg)`, opacity: 1, offset: .5 },
        { transform: `translate(${dx}px,${dy}px) scale(.7) rotate(${rand(400, 720)}deg)`, opacity: 0 },
      ], { duration: rand(700, 1000), delay: i * 45, easing: "cubic-bezier(.3,.6,.4,1)" });
    }
    setTimeout(bumpPot, reduced ? 0 : 700);
  }

  function floatText(text, at, color) {
    const el = spawn("fx-float", esc(text), { left: at.x + "px", top: at.y + "px", color });
    animate(el, [
      { transform: "translate(-50%,-50%) scale(.5)", opacity: 0 },
      { transform: "translate(-50%,-120%) scale(1.15)", opacity: 1, offset: .25 },
      { transform: "translate(-50%,-260%) scale(1)", opacity: 0 },
    ], { duration: 1400, easing: "cubic-bezier(.2,.8,.3,1)" });
  }

  function chipBurst(fromEl, color, n = 10) {
    const a = center(fromEl);
    for (let i = 0; i < n; i++) {
      const el = spawn("fx-chip", "", { left: a.x - 17 + "px", top: a.y - 17 + "px" });
      el.style.setProperty("--c", color || CHIP_COLORS[i % CHIP_COLORS.length]);
      const ang = (Math.PI * 2 * i) / n + rand(-.3, .3), d = rand(50, 110);
      animate(el, [
        { transform: "translate(0,0) scale(.3)", opacity: 1 },
        { transform: `translate(${Math.cos(ang) * d}px,${Math.sin(ang) * d}px) scale(.8) rotate(${rand(-360, 360)}deg)`, opacity: 1, offset: .6 },
        { transform: `translate(${Math.cos(ang) * d * 1.2}px,${Math.sin(ang) * d * 1.2 + 60}px) scale(.6)`, opacity: 0 },
      ], { duration: 800, easing: "cubic-bezier(.2,.9,.3,1)" });
    }
  }

  function banner(text, color, frames) {
    const el = spawn("fx-banner", esc(text), { color });
    animate(el, frames || [
      { transform: "translate(-50%,-50%) scale(.3) rotate(-12deg)", opacity: 0 },
      { transform: "translate(-50%,-50%) scale(1.1) rotate(3deg)", opacity: 1, offset: .2 },
      { transform: "translate(-50%,-50%) scale(1) rotate(-2deg)", opacity: 1, offset: .7 },
      { transform: "translate(-50%,-80%) scale(.9)", opacity: 0 },
    ], { duration: 1500, easing: "cubic-bezier(.2,1,.3,1)" });
  }

  // BUY-IN: deal chips from every player card into the pot
  function dealAnimation() {
    requestAnimationFrame(() => {
      banner("Shuffle up!", "var(--gold)");
      app.querySelectorAll(".pcard").forEach((card, i) => {
        setTimeout(() => {
          card.classList.add("flash-in");
          chipsToPot(card.querySelector(".avatar"), 4, state.players[i]?.color);
        }, 250 + i * 140);
      });
    });
  }
  function buyInAnimation(p, amount) {
    requestAnimationFrame(() => {
      const card = app.querySelector(`.pcard[data-pid="${p.id}"]`);
      if (card) card.classList.add("flash-in");
      const av = card?.querySelector(".avatar");
      floatText(`+${money(amount)}`, center(av), "var(--green)");
      chipsToPot(av, 8, p.color);
      banner("Welcome!", p.color);
    });
  }

  // REBUY: chip fountain, "+$X", and a "back from the dead" moment if busted
  function rebuyAnimation(p, amount, wasBusted) {
    requestAnimationFrame(() => {
      const card = app.querySelector(`.pcard[data-pid="${p.id}"]`);
      const av = card?.querySelector(".avatar");
      if (card) { card.classList.remove("flash-in"); void card.offsetWidth; card.classList.add("flash-in"); }
      floatText(`+${money(amount)}`, center(av), "var(--green)");
      chipBurst(av, null, 12);
      setTimeout(() => chipsToPot(av, Math.min(14, 4 + Math.round(amount / state.buyIn) * 3)), 250);
      if (wasBusted) banner("Back from the dead 🧟", "var(--green)");
      else if (amount > state.buyIn) banner("Reloading 💰", "var(--gold)");
      else banner("Rebuy!", p.color);
    });
  }

  // BUST: card shakes, screen cracks, skulls rain down
  function bustAnimation(p, oldCard) {
    requestAnimationFrame(() => {
      const card = app.querySelector(`.pcard[data-pid="${p.id}"]`);
      if (card) { card.classList.add("shake"); }
      const at = center(card || oldCard);
      if (reduced) return;
      // crack lines radiating from the card
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "fx-crack");
      svg.setAttribute("width", innerWidth); svg.setAttribute("height", innerHeight);
      for (let i = 0; i < 9; i++) {
        let x = at.x, y = at.y, d = `M${x},${y}`;
        const ang = (Math.PI * 2 * i) / 9 + rand(-.2, .2);
        for (let s = 0; s < 5; s++) {
          const len = rand(30, 70);
          const a2 = ang + rand(-.5, .5);
          x += Math.cos(a2) * len; y += Math.sin(a2) * len; d += ` L${x},${y}`;
        }
        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "var(--red)");
        path.setAttribute("stroke-width", "2.5");
        path.setAttribute("stroke-linecap", "round");
        path.style.strokeDasharray = 400; path.style.strokeDashoffset = 400;
        path.animate([{ strokeDashoffset: 400 }, { strokeDashoffset: 0 }], { duration: 350, fill: "forwards", easing: "ease-out" });
        svg.appendChild(path);
      }
      fx.appendChild(svg);
      svg.animate([{ opacity: 1 }, { opacity: 1, offset: .6 }, { opacity: 0 }], { duration: 1300, fill: "forwards" }).onfinish = () => svg.remove();

      // falling skulls & cards
      const icons = ["💀", "💀", "🃏", "💸", "☠️"];
      for (let i = 0; i < 14; i++) {
        const el = spawn("fx-emoji", icons[i % icons.length], { left: rand(0, innerWidth - 30) + "px", top: "-50px" });
        animate(el, [
          { transform: `translateY(0) rotate(${rand(-30, 30)}deg)`, opacity: 1 },
          { transform: `translateY(${innerHeight + 100}px) rotate(${rand(-360, 360)}deg)`, opacity: .9 },
        ], { duration: rand(1400, 2200), delay: rand(0, 400), easing: "cubic-bezier(.5,0,.8,.6)" });
      }
      banner("BUSTED", "var(--red)", [
        { transform: "translate(-50%,-50%) scale(2.4)", opacity: 0, filter: "blur(8px)" },
        { transform: "translate(-50%,-50%) scale(1)", opacity: 1, filter: "blur(0)", offset: .15 },
        { transform: "translate(-48%,-50%) scale(1)", opacity: 1, offset: .2 },
        { transform: "translate(-52%,-50%) scale(1)", opacity: 1, offset: .25 },
        { transform: "translate(-50%,-50%) scale(1)", opacity: 1, offset: .75 },
        { transform: "translate(-50%,-30%) scale(.9) rotate(8deg)", opacity: 0 },
      ]);
      document.body.animate([
        { transform: "translate(0,0)" }, { transform: "translate(-6px,3px)" }, { transform: "translate(5px,-4px)" },
        { transform: "translate(-3px,2px)" }, { transform: "translate(0,0)" },
      ], { duration: 350, delay: 120 });
    });
  }

  function confetti() {
    if (reduced) return;
    const colors = [...CHIP_COLORS, "#ffffff"];
    for (let i = 0; i < 70; i++) {
      const el = spawn("fx-chip", "", { left: innerWidth / 2 + "px", top: innerHeight * .45 + "px", width: "14px", height: "14px" });
      el.style.setProperty("--c", colors[i % colors.length]);
      const ang = rand(-Math.PI, 0), v = rand(220, 520);
      const dx = Math.cos(ang) * v, dy = Math.sin(ang) * v;
      animate(el, [
        { transform: "translate(0,0) scale(.4)", opacity: 1 },
        { transform: `translate(${dx}px,${dy}px) rotate(${rand(0, 720)}deg) scale(1)`, opacity: 1, offset: .4 },
        { transform: `translate(${dx * 1.2}px,${dy + innerHeight * .7}px) rotate(${rand(720, 1440)}deg) scale(.8)`, opacity: 0 },
      ], { duration: rand(1600, 2400), easing: "cubic-bezier(.15,.7,.4,1)" });
    }
    banner("Balanced ✓", "var(--green)");
  }

  $("#brand").onclick = () => { if (state.stage !== "setup" && !state.log.length) commit((s) => { s.stage = "setup"; }); };

  render();
})();
