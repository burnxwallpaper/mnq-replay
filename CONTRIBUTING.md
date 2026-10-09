# Contributing

This repo is a personal MNQ replay scaffold. Keep the first slices small.

## Market data

The chart plays `lib/fixture-bars.ts`, a generated random walk. Keep the synthetic label. Do not replace it with prices presented as real MNQ history, and do not commit dumps.

## Strategies

Add a JSON file in `strategies/` with a unique `id`. Thresholds belong in that file. `strategies/schema.json` is the contract. Tests in `lib/strategies/` must build their own bars. Do not commit real MNQ prints, cookies, or tokens.

The SQLite table is the place for a later MNQ1! 1-minute import (about 35k–42k rows for 25–30 sessions) and for longer vendor dumps. Keep those files in `data/raw/`.

CSV and Parquet dumps belong in `data/raw/`. See `data/README.md` for the column contract. Those files are gitignored. The SQLite database (`DATABASE_PATH`, default `data/bars.sqlite`) is gitignored. `db/schema.sql` is the tracked schema: `symbol`, `ts`, `o`, `h`, `l`, `c`, `v`.

The data source is not decided. A TradingView Premium session is being checked separately for how much 1-minute history it can see. That work stays outside this repo.

## Secrets

Never commit TradingView session cookies, auth tokens, or other credentials. Not in source, not in `.env`, not in dump filenames, not in fixtures. `.env.example` is placeholders only. Real local config goes in `.env`, which is gitignored.

## App

`npm run dev` serves the replay. `npm test` checks the bar store, the synthetic fixture, and the strategy engine.
