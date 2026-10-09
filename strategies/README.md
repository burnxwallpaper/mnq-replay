# Strategies

Each file in this folder, other than `schema.json`, is one strategy. Thresholds live in the file. The engine does not hardcode them.

`impulse_pullback_long` is a 1-minute long:

1. Signal bar: bullish, body at least `minBodyRatio` of its range, body at least `minBodyMultiple` times the recent average body, volume at least `minVolumeMultiple` times recent volume.
2. Within `maxPullbackBars`, a red bar with volume at or below `maxPullbackVolumeMultiple` times that same average, whose close is at least `minClosePositionInSignalRange` of the way from the signal low to the signal high.
3. The setup is confirmed when that pullback bar closes. A buy limit is then working at the signal close for `limitExpiryBars`.
4. Stop is the signal low. Target is `rewardMultiple` R above the fill. If stop and target are both inside one bar, the stop is taken.

`minVolumeMultiple` is 2.5 because a typical 1-minute impulse prints about 2–3× the bars just before it. `minBodyRatio` 0.7 is a full body with small wicks. Edit those numbers in the JSON and refresh the replay.

Add another file with a unique `id` to run a second copy with different thresholds. `enabled: false` skips a file. A new `type` needs a runner; do not invent one by changing the JSON only.

Tests must use synthetic bars. Do not commit real MNQ prints here.
