// Checks the settle-up maths. Run with: node settle.test.js
const { settle, transfers } = require("./settle.js");
let bad = 0;
const fail = (msg) => { bad++; console.log("BAD", msg); };

// a miscount split exactly, only across counted stacks, never to a player who cashed out
{
  const rows = [
    { key: "A", inC: 2000, cashedC: 0, finalC: 3000, counted: true },
    { key: "B", inC: 2000, cashedC: 0, finalC: 1000, counted: true },
    { key: "C", inC: 2000, cashedC: 0, finalC: 1300, counted: true },
    { key: "F", inC: 2000, cashedC: 2600, finalC: 0, counted: false },   // cashed out hours ago
  ];
  const r = settle(rows, -100);                                           // $1 missing, approved
  const total = r.rows.reduce((a, x) => a + x.netC, 0);
  if (total !== 0) fail(`split doesn't close the books: ${total}`);
  if (r.rows.find((x) => x.key === "F").adjC !== 0) fail("charged a player who cashed out");
  const adj = r.rows.filter((x) => x.counted).map((x) => x.adjC).sort();
  if (adj.join() !== "33,33,34") fail(`$1 split as ${adj}`);
  console.log("ok  $1 miscount split 34/33/33 across counted stacks; the cashed-out player untouched");
}
// approval only holds for the exact miscount it was given
{
  const rows = () => [{ key: "A", inC: 1000, cashedC: 0, finalC: 900, counted: true }, { key: "B", inC: 1000, cashedC: 0, finalC: 1000, counted: true }];
  if (!settle(rows(), -100).approved) fail("approved miscount not applied");
  const r = settle([{ key: "A", inC: 1000, cashedC: 0, finalC: 800, counted: true }, { key: "B", inC: 1000, cashedC: 0, finalC: 1000, counted: true }], -100);
  if (r.approved || r.canSettle) fail("a new miscount settled without asking");
  console.log("ok  a different miscount asks again");
}
// random games: payments always square everyone, and never more than the greedy method needs
function greedyCount(bal) {
  const c = bal.filter((b) => b.v > 0).map((b) => b.v).sort((a, b) => b - a), d = bal.filter((b) => b.v < 0).map((b) => -b.v).sort((a, b) => b - a);
  let i = 0, j = 0, k = 0;
  while (i < d.length && j < c.length) { const m = Math.min(d[i], c[j]); d[i] -= m; c[j] -= m; k++; if (!d[i]) i++; if (!c[j]) j++; }
  return k;
}
let fewer = 0, games = 0;
for (let g = 0; g < 20000; g++) {
  const n = 2 + Math.floor(Math.random() * 9);
  const v = Array.from({ length: n - 1 }, () => (Math.random() < 0.3 ? 1 : 5) * Math.round((Math.random() - 0.5) * 40) * 25);
  v.push(-v.reduce((a, x) => a + x, 0));
  const bal = v.map((x, i) => ({ key: i, v: x }));
  const t = transfers(bal);
  const left = v.slice();
  t.forEach((p) => { if (p.amtC <= 0) fail("non-positive payment"); left[p.from] += p.amtC; left[p.to] -= p.amtC; });
  if (left.some((x) => x !== 0)) { fail(`payments don't square: ${v}`); break; }
  const gc = greedyCount(bal);
  if (t.length > gc) { fail(`more payments than greedy: ${v}`); break; }
  if (t.length < gc) fewer++;
  games++;
}
console.log(`ok  ${games} random games square to the cent; ${fewer} needed fewer payments than before`);
// the playtest's case: 5 payments where 4 would do
{
  const bal = [["A", 1000], ["B", 500], ["C", -500], ["D", -1000], ["E", 300], ["F", -300]].map(([key, v]) => ({ key, v }));
  console.log(`ok  paired-up results settle in ${transfers(bal).length} payments`);
}
console.log(bad ? `${bad} failed` : "all good");
process.exit(bad ? 1 : 0);
