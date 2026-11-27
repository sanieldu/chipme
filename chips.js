/* chipme chip optimiser: picks the chip values and the counts for a stack.
   A stack has to stay playable: the smallest chip divides both blinds, every value can be broken
   into the ones below it, and chips at or under the big blind cover about 10 big blinds. Among the
   stacks that pass, it takes the one with the fewest chips, counting the smallest values extra and
   charging a little for every extra value in the set. Cents throughout. */
(function (root) {
  "use strict";

  const CANDS = [5, 10, 20, 25, 50, 100, 200, 500, 1000, 2500, 10000];
  const W = [0.6, 0.3];      // extra cost per chip for the smallest and second-smallest value
  const DENOM_COST = 2;      // each extra value makes the set harder to read

  // cheapest exact way to make `r` cents out of `set`, given a cost per chip; null if impossible
  function fill(set, r, cost) {
    const u = set[0];
    if (r % u) return null;
    const N = r / u, best = new Float64Array(N + 1).fill(Infinity), pick = new Int8Array(N + 1).fill(-1);
    best[0] = 0;
    for (let v = 1; v <= N; v++)
      for (let i = 0; i < set.length; i++) {
        const s = set[i] / u;
        if (s <= v && best[v - s] + cost[i] < best[v]) { best[v] = best[v - s] + cost[i]; pick[v] = i; }
      }
    if (!isFinite(best[N])) return null;
    const n = set.map(() => 0);
    for (let v = N; v > 0; v -= set[pick[v]] / u) n[pick[v]]++;
    return { n, cost: best[N] };
  }

  // counts for one stack of `T` cents in `set`; null when the set can't make a playable stack.
  // strict = false drops the playability rules (a rebuy too small for them).
  function counts(set, T, bb, strict = true) {
    const k = set.length, cost = set.map((_, i) => 1 + (W[i] || 0));
    if (!strict) return fill(set, T, cost);
    // enough of each value to break the next one up (two of them for the smallest chip)
    const n = set.map(() => 1);
    for (let i = 0; i < k - 1; i++) n[i] = Math.max(n[i], Math.ceil(((i === 0 ? 2 : 1) * set[i + 1]) / set[i]));
    // chips at or under the big blind cover about 10 big blinds (a quarter of a short stack)
    const L = Math.min(10 * bb, Math.ceil((T * 0.25) / set[0]) * set[0]);
    const low = set.map((d, i) => i).filter((i) => set[i] <= bb);
    if (!low.length) return null;
    let lowVal = low.reduce((a, i) => a + n[i] * set[i], 0);
    for (let j = low.length - 1; j >= 0 && lowVal < L; j--) {
      const i = low[j], room = T - set.reduce((a, d, x) => a + n[x] * d, 0);
      const add = Math.max(0, Math.min(Math.ceil((L - lowVal) / set[i]), Math.floor(room / set[i])));
      n[i] += add; lowVal += add * set[i];
    }
    if (lowVal < L) return null;
    const used = set.reduce((a, d, i) => a + n[i] * d, 0);
    if (used > T) return null;
    const rest = fill(set, T - used, cost);
    if (!rest) return null;
    rest.n.forEach((x, i) => (n[i] += x));
    return { n, cost: n.reduce((a, x, i) => a + x * cost[i], 0) };
  }

  const smallest = (b) => [...CANDS].reverse().find((v) => b.sb % v === 0 && b.bb % v === 0) || 5;

  // tries every sensible set: it starts at the biggest chip dividing both blinds, each next value
  // is a multiple of the smallest and at most 5x the one before, the top chip is at most half a stack
  function bestSet(blinds, T) {
    const d0 = smallest(blinds);
    const up = CANDS.filter((v) => v > d0 && v % d0 === 0 && v <= T / 2);
    let best = null;
    const walk = (set) => {
      if (set.length >= 2) {
        const c = counts(set, T - (T % d0), blinds.bb);
        if (c) {
          const score = c.cost + DENOM_COST * set.length;
          if (!best || score < best.score) best = { set: [...set], n: c.n, score };
        }
      }
      if (set.length === 6) return;
      for (const v of up) if (v > set[set.length - 1] && v <= set[set.length - 1] * 5) walk([...set, v]);
    };
    walk([d0]);
    return best;
  }

  // the plan for a table; with nothing playable (a tiny buy-in) it is the smallest chip alone
  function plan(blinds, T) {
    const b = bestSet(blinds, T);
    if (b) return b;
    const d0 = smallest(blinds);
    return { set: [d0], n: [Math.floor(T / d0)], score: 0 };
  }

  const api = { CANDS, bestSet, counts, plan };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ChipOpt = api;
})(typeof window !== "undefined" ? window : globalThis);
