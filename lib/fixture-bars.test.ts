import assert from "node:assert/strict";
import test from "node:test";
import {
  historyCatalogFromUnknown,
  RECENT_WINDOW_SEC,
  sliceRecentRaw,
  type RawMnqBar,
} from "./fixture-bars.ts";

function bars(count: number, start: number): RawMnqBar[] {
  const out: RawMnqBar[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ t: start + i * 60, o: 1, h: 2, l: 0.5, c: 1.5, v: i });
  }
  return out;
}

test("sliceRecentRaw keeps the last 90 days", () => {
  const start = 1_700_000_000;
  const raw = bars(200_000, start);
  const last = raw[raw.length - 1]?.t ?? start;
  const sliced = sliceRecentRaw(raw);
  assert.ok(sliced.length < raw.length);
  assert.equal(sliced[0] && sliced[0].t >= last - RECENT_WINDOW_SEC, true);
  assert.equal(sliced[sliced.length - 1]?.t, last);
  const previous = raw[raw.length - sliced.length - 1];
  if (previous) assert.equal(previous.t < last - RECENT_WINDOW_SEC, true);
});

test("history catalog requires a known default pack", () => {
  const catalog = historyCatalogFromUnknown({
    format: "mnq-1m-pack-v1",
    defaultPack: "recent",
    packs: [
      { id: "recent", url: "data/mnq-1m-recent.json", label: "Last 90 days", from: 1, to: 2, bars: 3 },
      {
        id: "full",
        url: "",
        label: "Full history",
        from: 1,
        to: 9,
        bars: 9,
        parts: ["2026"],
      },
    ],
  });
  assert.ok(catalog);
  assert.equal(catalog?.defaultPack, "recent");
  assert.equal(catalog?.packs[1]?.parts?.[0], "2026");
  assert.equal(historyCatalogFromUnknown({ format: "mnq-1m-shards-v1", shards: [] }), null);
  assert.equal(historyCatalogFromUnknown({ format: "mnq-1m-pack-v1", defaultPack: "missing", packs: [] }), null);
});
