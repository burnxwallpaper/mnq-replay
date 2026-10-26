"use client";

import { useEffect, useMemo, useState } from "react";

import type { EntryFilters } from "@/lib/strategy-script";
import {
  DEFAULT_ENTRY_FILTERS,
  DEFAULT_FLIP_LOCK_BARS,
  DEFAULT_ROUND_TRIP_FEE_USD,
  normalizeEntryFilters,
  normalizeFlipLockBars,
  normalizeRoundTripFee,
} from "@/lib/strategy-script";

type Field = {
  key: keyof EntryFilters;
  label: string;
  help: string;
  step: number;
  min: number;
  max: number;
};

const FIELDS: Field[] = [
  {
    key: "bodyRatio",
    label: "Body / range",
    help: "實體佔波幅比例",
    step: 0.05,
    min: 0.05,
    max: 1,
  },
  {
    key: "minBody",
    label: "Min body pts",
    help: "最少實體點數",
    step: 0.25,
    min: 0.25,
    max: 200,
  },
  {
    key: "volLen",
    label: "Vol SMA",
    help: "成交量均線長度",
    step: 1,
    min: 2,
    max: 200,
  },
  {
    key: "volMult",
    label: "Vol ×",
    help: "放量倍數",
    step: 0.1,
    min: 0.1,
    max: 20,
  },
];

function filtersEqual(a: EntryFilters, b: EntryFilters) {
  return (
    a.bodyRatio === b.bodyRatio &&
    a.minBody === b.minBody &&
    a.volLen === b.volLen &&
    a.volMult === b.volMult
  );
}

export type EntryFiltersSave = {
  filters: EntryFilters;
  roundTripFeeUsd: number;
  /** Present on the daytime panel. Eve saves omit it so the daytime value stays put. */
  flipLockBars?: number;
};

