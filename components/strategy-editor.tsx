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
  onRun,
}: {
  bars: FixtureBar[];
  onRun: (run: ScriptRun) => void;
}) {
  const [script, setScript] = useState(DEFAULT_STRATEGY_SCRIPT);
  const [status, setStatus] = useState("Loading saved script…");
  const gutterRef = useRef<HTMLPreElement>(null);
  const onRunRef = useRef(onRun);
  const scriptRef = useRef(script);
  const skipPersistRef = useRef(true);
  const [appliedSource, setAppliedSource] = useState<string | null>(null);
  onRunRef.current = onRun;
  scriptRef.current = script;

  function publish(source: string) {
    const run = runStrategyScript(bars, source);
    setAppliedSource(source);
    if (run.ok) {
      const closed = run.trades.filter((trade) => trade.exitIndex !== null).length;
      const trades = run.trades.length === 1 ? "1 trade" : `${run.trades.length} trades`;
      setStatus(
        `Full period applied. ${trades}, ${closed} closed. Entries and exits are on the chart.`,
      );
    } else {
      setStatus(run.error);
    }
    onRunRef.current(run);
  }

  useEffect(() => {
    const apply = (next: string) => {
      scriptRef.current = next;
      setScript(next);
      const run = runStrategyScript(bars, next);
      setAppliedSource(next);
      if (run.ok) {
        const closed = run.trades.filter((trade) => trade.exitIndex !== null).length;
        const trades = run.trades.length === 1 ? "1 trade" : `${run.trades.length} trades`;
        setStatus(
          `Full period applied. ${trades}, ${closed} closed. Entries and exits are on the chart.`,
        );
      } else {
        setStatus(run.error);
      }
      onRunRef.current(run);
    };

    const api: StrategyApi = {
      getScript: () => scriptRef.current,
      setScript: (next) => apply(next),
      resetScript: () => apply(DEFAULT_STRATEGY_SCRIPT),
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
  }, [bars]);

  useEffect(() => {
    const hashed = scriptFromHash();
    const stored = readStoredScript();
    const saved = stored !== null && isStaleDefaultScript(stored) ? null : stored;
    const next = hashed ?? saved ?? DEFAULT_STRATEGY_SCRIPT;
    if (hashed) {
      writeStoredScript(hashed);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    scriptRef.current = next;
    setScript(next);
    publish(next);
    // Re-run when bars first arrive / change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars]);

  useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    writeStoredScript(script);
  }, [script]);

  const lineCount = Math.max(1, script.split("\n").length);
  const gutter = Array.from({ length: lineCount }, (_, line) => String(line + 1)).join("\n");

  return (
    <section
      aria-label="Strategy script editor"
      className="rounded-xl bg-card p-3 ring-1 ring-foreground/10"
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-mono text-sm font-medium">Strategy script</h2>
          <p className="max-w-3xl text-xs text-muted-foreground">
            Pine-style bar script. Edits stay in localStorage under {STRATEGY_STORAGE_KEY}.
            A bot can change the open page with mnqStrategy.setScript(code) and it reruns
            without a redeploy.
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={() => publish(scriptRef.current)}>
            Apply strategy
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              scriptRef.current = DEFAULT_STRATEGY_SCRIPT;
              setScript(DEFAULT_STRATEGY_SCRIPT);
              publish(DEFAULT_STRATEGY_SCRIPT);
            }}
          >
            Reset
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
          aria-label="Strategy script"
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
          ? "Draft changed. Apply strategy to refresh the full-period backtest."
          : status}
      </p>
    </section>
  );
}
