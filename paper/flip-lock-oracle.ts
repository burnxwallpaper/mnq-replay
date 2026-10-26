/**
 * Print flip-lock decisions from the web engine so the Python mirror can diff them.
 * Usage: node --import tsx paper/flip-lock-oracle.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_FLIP_LOCK_BARS,
  isOppositeFlipLocked,
  normalizeFlipLockBars,
  noteStopFlipLock,
  resolveEntryLimitFill,
  resolveExitFill,
  type FlipLock,
} from "../lib/strategy-script.ts";

type NoteStep = { note: { exitIndex: number; stopSide: "long" | "short"; reason: "stop" | "target" } };
type CheckStep = { check: { side: "long" | "short"; signalIndex: number } };
type LockCase = { name: string; flipLockBars: number; steps: Array<NoteStep | CheckStep> };
type FillCase = {
  name: string;
  kind: "exit" | "entry";
  bar: { o: number; h: number; l: number; c: number };
  side: "long" | "short";
  stop: number;
  target?: number;
  limit?: number;
};

const cases = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "flip-lock-cases.json"), "utf8"),
) as {
  locks: LockCase[];
  normalize: { raw: unknown; fallback: number | null }[];
  fills: FillCase[];
};

const locks = cases.locks.map((item) => {
  const book: FlipLock[] = [];
  const steps = item.steps.map((step) => {
    if ("note" in step) {
      noteStopFlipLock(book, item.flipLockBars, step.note.exitIndex, step.note.stopSide, step.note.reason);
      return { note: step.note, locks: book.map((lock) => ({ ...lock })) };
    }
    return {
      check: step.check,
      locked: isOppositeFlipLocked(book, step.check.side, step.check.signalIndex),
    };
  });
  return { name: item.name, flipLockBars: item.flipLockBars, steps };
});

const normalize = cases.normalize.map((item) => ({
  raw: item.raw,
  fallback: item.fallback,
  value:
    item.fallback === null || item.fallback === undefined
      ? normalizeFlipLockBars(item.raw)
      : normalizeFlipLockBars(item.raw, item.fallback),
}));

const fills = cases.fills.map((item) => {
  const bar = { ts: 0, v: 0, ...item.bar };
  if (item.kind === "exit") {
    const exit = resolveExitFill(bar, item.side, item.stop, item.target ?? 0);
    return { name: item.name, kind: item.kind, price: exit?.price ?? null, reason: exit?.reason ?? null };
  }
  const fill = resolveEntryLimitFill(bar, item.side, item.limit ?? 0, item.stop);
  return { name: item.name, kind: item.kind, price: fill, reason: null };
});

process.stdout.write(
  JSON.stringify({ defaultFlipLockBars: DEFAULT_FLIP_LOCK_BARS, locks, normalize, fills }),
);