export function EntryFiltersPanel({
  value,
  feeUsd,
  flipLockBars = DEFAULT_FLIP_LOCK_BARS,
  onChange,
  locked = false,
  lockedNote,
}: {
  value: EntryFilters;
  feeUsd: number;
  /** Daytime only. Bars to block the opposite side after a full stop. 0 = off. */
  flipLockBars?: number;
  onChange: (next: EntryFiltersSave) => void;
  /** Preset bakes these numbers into its scripts, so the knobs do not edit that preset. */
  locked?: boolean;
  lockedNote?: string;
}) {
  const [draft, setDraft] = useState<EntryFilters>(value);
  const [feeDraft, setFeeDraft] = useState<number>(feeUsd);
  const [flipDraft, setFlipDraft] = useState<number>(flipLockBars);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    setFeeDraft(feeUsd);
  }, [feeUsd]);

  useEffect(() => {
    setFlipDraft(flipLockBars);
  }, [flipLockBars]);

  const dirty = useMemo(
    () => !filtersEqual(draft, value) || feeDraft !== feeUsd || (!locked && flipDraft !== flipLockBars),
    [draft, value, feeDraft, feeUsd, flipDraft, flipLockBars, locked],
  );

  return (
    <section
      id="entry-filters"
      aria-label="Entry filter parameters"
      className="flex flex-col gap-2 rounded-lg bg-foreground/5 px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
            Entry filters
          </h2>
          <p className="text-xs text-muted-foreground">
            {locked
              ? (lockedNote ??
                "This preset bakes its filters into the script. Switch to Daytime to edit the default.")
              : "改數字後撳 Save 先套用到 Long／Short 預設腳本、手續費同 flip lock（session + 5 EMA 不變）· body ≥ ratio · body pts · vol > SMA × mult · round-trip fee · 止蝕後封鎖對面新倉"}
            {(locked ? feeDraft !== feeUsd : dirty) ? (
              <span className="ml-1 text-amber-300/90">· unsaved</span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {locked ? null : (
            <button
              type="button"
              className="font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => {
                setDraft(DEFAULT_ENTRY_FILTERS);
                setFeeDraft(DEFAULT_ROUND_TRIP_FEE_USD);
                setFlipDraft(DEFAULT_FLIP_LOCK_BARS);
              }}
            >
              Reset {DEFAULT_ENTRY_FILTERS.bodyRatio} / {DEFAULT_ENTRY_FILTERS.minBody} /{" "}
              {DEFAULT_ENTRY_FILTERS.volLen}×{DEFAULT_ENTRY_FILTERS.volMult} · fee $
              {DEFAULT_ROUND_TRIP_FEE_USD} · flip {DEFAULT_FLIP_LOCK_BARS}
            </button>
          )}
          <button
            type="button"
            id="entry-filters-save"
            disabled={locked ? feeDraft === feeUsd : !dirty}
            className="rounded-md bg-foreground px-2.5 py-1 font-mono text-xs text-background disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() =>
              onChange({
                filters: locked ? value : normalizeEntryFilters(draft),
                roundTripFeeUsd: normalizeRoundTripFee(feeDraft),
                ...(locked ? {} : { flipLockBars: normalizeFlipLockBars(flipDraft) }),
              })
            }
          >
            Save
          </button>
        </div>
      </div>
      <div className={`grid grid-cols-2 gap-2 ${locked ? "sm:grid-cols-5" : "sm:grid-cols-3 xl:grid-cols-6"}`}>
        {FIELDS.map((field) => (
          <label
            key={field.key}
            className="flex flex-col gap-1 rounded-md bg-black/20 px-2 py-1.5 ring-1 ring-foreground/10"
            title={field.help}
          >
            <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
              {field.label}
            </span>
            <input
              id={`entry-filter-${field.key}`}
              type="number"
              inputMode="decimal"
              step={field.step}
              min={field.min}
              max={field.max}
              value={draft[field.key]}
              disabled={locked}
              onChange={(event) => {
                const raw = event.target.valueAsNumber;
                if (!Number.isFinite(raw)) return;
                setDraft((current) => ({ ...current, [field.key]: raw }));
              }}
              className="w-full bg-transparent font-mono text-sm outline-none"
            />
            <span className="text-[10px] text-muted-foreground">{field.help}</span>
          </label>
        ))}
        <label
          className="flex flex-col gap-1 rounded-md bg-black/20 px-2 py-1.5 ring-1 ring-foreground/10"
          title="每單完整來回手續費（USD）"
        >
          <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
            Round-trip fee ($)
          </span>
          <input
            id="entry-filter-roundTripFeeUsd"
            type="number"
            inputMode="decimal"
            step={0.1}
            min={0}
            value={feeDraft}
            onChange={(event) => {
              const raw = event.target.valueAsNumber;
              if (!Number.isFinite(raw)) return;
              setFeeDraft(Math.max(0, raw));
            }}
            className="w-full bg-transparent font-mono text-sm outline-none"
          />
          <span className="text-[10px] text-muted-foreground">每單來回扣費</span>
        </label>
        {locked ? null : (
          <label
            className="flex flex-col gap-1 rounded-md bg-black/20 px-2 py-1.5 ring-1 ring-foreground/10"
            title="止蝕平倉後，之後 N 根 1 分鐘 bar 唔開對面新倉。0 = 關閉。同一邊仍然可以開。"
          >
            <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
              Flip lock bars
            </span>
            <input
              id="entry-filter-flipLockBars"
              type="number"
              inputMode="numeric"
              step={1}
              min={0}
              max={5000}
              value={flipDraft}
              onChange={(event) => {
                const raw = event.target.valueAsNumber;
                if (!Number.isFinite(raw)) return;
                setFlipDraft(Math.max(0, raw));
              }}
              className="w-full bg-transparent font-mono text-sm outline-none"
            />
            <span className="text-[10px] text-muted-foreground">止蝕後鎖對面 · 0 = 關</span>
          </label>
        )}
      </div>
    </section>
  );
}
