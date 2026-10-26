# MNQ Replay

Personal 1-minute Micro E-mini Nasdaq-100 replay. The page is a candlestick chart with play, pause, step, and a scrubber.

The chart loads real `CME_MINI:MNQ1!` 1-minute OHLCV from `public/data/mnq-1m-bars.json` (TradingView Premium prodata dump). Refresh that file to update history.

## Preview

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:43123](http://127.0.0.1:43123).

## GitHub Pages

`npm run build` writes a static site to `out/` (`out/index.html` plus `out/_next/`). Opening that file directly in a browser will not load the chart. Serve the folder:

```bash
npm run build
npm run preview
```

Preview listens on [http://127.0.0.1:43124](http://127.0.0.1:43124). Leave `BASE_PATH` unset for this. Assets are rooted at `/`.

The GitHub repository is [burnxwallpaper/mnq-replay](https://github.com/burnxwallpaper/mnq-replay). From a machine logged into that account (`gh auth login`), publish and turn on Pages with:

```bash
git push -u https://github.com/burnxwallpaper/mnq-replay.git main && gh api --method POST -H "Accept: application/vnd.github+json" /repos/burnxwallpaper/mnq-replay/pages -f build_type=workflow
```

That push runs `.github/workflows/pages.yml`, which builds `out/` with `BASE_PATH=/mnq-replay` and deploys it. The site is [https://burnxwallpaper.github.io/mnq-replay/](https://burnxwallpaper.github.io/mnq-replay/) after the action succeeds. This repository is public, so Pages does not require GitHub Pro. A private repo on a free account cannot serve Pages.

`BASE_PATH` is required only when the site is not at the domain root:

| Site | `BASE_PATH` |
| --- | --- |
| Local preview, or a repository named `<owner>.github.io` | unset |
| Project site at `https://<owner>.github.io/<repository>/` | `/<repository>` in lowercase |

The workflow sets that from the repository name. A hand build for a project site is `BASE_PATH=/<repository> npm run build`.

Space plays and pauses. The range input scrubs the cursor. Bars after the cursor stay hidden, and strategy markers appear only once the cursor reaches them. The side panel shows total R and dollar PnL for enabled strategies, including an open trade marked at the cursor close.

The chart’s backtest runs the browser scripts in `lib/strategy-script.ts` (the editor at the bottom of the page). `strategies/*.json` is a separate impulse-pullback schema and is not what the page runs.

The Preset menu has two choices. **Daytime 09:00–20:29 (default)** is selected on a fresh visit: America/Chicago 09:00–20:29, no new Friday entries from 14:45, filters 0.45 / 2 / 15 / 1.2, stop at the signal-bar extreme, target 2.5R, and a close through the 5 EMA tightens the target to 1R. After a trade closes on a full stop, flip lock blocks a new entry on the opposite side for the next 15 one-minute bars (same-side entries still allowed). The lock is shared by Long and Short, so it only applies when both runners are checked. Set **Flip lock bars** to 0 and Save to turn it off. Long starts on and short stays off until it is checked. The paper and IB loop use this same daytime session, filters, and shared flip lock (default 15; set it to 0 to turn it off). See `paper/README.md` to start IBKR Paper on Gateway port 4002. That loop is Paper only.

**Eve 20:30–23:59 · stop2 asym · 2.5R+EMA** is optional. It is a candidate parked so it can be loaded again after more MNQ 1-minute bars arrive. It does not replace the daytime default and does not use the daytime flip lock. New entries are allowed only from 20:30 through 23:59 Chicago, not during the rest of the overnight session. Filters are vstrict: body/range 0.7, body at least 6 points, volume above SMA(20) × 2.2. `risk1` is `max(|close − extreme|, 1)` (long extreme = bar low, short extreme = bar high). The stop is `2 × risk1` from the signal close; the 2.5R target and the EMA→1R tighten still use `risk1`. Choosing the preset turns long and short on together. The entry limit still expires after 2 completed 1-minute bars, the default fee is $1.6, and size is 1 MNQ. A snapshot on the 41581-bar file (run the backtest again after each data refresh; these figures are not a live guarantee): about $10,642 final asset, max drawdown $185, win rate 69%, 62 trades. The page’s average R is in risk1 units (about +0.38R on that file). The earlier +0.19 figure counted the same trades with the widened stop as 1R.

`impulse_pullback_long` in `strategies/` buys a limit at the signal close after a low-volume red pullback holds the upper half of a large full-body impulse, with the stop at the signal low and the target at 2.5R. Volume and body thresholds are in that file (volume about 2.5× recent bars). `Node.js 22` is required for the optional SQLite scripts (`NODE_OPTIONS=--experimental-sqlite` is set by npm).

## Later

1. **Ingest** 1-minute OHLCV into `data/raw/` as CSV or Parquet. The data source is not chosen yet.
2. **Store** rows in `data/bars.sqlite` using `db/schema.sql` (`symbol`, `ts`, `o`, `h`, `l`, `c`, `v`). Use symbol `MNQ1!` for the continuous contract. `npm run db:init` creates an empty file. About 35k–42k rows cover 25–30 sessions; longer dumps use the same table.
3. **Point the chart at that store** instead of the fixture.

TradingView, logged out, exposes roughly the current week of 1-minute bars. A Premium session is being checked separately for how far that history goes. Do not add session cookies, tokens, or other secrets to this repo.

## Layout

| Path | Role |
| --- | --- |
| `app/` | Replay page, statically exported to `out/` |
| `.github/workflows/pages.yml` | GitHub Actions deploy of `out/` |
| `lib/fixture-bars.ts` | Bar loaders/formatters; data file is `public/data/mnq-1m-bars.json` |
| `public/data/mnq-1m-bars.json` | Real MNQ1! 1m OHLCV (`t,o,h,l,c,v`) |
| `strategies/` | One JSON config per strategy, plus `schema.json` |
| `db/schema.sql` | Tracked bar-table schema |
| `data/raw/` | Future dumps, gitignored |
| `.env.example` | Placeholders only |

See `data/README.md` and `CONTRIBUTING.md`.

## Checks

```bash
npm test
npm run lint
```
