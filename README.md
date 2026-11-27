# chipme ♠

A minimal poker buy-in counter and settle-up ledger. No build step, no backend: `index.html`, `styles.css`, `chips.js` and `app.js`.

## Features
- Setup is four short screens, one question each: who's playing (a drawn table, one seat per friend), the buy-in ($20, $25, $50 or the purple C chip for any amount), the blinds, and the chips; a row of steps on top shows the answers and steps back to any of them
- Pick the blinds (10¢/20¢ up to $2/$5, or custom), then the chips your set has: the ones the blinds need are always in, and you choose the rest (such as $2 and $5), type in the highest chip and add any other value your set has (a $3 or $50 chip)
- Get the chips to hand each player, counted by the optimiser in `chips.js` (below), plus the totals for the table and a warning for short stacks
- During the game, the money in play (everything bought in, less early cash-outs) sits above the table; the table shows each seat's buy-ins and its chips as overlapping stacks
- Rebuy for the same, more or less than the buy-in; bust players out and buy them back in
- Cash out one player mid-game: count just their stack, their result is fixed and they're settled with everyone at the end
- The chipme logo opens a home screen with the saved game, to resume it or start a new one
- Joining mid-game asks where the newcomer sits and where the big blind is, and says whether they post a big-blind premium, wait for the blind, or wait for the button
- Ledger of every action, with undo and per-entry delete
- Cash-out page: enter final stacks, see whether the chips balance (or by how much they're off), and get the fewest e-transfers needed to settle up
- Leaderboard with top winner and biggest loser
- Save a finished game: the date, blinds, players, what each bought in for and left with, the biggest winner and loser and who paid whom go under Past games on the home screen (kept on this device; open one for the details, delete with undo)
- Keyboard shortcuts: N seats or adds a player, D deals, C counts the chips
- Everything autosaves to `localStorage`, so refreshing or closing the tab doesn't lose the game

## How the chips are chosen
With no chips picked yet, `chips.js` suggests a set from the blinds and the main buy-in; once you pick your chips it counts with exactly those. A stack has to stay playable: the smallest chip divides both blinds, each player gets at least 10 of it, and the chips at or under the big blind together hold about 10% of the stack (at most 20 big blinds), as home-game guides advise, every value can be broken into the ones below it, the chips at or under the big blind cover about 10 big blinds, and no one value holds more than about 40% of a stack, so ordinary bets of a few big blinds need no change. Among the sets and counts that pass (values from 5¢ to $100, including 20¢ and $2), it takes the one with the fewest chips, with the smallest values counting extra and a small charge for each extra value. A rebuy of another size is counted in the same set.

```bash
node chips.test.js
```

## Run locally
Open `index.html` in a browser, or serve the folder:

```bash
npx serve .
```

## Deploy
It's a static site, so Vercel deploys it as-is with no framework preset and no build command.
