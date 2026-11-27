/* chipme chip optimiser: picks the chip values and the counts for a stack.
   A stack has to stay playable: the smallest chip divides both blinds, each player gets 10-20 of
   it to post blinds with (about 10% of the stack, as home-game guides advise), every value can be
   broken into the ones below it, chips at or under the big blind cover about 10 big blinds, and no value
   holds more than about 40% of the stack (so ordinary bets don't need change). Among the stacks
   that pass, it takes the one with the fewest chips, counting the smallest values extra and
   charging a little for every extra value in the set. Cents throughout. */
(function (root) {
  "use strict";

  const CANDS = [5, 10, 20, 25, 50, 100, 200, 500, 1000, 2500, 10000];
  const W = [0.6, 0.3];      // extra cost per chip for the smallest and second-smallest value
  const DENOM_COST = 4;      // each extra value makes the set harder to read (guides favour 4-5 values)

  // cheapest exact way to make `r` cents out of `set`, given a cost per chip; null if impossible
  // past this many smallest-chip units the exact search gets slow, so a big stack is filled
  // greedily from the top instead (fast, and still exact to the chip)
  const EXACT_LIMIT = 6000;
  function greedy(set, r, cost, caps) {
    const n = set.map(() => 0);
    for (let i = set.length - 1; i >= 0 && r > 0; i--) {
      const k = Math.min(Math.floor(r / set[i]), caps ? Math.max(0, caps[i]) : Infinity);
      n[i] = k; r -= k * set[i];
    }
    return r ? null : { n, cost: n.reduce((a, x, i) => a + x * cost[i], 0) };
  }
  function fill(set, r, cost) {
    const u = set[0];
    if (r % u) return null;
    if (r / u > EXACT_LIMIT) return greedy(set, r, cost);
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

  // the same, with at most caps[i] more chips of each value (bounded knapsack by binary splitting)
  function fillCapped(set, r, cost, caps) {
    const u = set[0];
    if (r % u) return null;
    if (r / u > EXACT_LIMIT) return greedy(set, r, cost, caps);
    const N = r / u, items = [];
    set.forEach((d, i) => {
      for (let left = Math.max(0, caps[i]), k = 1; left > 0; k *= 2) {
        const take = Math.min(k, left);
        items.push({ i, n: take, w: (take * d) / u, c: take * cost[i] });
        left -= take;
      }
    });
    const best = new Float64Array(N + 1).fill(Infinity);
    const took = items.map(() => new Uint8Array(N + 1));
    best[0] = 0;
    items.forEach((it, j) => {
      for (let v = N; v >= it.w; v--)
        if (best[v - it.w] + it.c < best[v]) { best[v] = best[v - it.w] + it.c; took[j][v] = 1; }
    });
    if (!isFinite(best[N])) return null;
    const n = set.map(() => 0);
    for (let j = items.length - 1, v = N; j >= 0; j--) if (took[j][v]) { n[items[j].i] += items[j].n; v -= items[j].w; }
    return { n, cost: best[N] };
  }

  // no value holds more than this share of a stack, so bets of a few big blinds don't need change
  const SHARE = (k) => (k >= 4 ? 0.4 : k === 3 ? 0.5 : 1);

  // counts for one stack of `T` cents in `set`; null when the set can't make a playable stack.
  // strict = false drops the playability rules (a rebuy too small for them).
  function counts(set, T, bb, strict = true) {
    const k = set.length, cost = set.map((_, i) => 1 + (W[i] || 0));
    if (!strict) return fill(set, T, cost);
    // enough of each value to break the next one up (two of them for the smallest chip)
    const n = set.map(() => 1);
    for (let i = 0; i < k - 1; i++) n[i] = Math.max(n[i], Math.ceil(((i === 0 ? 2 : 1) * set[i + 1]) / set[i]));
    // blind chips: home-game guides put about 10-15% of a stack in the chips used to post blinds.
    // Every player gets at least 10 of the smallest chip, and all the chips at or under the big
    // blind together hold about 10% of the stack (at least 10 big blinds, at most 20 or a quarter), so a
    // 25c/50c game can split it as 10 x 25c + 5 x 50c instead of 20 x 25c.
    n[0] = Math.max(n[0], Math.min(10, Math.floor((0.25 * T) / set[0])));
    const L = Math.min(Math.max(10 * bb, Math.ceil((0.1 * T) / set[0]) * set[0]), 20 * bb, Math.floor((0.25 * T) / set[0]) * set[0]);
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
    // spread the rest: try the share cap, then a looser one, then none
    let rest = null;
    for (const share of [SHARE(k), Math.min(1, SHARE(k) + 0.2), 1]) {
      if (share >= 1) { rest = fill(set, T - used, cost); break; }
      const caps = set.map((d, i) => Math.floor((share * T) / d) - n[i]);
      rest = fillCapped(set, T - used, cost, caps);
      if (rest) break;
    }
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
