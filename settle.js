/* chipme settle-up maths, in whole cents so nothing is lost to rounding.
   settle()    works out each player's result, and with "settle anyway" splits a miscount exactly
               across the stacks that were counted (never players who already cashed out or busted).
   transfers() finds the fewest payments that square everyone up. */
(function (root) {
  "use strict";

  // rows: [{ key, inC, cashedC, finalC (null = not counted yet), counted }]
  // approvedC: the miscount the host agreed to split; it only applies while the miscount is that exact amount
  function settle(rows, approvedC) {
    const missing = rows.filter((r) => r.finalC == null);
    const tinC = rows.reduce((a, r) => a + r.inC, 0);
    const toutC = rows.reduce((a, r) => a + (r.finalC || 0) + r.cashedC, 0);
    const diffC = toutC - tinC;
    const approved = diffC !== 0 && !missing.length && approvedC === diffC;
    rows.forEach((r) => { r.adjC = 0; r.netC = (r.finalC || 0) + r.cashedC - r.inC; });
    if (approved) {
      let pool = rows.filter((r) => r.counted);
      if (!pool.length) pool = rows.slice();
      // biggest stacks take any leftover cent first
      pool.sort((a, b) => (b.finalC || 0) - (a.finalC || 0));
      const share = -diffC, k = pool.length, base = Math.trunc(share / k), rem = share - base * k;
      pool.forEach((r, i) => { r.adjC = base + (i < Math.abs(rem) ? Math.sign(rem) : 0); r.netC += r.adjC; });
    }
    return { rows, missing, tinC, toutC, diffC, approved, balanced: !missing.length && diffC === 0, canSettle: !missing.length && (diffC === 0 || approved) };
  }

  // Fewest payments: split the players into as many groups as possible whose results sum to zero
  // (each group of k people needs k-1 payments), then settle each group largest-first.
  // Exact for up to 12 people who are up or down; beyond that, one group.
  function transfers(bal) {
    const live = bal.filter((b) => b.v !== 0);
    const n = live.length;
    let groups = [live];
    if (n > 2 && n <= 12) {
      const full = (1 << n) - 1, sum = new Int32Array(full + 1);
      for (let m = 1; m <= full; m++) { const low = m & -m, i = 31 - Math.clz32(low); sum[m] = sum[m ^ low] + live[i].v; }
      const best = new Int8Array(full + 1).fill(-1), pick = new Int32Array(full + 1);
      best[0] = 0;
      for (let m = 1; m <= full; m++) {
        if (sum[m] !== 0) continue;
        const low = m & -m, rest = m ^ low;
        // every zero-sum part of m that holds its lowest member
        for (let s = rest; ; s = (s - 1) & rest) {
          const part = s | low;
          if (sum[part] === 0 && best[m ^ part] >= 0 && best[m ^ part] + 1 > best[m]) { best[m] = best[m ^ part] + 1; pick[m] = part; }
          if (s === 0) break;
        }
      }
      if (best[full] > 0) {
        groups = [];
        for (let m = full; m; m ^= pick[m]) groups.push(live.filter((_, i) => pick[m] & (1 << i)));
      }
    }
    const out = [];
    for (const g of groups) {
      const cred = g.filter((b) => b.v > 0).map((b) => ({ ...b })).sort((a, b) => b.v - a.v);
      const debt = g.filter((b) => b.v < 0).map((b) => ({ ...b, v: -b.v })).sort((a, b) => b.v - a.v);
      let i = 0, j = 0;
      while (i < debt.length && j < cred.length) {
        const amt = Math.min(debt[i].v, cred[j].v);
        if (amt > 0) out.push({ from: debt[i].key, to: cred[j].key, amtC: amt });
        debt[i].v -= amt; cred[j].v -= amt;
        if (!debt[i].v) i++;
        if (!cred[j].v) j++;
      }
    }
    return out;
  }

  const api = { settle, transfers };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Settle = api;
})(typeof window !== "undefined" ? window : globalThis);
