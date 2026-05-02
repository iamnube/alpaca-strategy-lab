# Next-session checklist (ranked 50 review-only run)

## Goal
Use the next `14:00-16:00 ET` session to gather evidence, not to optimize mid-stream.

## Current intended state
- Automation: enabled
- Auto-submit: off
- Session window: `14:00-16:00 ET`
- Watchlist cap: `50`
- Symbols per cycle: `10`
- Timeframe: `15Min`
- Reward/risk: `0.9R`

## Before 14:00 ET
1. Run baseline:
   - `npm run report:journal`
2. Confirm no stale backlog remains:
   - `Open/unreviewed entries: 0`
3. Confirm the app is still in review-only mode:
   - `autoSubmit: false`
4. Start the app if needed:
   - `npm start`

## During 14:00-16:00 ET
### What to watch
- Does the app scan without errors?
- Does rotation stay sensible (`10/50` per cycle)?
- Are candidates sparse and intelligible, or noisy and constant?
- Do the flagged setups actually look like clean sweep/reclaim structures?

### What to capture for each meaningful candidate
- symbol
- side
- timestamp
- whether you would have taken it manually
- whether the confirmation looked clean or borderline
- outcome later (`won`, `lost`, `scratched`, or no fill/canceled)
- one short note on why

## After the session
1. Run:
   - `npm run report:journal`
2. If needed, reconcile any stale automation history:
   - `npm run reconcile:journal -- --apply`
3. Compare the new active filled-trade stats against the current baseline:
   - Active filled trades: `5`
   - Active filled win rate: `40%`
   - Active filled expectancy: `0.06R`

## Decision rule
- **Do nothing yet** if the next few filled active trades keep expectancy near flat or positive.
- **Test `14:30-16:00 ET` next** if new results are clearly worse or the first half-hour keeps producing weak setups.
- **Do not rewrite the ranked symbol universe yet** unless the next batch of active filled trades clearly breaks down.

## Anti-goals
- Do not re-enable auto-submit yet.
- Do not tune multiple knobs at once.
- Do not overreact to one or two trades.
