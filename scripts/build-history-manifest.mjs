/**
 * Rebuild docs/data/mnq-1m-bars.json and the default 90-day file from year shards.
 *   node scripts/build-history-manifest.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const RECENT_WINDOW_SEC = 90 * 24 * 60 * 60;
const years = [2021, 2022, 2023, 2024, 2025, 2026];

function kBars(count) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M bars`;
  if (count >= 1000) return `${Math.round(count / 1000)}k bars`;
  return `${count} bars`;
}

const yearPacks = [];
let previous = null;
let current = null;
let jsonBytes = 0;
for (const year of years) {
  const file = `docs/data/mnq-1m-bars-${year}.json`;
  const text = readFileSync(file);
  jsonBytes += text.length;
  const raw = JSON.parse(text.toString("utf8"));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${file} is empty`);
  }
  yearPacks.push({
    id: String(year),
    url: `data/mnq-1m-bars-${year}.json`,
    label: `${year} · ${kBars(raw.length)}`,
    from: raw[0].t,
    to: raw[raw.length - 1].t,
    bars: raw.length,
  });
  previous = current;
  current = raw;
}

if (!current) throw new Error("No year shards");
const lastT = current[current.length - 1].t;
const cutoff = lastT - RECENT_WINDOW_SEC;
let recent = current.filter((bar) => bar.t >= cutoff);
if (current[0].t > cutoff && previous) {
  recent = previous.filter((bar) => bar.t >= cutoff).concat(recent);
}

const recentText = JSON.stringify(recent);
writeFileSync("docs/data/mnq-1m-recent.json", recentText);

const manifest = {
  format: "mnq-1m-pack-v1",
  defaultPack: "recent",
  packs: [
    {
      id: "recent",
      url: "data/mnq-1m-recent.json",
      label: `Last 90 days · ${kBars(recent.length)}`,
      from: recent[0].t,
      to: recent[recent.length - 1].t,
      bars: recent.length,
    },
    ...yearPacks,
    {
      id: "full",
      url: "",
      label: `Full history · ${kBars(yearPacks.reduce((sum, pack) => sum + pack.bars, 0))}`,
      from: yearPacks[0].from,
      to: yearPacks[yearPacks.length - 1].to,
      bars: yearPacks.reduce((sum, pack) => sum + pack.bars, 0),
      parts: yearPacks.map((pack) => pack.id),
    },
  ],
};
writeFileSync("docs/data/mnq-1m-bars.json", `${JSON.stringify(manifest, null, 2)}\n`);

const recentGz = gzipSync(recentText).length;
console.log(
  JSON.stringify(
    {
      years: yearPacks.map((pack) => ({ id: pack.id, bars: pack.bars })),
      recentBars: recent.length,
      recentBytes: recentText.length,
      recentGzip: recentGz,
      yearJsonBytes: jsonBytes,
      fullBars: manifest.packs.find((pack) => pack.id === "full")?.bars,
    },
    null,
    2,
  ),
);
