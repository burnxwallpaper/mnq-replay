"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { FixtureBar } from "@/lib/fixture-bars";
import {
  DEFAULT_STRATEGY_SCRIPT,
  STRATEGY_STORAGE_KEY,
  isStaleDefaultScript,
  runStrategyScript,
  type ScriptRun,
} from "@/lib/strategy-script";

type DefaultScriptFn = () => string;

type StrategyApi = {
  getScript: () => string;
  setScript: (script: string) => void;
  resetScript: () => void;
  storageKey: string;
};

declare global {
  interface Window {
    mnqStrategy?: StrategyApi;
  }
}

function readStoredScript(): string | null {
  try {
    return window.localStorage.getItem(STRATEGY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredScript(script: string) {
  try {
    window.localStorage.setItem(STRATEGY_STORAGE_KEY, script);
  } catch {
    // Private mode can reject storage. The editor still runs in memory.
  }
}

function scriptFromHash(): string | null {
  const hash = window.location.hash;
  const prefix = "#script=";
  if (!hash.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(hash.slice(prefix.length));
  } catch {
    return null;
  }
}

export function StrategyEditor({
  bars,
  onApply,
  defaultScript,
  filtersKey,
  presetId = "day",
  presetEpoch = 0,
}: {
  bars: FixtureBar[];
  /** Fires with the editor source whenever Apply / auto-load runs the long slot. */
  onApply: (source: string, run: ScriptRun) => void;
  /** Current default long script (daytime filters, or the Eve long leg). */
  defaultScript?: DefaultScriptFn;
  /** When this string changes, re-apply the default long script from filters. */
  filtersKey?: string;
  /** Daytime persists edits. Eve reloads its long leg and leaves the daytime script in storage. */
  presetId?: "day" | "eve";
  /** Bumps when the user reloads the active preset. */
  presetEpoch?: number;
}) {
  const resolveDefault = defaultScript ?? (() => DEFAULT_STRATEGY_SCRIPT);
  const [script, setScript] = useState(() => resolveDefault());
  const [status, setStatus] = useState("Loading saved script…");
  const gutterRef = useRef<HTMLPreElement>(null);
  const onApplyRef = useRef(onApply);
  const scriptRef = useRef(script);
  const skipPersistRef = useRef(true);
  const persistRef = useRef(presetId !== "eve");
  const [appliedSource, setAppliedSource] = useState<string | null>(null);
  onApplyRef.current = onApply;
  scriptRef.current = script;

  function publish(source: string) {
    const run = runStrategyScript(bars, source, "long");
    setAppliedSource(source);
    if (run.ok) {
      const closed = run.trades.filter((trade) => trade.exitIndex !== null).length;
      const trades = run.trades.length === 1 ? "1 trade" : `${run.trades.length} trades`;
      setStatus(
        `Long strategy applied. ${trades}, ${closed} closed. Chart uses the strategies checked above.`,
      );
    } else {
      setStatus(run.error);
    }
    onApplyRef.current(source, run);
  }

  useEffect(() => {
    const apply = (next: string) => {
      scriptRef.current = next;
      setScript(next);
      publish(next);
    };

    const api: StrategyApi = {
      getScript: () => scriptRef.current,
      setScript: (next) => apply(next),
      resetScript: () => apply(resolveDefault()),
      storageKey: STRATEGY_STORAGE_KEY,
    };
    window.mnqStrategy = api;

    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      if (!("type" in data) || data.type !== "mnq-set-script") return;
      if (!("script" in data) || typeof data.script !== "string") return;
      apply(data.script);
    }

    function onCustom(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      if (typeof event.detail !== "string") return;
      apply(event.detail);
    }

    window.addEventListener("message", onMessage);
    window.addEventListener("mnq-set-script", onCustom);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("mnq-set-script", onCustom);
      delete window.mnqStrategy;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, presetId, presetEpoch]);

  useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    if (!persistRef.current) return;
    writeStoredScript(script);
  }, [script]);

  // Entry-filter knobs regenerate the daytime long sample. Eve ignores this.
  useEffect(() => {
    if (filtersKey == null) return;
    if (presetId === "eve") return;
    persistRef.current = true;
    const next = resolveDefault();
    scriptRef.current = next;
    setScript(next);
    publish(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, presetId]);

  useEffect(() => {
    const eve = presetId === "eve";
    persistRef.current = !eve;
    if (eve) {
      const next = resolveDefault();
      scriptRef.current = next;
      setScript(next);
      publish(next);
      return;
    }
    const hashed = scriptFromHash();
    const stored = readStoredScript();
    const saved = stored !== null && isStaleDefaultScript(stored) ? null : stored;
    const next = hashed ?? saved ?? resolveDefault();
    if (hashed) {
      writeStoredScript(hashed);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    scriptRef.current = next;
    setScript(next);
    publish(next);
    // Re-run when bars arrive or the user switches/reloads a preset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, presetId, presetEpoch]);

  const lineCount = Math.max(1, script.split("\n").length);
  const gutter = Array.from({ length: lineCount }, (_, line) => String(line + 1)).join("\n");

  return (
    <section
      aria-label="Strategy script editor"
      className="rounded-xl bg-card p-3 ring-1 ring-foreground/10"
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-mono text-sm font-medium">
            {presetId === "eve" ? "Eve long script" : "Long strategy script"}
          </h2>
          <p className="max-w-3xl text-xs text-muted-foreground">
            {presetId === "eve"
              ? "Long leg of the Eve preset. Short uses the matching Eve script while this preset is selected. Apply updates the Long leg only. Reload the preset to restore both. Eve is not written over the saved Daytime script in "
              : "Daytime default is stacked-EMA hybrid (matches Paper). Edits only the Long leg; Short uses the matching hybrid short sample. With both checked they share one position and one flip lock (Entry filters; default 0). Edits stay in localStorage under "}
            {STRATEGY_STORAGE_KEY}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => publish(scriptRef.current)}>
            Apply long strategy
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const next = resolveDefault();
              scriptRef.current = next;
              setScript(next);
              publish(next);
            }}
          >
            {presetId === "eve" ? "Reset eve long" : "Reset long sample"}
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] overflow-hidden rounded-md bg-black/50 ring-1 ring-foreground/10">
        <pre
          ref={gutterRef}
          aria-hidden="true"
          className="overflow-hidden px-1 py-2 text-right font-mono text-xs leading-5 text-muted-foreground"
        >
          {gutter}
        </pre>
        <textarea
          id="strategy-script"
          aria-label="Long strategy script"
          spellCheck={false}
          value={script}
          onChange={(event) => setScript(event.target.value)}
          onScroll={(event) => {
            if (gutterRef.current) {
              gutterRef.current.scrollTop = event.currentTarget.scrollTop;
            }
          }}
          className="max-h-72 min-h-48 w-full resize-y bg-transparent px-2 py-2 font-mono text-xs leading-5 text-foreground outline-none"
        />
      </div>
      <p
        id="strategy-script-status"
        role="status"
        className="mt-2 font-mono text-xs text-muted-foreground"
      >
        {appliedSource !== null && script !== appliedSource
          ? "Draft changed. Apply long strategy to refresh the backtest."
          : status}
      </p>
    </section>
  );
}
