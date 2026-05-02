# Ranked 50 paper-test checklist

## Current test mode (set on 2026-05-02)
- Watchlist: ranked 50-name universe
- Session window: 14:00-16:00 ET
- Automation: enabled
- Auto-submit: off
- Symbols per cycle: 10
- Reward/risk: 0.9R
- Confirmation body/range: 0.20
- Reclaim ATR multiplier: 0.20

## Sanity-check result
- UI copy matches the ranked-50 positioning.
- Preset now shows as active.
- Manual run outside the session window correctly skips with: `allowed session is 14:00-16:00 ET`.
- Auto-submit is off, so this is safe review-only paper testing.

## What good looks like

### 1) Operationally correct
- No automation errors.
- The app only scans from 14:00-16:00 ET.
- Rotation behaves normally (`10/50` scanned each run unless settings change).
- No paper orders are placed automatically while auto-submit is off.

### 2) Signal quality looks selective, not noisy
Over 1-2 late-session windows:
- Candidates should be sparse and explainable, not constant spam.
- Journal ideas should look like real sweep/reclaim setups on manual review.
- If almost every run produces many weak candidates, the filter is too loose.
- If two full sessions produce nothing at all, the filter may be too tight for the 50-name universe.

### 3) Early paper benchmark for tuning
After the first 10-20 reviewed paper candidates:
- Target win rate: at least 50%
- Target average R: breakeven or better
- Consecutive losses: preferably <= 4 before reassessment
- Main failure modes to track: late confirmation, weak displacement, noisy symbols, too many low-quality rotations

## Backtest context to compare against
- `data/afternoon-window-refinement.json`: the 14:00-16:00 window had mean avgR `0.208` and worst-fold avgR `0.036`.
- `data/backtest-results.json`: broader ranked-universe summary showed win rate `0.54` and avgR `0.025`.

## What to log during the next 1-2 sessions
For each promising candidate, capture:
- symbol
- side
- time detected
- whether the reclaim/confirmation looked clean
- whether you would have taken it manually
- realized paper outcome in R
- quick note on why it worked or failed

## Quick baseline command
Run this before and after a paper session:
- `npm run report:journal`

It prints the current entry count, review backlog, stale open ideas, and any realized win-rate / expectancy data already captured in the journal.

## Backlog cleanup helper
For older auto-submitted paper entries, you can reconcile likely outcomes from Alpaca paper order history:
- dry run: `npm run reconcile:journal`
- write suggested reviews: `npm run reconcile:journal -- --apply`

This currently targets stale `auto-submitted` and `auto-candidate` entries. It suggests `won`, `lost`, `scratched`, or `canceled` when the Alpaca order flow is clear enough to match by symbol, side, price, and timing. For old `auto-candidate` entries with no matching paper entry order at all, it marks them canceled so the review backlog does not stay artificially open forever.

## Decision rule after 1-2 sessions
- Keep the preset if signals look clean and outcomes are at least roughly breakeven.
- Tighten filters if there is too much noise.
- Relax the scan only if the 14:00-16:00 window stays too quiet across both sessions.
