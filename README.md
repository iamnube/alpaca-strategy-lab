# Alpaca Strategy Lab

A local MVP dashboard for paper trading an ICT-style liquidity sweep workflow with Alpaca paper trading.

## What it does

- Shows a paper-trading-only status banner
- Encodes the strategy into a checklist inside the app
- Displays Alpaca paper account status when credentials are present
- Lets you maintain a watchlist and see latest quote/trade data
- Gives you a manual setup checklist form and persistent journal
- Lets you submit paper market or limit orders to Alpaca
- Stores journal entries and watchlist locally in `data/`

## Guardrails

- This app uses Alpaca's **paper** API mode only
- There is **no live trading toggle** in the UI
- It is built for manual or semi-manual execution, not blind automation

## Stack

- Node.js
- Express + EJS
- Alpaca Trade API SDK
- Local JSON persistence

## Setup

```bash
cd /Users/openclaw/.openclaw/workspace/alpaca-strategy-lab
cp .env.example .env
npm install
npm run dev
```

Then open:

```bash
http://localhost:3000
```

## Required env vars for Alpaca paper trading

```env
PORT=3000
ALPACA_API_KEY=your_paper_key_here
ALPACA_SECRET_KEY=your_paper_secret_here
```

Get these from your Alpaca paper account, not live trading credentials.

## Scripts

```bash
npm run dev
npm start
```

## Recommended workflow

1. Mark the liquidity levels you care about before the session.
2. Watch for a sweep of those highs/lows.
3. Confirm displacement and structure shift.
4. Fill out the checklist form before placing the trade.
5. Save the setup to the journal.
6. If it still looks valid, submit the paper order.
7. Review the journal later and refine the checklist.

## Project structure

```text
src/server.js       Express app
views/index.ejs     UI
public/styles.css   Styling
data/               Local watchlist and journal storage
```

## Notes for later

Potential next upgrades:

- Auto-detect sweep candidates from candle data
- Better journaling metrics, screenshots, and P/L tracking
- Bracket orders and risk sizing helpers
- Multi-timeframe market structure panels
- Authentication if you want remote access

## Safety note

This is educational tooling for paper trading workflow support. Validate everything yourself before acting.
