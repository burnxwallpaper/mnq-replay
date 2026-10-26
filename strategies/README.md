# Strategies

Each file in this folder, other than `schema.json`, is one strategy. Thresholds live in the file. The engine does not hardcode them.

`impulse_pullback_long` is a 1-minute long:

1. Signal bar: bullish, body at least `minBodyRatio` of its range, body at least `minBodyMultiple` times the recent average body, volume at least `minVolumeMultiple` times recent volume.
2. Within `maxPullbackBars`, a red bar with volume at or below `maxPullbackVolumeMultiple` times that same average, whose close is at least `minClosePositionInSignalRange` of the way from the signal low to the signal high.
3. The setup is confirmed when that pullback bar closes. A buy limit is then working at the signal close for `limitExpiryBars`.
4. Stop is the signal low. Target is `rewardMultiple` R above the fill. If stop and target are both inside one bar, the stop is taken.

`minVolumeMultiple` is 2.5 because a typical 1-minute impulse prints about 2–3× the bars just before it. `minBodyRatio` 0.7 is a full body with small wicks. Edit those numbers in the JSON and refresh the replay.

Add another file with a unique `id` to run a second copy with different thresholds. `enabled: false` skips a file. A new `type` needs a runner; do not invent one by changing the JSON only.

The replay page does not load these JSON files. Its Preset menu runs `lib/strategy-script.ts`. Daytime 09:00–20:29 is the default, including a shared flip lock of 15 one-minute bars after a full stop (opposite side only; 0 turns it off). **Eve 20:30–23:59 · stop2 asym · 2.5R+EMA** is a parked candidate (vstrict 0.7 / 6 / SMA(20) × 2.2, stop at 2× risk1, 2.5R target and EMA→1R still on risk1, long and short together, no flip lock) for a later re-check when more MNQ 1m data is in `public/data/mnq-1m-bars.json`. The paper/IB loop stays on the daytime session and filters and uses the same shared flip lock (default 15; 0 turns it off). See `paper/README.md`.

Tests must use synthetic bars. Do not commit real MNQ prints here.
