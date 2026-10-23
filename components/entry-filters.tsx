"use client";

import { useEffect, useMemo, useState } from "react";

import type { EntryFilters } from "@/lib/strategy-script";
import {
  DEFAULT_ENTRY_FILTERS,
  DEFAULT_ROUND_TRIP_FEE_USD,
  normalizeEntryFilters,
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
};

export function EntryFiltersPanel({
  value,
  feeUsd,
  onChange,
}: {
  value: EntryFilters;
  feeUsd: number;
  onChange: (next: EntryFiltersSave) => void;
}) {
  const [draft, setDraft] = useState<EntryFilters>(value);
  const [feeDraft, setFeeDraft] = useState<number>(feeUsd);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    setFeeDraft(feeUsd);
  }, [feeUsd]);

  const dirty = useMemo(
    () => !filtersEqual(draft, value) || feeDraft !== feeUsd,
    [draft, value, feeDraft, feeUsd],
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
            改數字後撳 Save 先套用到 Long／Short 預設腳本同手續費（session + 5 EMA 不變）· body ≥
            ratio · body pts · vol &gt; SMA × mult · round-trip fee
            {dirty ? (
              <span className="ml-1 text-amber-300/90">· unsaved</span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              setDraft(DEFAULT_ENTRY_FILTERS);
              setFeeDraft(DEFAULT_ROUND_TRIP_FEE_USD);
            }}
          >
            Reset {DEFAULT_ENTRY_FILTERS.bodyRatio} / {DEFAULT_ENTRY_FILTERS.minBody} /{" "}
            {DEFAULT_ENTRY_FILTERS.volLen}×{DEFAULT_ENTRY_FILTERS.volMult} · fee $
            {DEFAULT_ROUND_TRIP_FEE_USD}
          </button>
          <button
            type="button"
            id="entry-filters-save"
            disabled={!dirty}
            className="rounded-md bg-foreground px-2.5 py-1 font-mono text-xs text-background disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() =>
              onChange({
                filters: normalizeEntryFilters(draft),
                roundTripFeeUsd: normalizeRoundTripFee(feeDraft),
              })
            }
          >
            Save
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
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
      </div>
    </section>
  );
}
