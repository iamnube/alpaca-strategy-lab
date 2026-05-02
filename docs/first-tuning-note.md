# First tuning note after journal cleanup

## What the cleaned data actually says
The scary headline number was misleading.

From the reconciled journal baseline on 2026-05-02:
- Total entries: 23
- Filled-trade reviews: 8
- Canceled/no-fill entries: 15
- Filled-trade win rate: 25%
- Filled-trade expectancy: -0.34R
- **Active-watchlist filled trades: 5**
- **Active-watchlist filled-trade expectancy: about +0.06R**

That means the current ranked-50 active set is not obviously broken yet. The dataset is still tiny, and most of the historical clutter was old canceled/no-fill activity rather than decisive losses.

## Best first tuning stance
**Do not change the core ranked-50 filter yet.**

Instead:
1. Keep the app in review-only mode.
2. Keep the current late-session window at `14:00-16:00 ET` for now.
3. Measure the next **10 active filled trades** before changing the main filter set.

Reason:
- The active filled sample is still small.
- It is slightly positive already.
- A premature filter change would be more story than evidence.

## If one tuning change becomes necessary first
The best next candidate is **time-window tightening**, not a major symbol-list rewrite.

Backtest reference from `data/afternoon-window-refinement.json`:
- `14:00-16:00` mean avgR: `0.208`, worst fold: `0.036`
- `14:30-16:00` mean avgR: `0.206`, worst fold: `0.05`
- `15:00-16:00` mean avgR: `0.08`, worst fold: `-0.113`

Interpretation:
- `14:30-16:00` looks slightly more robust than `14:00-16:00` on the worst fold while keeping similar average quality.
- `15:00-16:00` cuts too far and looks weaker.

## Practical recommendation
- **Now:** keep `14:00-16:00` live, but treat `14:30-16:00` as the first A/B candidate.
- **After 10 more active filled trades:**
  - If expectancy stays positive or near flat, keep the current setup.
  - If expectancy turns clearly negative, test a narrower late-session start before changing symbol ranking or core signal logic.

## Quick commands
- Baseline: `npm run report:journal`
- Reconcile older entries: `npm run reconcile:journal -- --apply`
