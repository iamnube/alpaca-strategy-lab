# Alpaca Strategy Lab

Local paper-trading dashboard and automation runner for a simple liquidity-sweep workflow on Alpaca paper trading.

## What automation does now

- Runs a scheduled scan on the current watchlist while the app server is running
- Pulls recent Alpaca bars on a selected timeframe, then evaluates a practical sweep-and-reclaim / sweep-and-reject rule
- Generates paper trade candidates with entry, stop, target, quantity, and reason text
- Can stay in review-only mode or automatically place paper bracket orders when auto-submit is enabled
- Tracks automation runs, candidate history, activity logs, open positions, open orders, and journal workflows
- Persists local settings and automation status under `data/`

## Safety controls

- Paper-only labeling across the app
- No live mode, no live toggle, no live endpoint support
- Automation enable/disable toggle
- Watchlist-only scope control
- Risk guardrails: risk per trade, max open positions, max open orders per symbol, price bounds, stop buffer, reward/risk
- Clear logs explaining why a trade was taken, skipped, blocked, or failed

## Strategy logic in this MVP

Automation looks only at the latest bar on the chosen timeframe:

- **Buy candidate:** latest bar sweeps below the recent rolling low, closes back above that low, and closes bullish with minimum displacement
- **Sell candidate:** latest bar sweeps above the recent rolling high, closes back below that high, and closes bearish with minimum displacement
- Entry defaults to a paper limit at the trigger close
- Stop uses the trigger extreme plus configurable buffer
- Target uses configured reward-to-risk
- Quantity uses configured dollar risk per trade

This is intentionally understandable, inspectable, and local, not a black-box strategy engine.

## Requirements

- Node.js 22+ recommended
- Alpaca paper account credentials for quotes, bars, positions, and order placement

## Setup

```bash
cd /Users/openclaw/.openclaw/workspace/alpaca-strategy-lab
cp .env.example .env
npm install
```

Fill in `.env`:

```env
PORT=3000
APP_DATA_DIR=./data
ALPACA_API_KEY=your_paper_key_here
ALPACA_SECRET_KEY=your_paper_secret_here
```

## Run

Development:

```bash
npm run dev
```

Normal run:

```bash
npm start
```

Then open `http://localhost:3000`.

## First-use flow

1. Add your Alpaca **paper** keys to `.env`
2. Start the app
3. Set the watchlist scope
4. Configure automation settings
5. Leave **Auto-place paper bracket orders** off if you want review-only mode first
6. Use **Run scan now** to validate the rule behavior
7. If the logs and candidates look sane, enable automation and optionally auto-submit

## Scripts

```bash
npm run dev
npm start
npm test
npm run lint
npm run check
```

## Data files

- `data/settings.json` - watchlist plus automation settings
- `data/automation-status.json` - latest runs, candidates, activity log, errors
- `data/journal.json` - manual and automation-created workflows

## Validated

`npm run check` currently passes and covers:

- default app boot and isolated storage creation
- watchlist normalization and persistence
- automation settings persistence
- journal create and review flows
- sizing math
- sweep-rule candidate generation
- paper order validation and normalized payloads
- automation cycle auto-submit behavior with mocked Alpaca data
- connected dashboard rendering

## Still requires manual review

- Strategy quality, symbol selection, and whether the latest-bar setup is actually worth taking
- Market regime and session context, this MVP does not understand news or calendar events
- Whether auto-submit should be enabled for your account and watchlist
- Post-trade review and journal grading

## Safety note

This project is for paper trading workflow automation only. Validate behavior yourself before trusting the automation, and do not adapt it to live trading.
