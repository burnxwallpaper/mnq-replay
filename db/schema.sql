-- Local 1-minute OHLCV store.
-- One row per symbol and bar-open timestamp. No vendor payloads, cookies, or tokens.
-- ts is Unix epoch milliseconds, UTC, at the open of the minute.
-- Prices are decimal. Volume is contract volume (zero is allowed).
--
-- Sized for MNQ1! 1-minute imports: about 1,380 bars in a 23-hour session,
-- so 25–30 sessions are roughly 35k–42k rows. A year of continuous 1-minute
-- bars is a few hundred thousand rows and stays in this same table.
-- Primary key (symbol, ts) is the range index. Longer CSV or Parquet dumps
-- load here later; they are not stored beside the schema.

CREATE TABLE IF NOT EXISTS bars (
  symbol TEXT NOT NULL CHECK (length(symbol) > 0),
  ts INTEGER NOT NULL CHECK (ts > 0),
  o REAL NOT NULL CHECK (o > 0),
  h REAL NOT NULL CHECK (h > 0),
  l REAL NOT NULL CHECK (l > 0),
  c REAL NOT NULL CHECK (c > 0),
  v REAL NOT NULL CHECK (v >= 0),
  PRIMARY KEY (symbol, ts),
  CHECK (h >= l),
  CHECK (h >= o AND h >= c),
  CHECK (l <= o AND l <= c)
);
