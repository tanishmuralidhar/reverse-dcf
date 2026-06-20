# Reverse DCF

Enter any US-listed ticker and see the **free-cash-flow growth rate the market is pricing into today's stock price** — then stress-test it against the company's own history. A reverse discounted-cash-flow tearsheet with the same "annual report" look as the portfolio site.

![Reverse DCF](public/favicon.svg)

## What it does

- **Reverse DCF** — solves for the FCF growth rate that justifies the current price (the headline number), and tells you whether that's *demanding*, *reasonable*, or *conservative* versus the company's recent growth.
- **Editable assumptions** — discount rate (defaults to a CAPM cost of equity), terminal growth, forecast horizon, and the base free-cash-flow figure. Everything recomputes live.
- **Forward fair value** — set your own growth assumption and see implied value per share and up/downside, with a PV bridge (forecast FCF + terminal value → intrinsic equity value).
- **Sensitivity** — implied growth across a discount-rate × terminal-growth grid, heat-tinted from less to more demanding.
- **Tearsheet** — key statistics (EV, P/E, P/FCF, EV/EBITDA, margins, ROE, net debt, beta) and four years of financial history with a revenue-vs-FCF chart.

## How it works

A two-stage DCF on free cash flow (operating cash flow − capex). The explicit period grows base FCF at the solved rate for the chosen horizon; a Gordon-growth perpetuity captures the rest. Because free cash flow is already a levered, after-tax cash flow to equity, it is discounted at the cost of equity to give intrinsic **equity** value directly (no enterprise-value/net-debt bridge — that would double-count). A bisection solver finds the growth rate that sets value per share equal to the current price. See the in-app **Methodology** section for the full write-up.

> Free cash flow is a poor valuation base for banks, insurers, and other financials — those tickers are flagged. Data is from Yahoo Finance and may be delayed or restated. Educational use only — **not investment advice**.

## Architecture

| Path | Role |
| --- | --- |
| `server.js` | Express server (local dev): serves the static files and exposes `GET /api/company/:ticker`. |
| `lib/provider.js` | Pulls fundamentals from Yahoo Finance (no API key) via `yahoo-finance2` and normalizes them. Combines the `quoteSummary` snapshot with `fundamentalsTimeSeries` history (Yahoo deprecated the `quoteSummary` statement modules in late 2024). |
| `api/company.js` | Vercel serverless wrapper around `getCompany()` for production. |
| `js/dcf.js` | Pure reverse/forward DCF math — no DOM, no network. |
| `js/app.js` | Fetch, render the tearsheet, and recompute on every assumption change. |
| `css/app.css` | The "annual report" design system (shared tokens with the portfolio). |

## Run locally

```bash
cd reverse-dcf
npm install
npm start            # → http://localhost:5050
# or: npm run dev    # auto-restarts on change
```

Then open <http://localhost:5050>. Deep links work: `http://localhost:5050/?t=AAPL`.

## Deploy

This needs a host that runs **Node** — the data layer can't run as a pure static
site because Yahoo blocks browser CORS, so the fetch happens server-side. There
are **no API keys**, so there is nothing to configure or keep secret: anyone who
opens the site and types a ticker gets a result.

### Vercel (recommended)

The static site (`index.html`, `css/`, `js/`) lives at the repo root and
[`api/company.js`](api/company.js) is a serverless function (it reuses
`lib/provider.js`). [`vercel.json`](vercel.json) declares an explicit
static + Node build so Vercel doesn't try to auto-detect the Express server.

1. Push to GitHub.
2. In Vercel → **Add New → Project**, import the repo.
3. **Deploy.** No environment variables; `vercel.json` overrides any build settings.

### Render / Railway (runs the Express server as-is)

Point at this folder, build `npm install`, start `npm start`. They set `PORT`
and the server already reads `process.env.PORT`. Zero code changes.

## API

```
GET /api/company/:ticker   →  { meta, market, trailing, history[], derived, flags }
GET /api/health            →  { ok: true }
```

Responses are cached in-memory for 5 minutes per ticker.
