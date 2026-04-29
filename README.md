# Alpaca Strategy Lab

Local **paper-trading only** dashboard and automation runner for testing a liquidity-sweep workflow on Alpaca.

## What it does now

Alpaca Strategy Lab has moved beyond a simple journal app. It now supports:

- manual and automated **paper** trade workflows
- watchlist management across a broader symbol universe
- recurring scan cycles while the server is running
- chunked, rotating watchlist scans to reduce API pressure
- candidate generation based on a simple, inspectable liquidity-sweep rule
- optional automatic submission of **paper bracket orders**
- risk sizing, workflow states, and post-trade review
- analytics around ideas, outcomes, and realized R
- automation logs explaining why trades were taken, skipped, blocked, or failed

## Core automation behavior

While the app server is running, automation can:

- scan the current watchlist on a configured interval
- batch bar requests per cycle rather than one request per symbol
- rotate through the watchlist in chunks so larger lists are not fully rescanned every pass
- pull recent Alpaca bars using the paper/data APIs
- evaluate the latest bar for a sweep-and-reclaim or sweep-and-reject setup
- generate candidate trades with:
  - side
  - entry
  - stop
  - target
  - quantity
  - reason text
- optionally auto-submit **paper-only bracket orders** when auto-submit is enabled
- persist candidate history, run summaries, open workflows, and automation activity under `data/`

## Strategy rule in this version

Automation currently uses a deliberately simple and inspectable rule on the **latest bar** of the selected timeframe.

### Buy candidate
- latest bar sweeps below the recent rolling low
- closes back above that low
- closes bullish
- passes minimum displacement and structure-quality checks

### Sell candidate
- latest bar sweeps above the recent rolling high
- closes back below that high
- closes bearish
- passes minimum displacement and structure-quality checks

### Order construction
- entry defaults to a paper limit near the trigger close
- stop uses the trigger extreme plus configurable buffer
- target uses configured reward-to-risk
- quantity uses configured dollar risk per trade
- optional bracket orders require both take-profit and stop-loss

This is still intentionally understandable, not a black-box trading engine.

## Safety controls

- paper-only labeling throughout the app
- no live mode, no live toggle, no live endpoint support
- automation enable/disable toggle
- auto-submit toggle
- watchlist-only scope control
- configurable risk guardrails, including:
  - risk per trade
  - max open positions
  - max concurrent orders per symbol
  - stop buffer
  - reward-to-risk
- watchlist size cap
- clear automation activity log
- explicit deferred/unchanged-bar logging when scans are skipped on purpose

## Current default watchlist

The default/persisted watchlist is now a tighter late-session paper basket built from the strongest symbols in the recent walk-forward tests:

- WMT
- MSFT
- GOOGL
- NVDA
- MA

This keeps the scanner focused on the current lead setup instead of spreading attention across the broader ETF-heavy list.

## Requirements

- Node.js 22+ recommended
- Alpaca **paper** account credentials for quotes, bars, positions, and order placement

## Setup

```bash
cd /Users/openclaw/.openclaw/workspace/alpaca-strategy-lab
cp .env.example .env
npm install
```

Fill in `.env` with your **paper** credentials:

```env
PORT=3001
APP_DATA_DIR=./data
ALPACA_API_KEY=your_paper_key_here
ALPACA_SECRET_KEY=your_paper_secret_here
```

Notes:
- `PORT` is env-driven. If you change it, the app will run on that port.
- `APP_DATA_DIR` controls where journal/settings/automation data are stored.
- In your current setup, the app is using **3001**.

## Run

Development:

```bash
npm run dev
```

Normal run:

```bash
npm start
```

Then open:
- `http://127.0.0.1:3001` in your current setup
- or `http://127.0.0.1:<PORT>` if you change the env value

## Recommended first-use flow

1. Add your Alpaca **paper** keys to `.env`
2. Start the app
3. Confirm the account/status panel loads correctly
4. Review the current watchlist and automation settings
5. Leave **auto-submit off** for the first pass if you want review-only mode
6. Use **Run scan now** to verify the rule behavior on the current market
7. Review candidates and the automation activity log
8. If results look sane, enable automation
9. Keep watchlist rotation enabled unless you intentionally want full rescans every cycle
10. Only then consider enabling auto-submit, still paper-only

## Tuned defaults in this pass

- poll interval: 600 seconds
- timeframe: 15 minute bars
- watchlist cap: 5 symbols
- symbols per cycle: 5
- watchlist rotation: enabled
- auto-submit: off in persisted settings
- allowed session: 2 PM to 4 PM ET
- minimum sweep: 0.03% of price, 0.02% for supported ETFs
- minimum body/range ratio: 0.22
- confirmation body/range ratio: 0.18
- reclaim ATR multiplier: 0.10
- reward to risk: 1.0R

This lowers the default automation load and aligns the paper runner with the current lead strategy candidate from the walk-forward backtests.

## Workflow and journaling features

The app now supports:

- workflow states:
  - `planned`
  - `submitted`
  - `open`
  - `won`
  - `lost`
  - `scratched`
  - `canceled`
- post-trade review
- realized R tracking
- outcome notes
- analytics including:
  - total ideas
  - open workflows
  - win rate
  - expectancy
  - average checklist score
  - total realized R
  - top symbols

## Scripts

```bash
npm run dev
npm start
npm test
npm run lint
npm run check
```

## Data files

- `data/settings.json` — watchlist plus automation settings
- `data/automation-status.json` — latest runs, candidates, activity log, errors
- `data/journal.json` — manual and automation-created workflows

## Validated

`npm run check` currently passes and covers:

- app boot and isolated storage creation
- watchlist normalization and persistence
- automation settings persistence
- journal create and review flows
- sizing math and risk helper behavior
- sweep-rule candidate generation
- paper order validation and normalized payloads
- bracket order handling
- automation cycle auto-submit behavior with mocked Alpaca data
- connected dashboard rendering

## What still requires manual judgment

- whether the strategy is actually strong enough across market regimes
- whether the selected symbols and thresholds fit your style
- whether auto-submit should be enabled at all times
- post-trade grading and continuous tuning
- broader market context, news, and session behavior, which this app does not understand yet

## Current non-blocking limitations

- no charting yet
- no automatic multi-timeframe structure analysis yet
- no advanced sweep detection beyond the current latest-bar rule
- no authentication, so keep it local/private

## Safety note

This project is for **paper trading workflow automation only**. Validate the behavior yourself before trusting it, and do not adapt it to live trading without a much deeper risk, monitoring, and control layer.
