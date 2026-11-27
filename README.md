# chipme ♠

A minimal poker buy-in counter and settle-up ledger. No build step, no backend: just `index.html`, `styles.css` and `app.js`.

## Features
- Pick a buy-in ($20, $25, $50 or a custom amount) and add your friends
- Pick the blinds (10¢/20¢ up to $2/$5, or custom) and see how many chips of each value to give every player, sized to those blinds and using $2 chips to cut down on small ones, plus the totals for the table and a warning for short stacks
- Joining mid-game asks where the newcomer sits and where the big blind is, and explains whether they post a big-blind premium or wait for the blind
- An oval poker table (wood rail, dark felt) that gains a seat with the player's name for every friend added; during the game it shows the pot and each player's buy-ins and chip stack
- Clay-style chips with edge spots and gold serif values
- Rebuy for the same, more, or less than the buy-in; add late players mid-game
- Animations for buy-ins (chips fly into the pot), busts (screen cracks, skulls rain) and rebuys (chip fountain, "back from the dead")
- Ledger of every action, with undo and per-entry delete
- Cash-out page: enter final stacks, see whether the chips balance (or by how much they're off), and get the fewest e-transfers needed to settle up
- Leaderboard with top winner and biggest loser
- Everything autosaves to `localStorage`, so refreshing or closing the tab doesn't lose the game

## Run locally
Open `index.html` in a browser, or serve the folder:

```bash
npx serve .
```

## Deploy
It's a static site, so Vercel deploys it as-is with no framework preset and no build command.
