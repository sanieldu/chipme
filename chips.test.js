// Checks the chip optimiser: every suggested stack adds up exactly and its smallest chip
// divides both blinds. Run with: node chips.test.js
const { plan, counts } = require("./chips.js");
const lbl = (c) => (c < 100 ? `${c}¢` : `$${c / 100}`);
let bad = 0;

for (const [sb, bb] of [[5, 10], [10, 20], [25, 50], [50, 100], [100, 200], [200, 500]])
  for (const T of [500, 1000, 2000, 2500, 5000, 10000, 20000]) {
    const p = plan({ sb, bb }, T);
    const sum = p.n.reduce((a, x, i) => a + x * p.set[i], 0);
    const chips = p.n.reduce((a, x) => a + x, 0);
    const ok = sum === T - (T % p.set[0]) && sb % p.set[0] === 0 && bb % p.set[0] === 0;
    if (!ok) bad++;
    console.log(`${ok ? "ok " : "BAD"} ${lbl(sb)}/${lbl(bb)} $${T / 100}: ${chips} chips  ${p.set.map((d, i) => `${p.n[i]}×${lbl(d)}`).join(" ")}`);
  }

// a rebuy of another size uses the table's set, dropping the rules when it is too small for them
const table = plan({ sb: 25, bb: 50 }, 2500);
for (const T of [500, 1000, 1500, 5000]) {
  const c = counts(table.set, T, 50) || counts(table.set, T, 50, false);
  const sum = c.n.reduce((a, x, i) => a + x * table.set[i], 0);
  if (sum !== T) bad++;
  console.log(`${sum === T ? "ok " : "BAD"} rebuy $${T / 100} in the $25 table's set: ${table.set.map((d, i) => `${c.n[i]}×${lbl(d)}`).join(" ")}`);
}

console.log(bad ? `${bad} failed` : "all good");
process.exit(bad ? 1 : 0);
