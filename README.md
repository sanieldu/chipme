# chipme ♠

A minimal poker buy-in counter and settle-up ledger. No build step, no backend: just `index.html`, `styles.css` and `app.js`.

## Features
- Pick a buy-in (preset chips or a custom amount) and add your friends
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
