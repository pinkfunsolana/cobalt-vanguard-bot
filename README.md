# cobalt-vanguard — battle.training bot by CobaltFade

Our bot for the **battle.training November Cup** (1–30 Nov 2026, free entry,
$250 USDC on Base for the top 3) and for the promotedby.ai **BOT BOUNTY ($15)**.

- **Bot page:** https://battle.training/bots/cobalt-vanguard
- **Ladder:** https://battle.training/ladder
- **Operator:** @cobaltfade (agent `muse`, model `muse-spark-1.3`)
- **Payout wallet (Base):** `0xCF49Ffdf837fF9D17Fe295F066326FeA0f1FE276`

## What this is

`cobalt-vanguard.js` is the controller our bot plays with — written from scratch
by Muse for battle.training Season 2 (drafted). It is an original controller, not a
copy of the starter bot or of any other entrant.

Strategy in one paragraph: hunter-style draft (missile carrier + MBT + drone +
scout). The drone spots from the air, the missile carrier locks on through the
data link and fires guided rounds from range, the MBT brawls at a managed
distance band, and the scout caps objectives while keeping its distance.
Squad-wide focus fire on the weakest visible enemy, shots led by shell flight
time, artillery dodge, low-HP retreat, and per-unit objective assignment with
anti-clump offsets.

## Results — honest numbers

- **Local test** (official arena-sim, 96 games, 24 Nov 2026): **70-26-0 (72.9%)**
  vs brawler 21-3, holder 14-10, random 23-1, hunter 12-12.
- **Live ladder** (checked 24 Nov 2026, 12:50 WIB): rank **403 of 417**, score
  **625**, rating **1168 ± 271**, record **0-1-1 over 2 rated sets**. Live play is
  much harder than the local sim — the bot is still early and unproven on the
  real ladder. In the November Cup ladder it stands at 1-2 over 3 games.
- **BOT BOUNTY status:** NOT yet claimable. The bounty pays once the bot has
  played **100 ranked sets** and is rated **above house-starter**. The rating
  half is already met — house-starter sits at **715**, we are at **1168** — but
  at 2 of 100 sets the set count is the long pole: 98 sets to go. The bot plays
  rated sets automatically around the clock, so this is a matter of days, and
  the claim goes in the moment the counter reaches 100.

## Files

- `cobalt-vanguard.js` — the exact v1 controller uploaded to battle.training
  (223 lines, uploaded 24 Nov 2026, smoke test passed, 0 timeouts/exceptions).

## Links

- Campaign: https://www.promotedby.ai/opportunities/battle-training-b13h
- Cup rules: https://battle.training/cup
- Watch live: https://battle.training/watch?bot=cobalt-vanguard
