"use client";

import type { EntryFilters } from "@/lib/strategy-script";
import { DEFAULT_ENTRY_FILTERS } from "@/lib/strategy-script";

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
    help: "實體佔波幅比例（原 0.55）",
    step: 0.05,
    min: 0.05,
    max: 1,
  },
  {
    key: "minBody",
    label: "Min body pts",
    help: "最少實體點數（原 4）",
    step: 0.25,
    min: 0.25,
    max: 200,
  },
  {
    key: "volLen",
    label: "Vol SMA",
    help: "成交量均線長度（原 20）",
    step: 1,
    min: 2,
    max: 200,
  },
  {
    key: "volMult",
    label: "Vol ×",
    help: "放量倍數（原 1.8）",
    step: 0.1,
    min: 0.1,
    max: 20,
  },
];

export function EntryFiltersPanel({
  value,
  onChange,
  onReset,
}: {
  value: EntryFilters;
  onChange: (next: EntryFilters) => void;
  onReset: () => void;
}) {
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
            改完即套用到 Long／Short 預設腳本（session + 5 EMA 不變）· body ≥ ratio · body pts ·
            vol &gt; SMA × mult
          </p>
        </div>
        <button
          type="button"
          className="font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={onReset}
        >
          Reset {DEFAULT_ENTRY_FILTERS.bodyRatio} / {DEFAULT_ENTRY_FILTERS.minBody} /{" "}
          {DEFAULT_ENTRY_FILTERS.volLen}×{DEFAULT_ENTRY_FILTERS.volMult}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
              value={value[field.key]}
              onChange={(event) => {
                const raw = event.target.valueAsNumber;
                if (!Number.isFinite(raw)) return;
                onChange({ ...value, [field.key]: raw });
              }}
              className="w-full bg-transparent font-mono text-sm outline-none"
            />
            <span className="text-[10px] text-muted-foreground">{field.help}</span>
          </label>
        ))}
      </div>
    </section>
  );
}
