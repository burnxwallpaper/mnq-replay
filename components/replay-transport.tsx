import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export function ReplayTransport({
  playing,
  index,
  count,
  cursorLabel,
  onToggle,
  onScrub,
  onStep,
  onJump,
}: {
  playing: boolean;
  index: number;
  count: number;
  cursorLabel: string;
  onToggle: () => void;
  onScrub: (index: number) => void;
  onStep: (delta: number) => void;
  onJump: (index: number) => void;
}) {
  const atStart = index <= 0;
  const atEnd = index >= count - 1;

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card px-3 py-3 ring-1 ring-foreground/10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="flex items-center gap-1"
          role="toolbar"
          aria-label="Replay transport"
        >
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Jump to start"
            disabled={atStart}
            onClick={() => onJump(0)}
          >
            <SkipBack />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Step back one bar"
            disabled={atStart}
            onClick={() => onStep(-1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            variant="default"
            size="icon"
            aria-label={playing ? "Pause" : "Play"}
            aria-pressed={playing}
            onClick={onToggle}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Step forward one bar"
            disabled={atEnd}
            onClick={() => onStep(1)}
          >
            <ChevronRight />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Jump to end"
            disabled={atEnd}
            onClick={() => onJump(count - 1)}
          >
            <SkipForward />
          </Button>
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          Bar {index + 1} / {count}
          <span className="mx-2 text-foreground/30">·</span>
          {cursorLabel}
        </p>
      </div>
      <input
        type="range"
        min={0}
        max={count - 1}
        value={index}
        aria-label="Scrub replay"
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={index}
        aria-valuetext={cursorLabel}
        onChange={(event) => onScrub(Number(event.target.value))}
        className="h-2 w-full cursor-pointer accent-[oklch(0.84_0.14_88)]"
      />
    </div>
  );
}
