# Bar dumps

Future 1-minute MNQ files land in `data/raw/`. That directory is gitignored except for this note's sibling `.gitkeep`. The SQLite store (`data/bars.sqlite` by default) is gitignored too.

Nothing in this folder is market data. Do not add a sample series and label it MNQ.

## Expected columns

| Column | Meaning |
| --- | --- |
| `symbol` | `MNQ1!` for the continuous Micro E-mini Nasdaq-100. Outright months can use their own symbol in the same table. |
| `ts` | Bar open time, UTC. Store it as Unix milliseconds. CSV may use ISO-8601; ingest must convert. |
| `o`, `h`, `l`, `c` | Open, high, low, close. |
| `v` | Volume. Zero is allowed. |

CSV or Parquet, same columns. A 25–30 day MNQ1! minute dump is on the order of 35k–42k rows (`mnq1-1m-YYYYMMDD-YYYYMMDD.csv` or `.parquet`). Longer vendor files use the same columns and the same SQLite table. The ingest job is not written yet. Apply `db/schema.sql` first (`npm run db:init`).

Do not put session cookies, tokens, or vendor account exports that contain secrets in `data/raw/` or in git.
