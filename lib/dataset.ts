import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DatasetReport } from "./types";

const SQLITE_HEADER = "SQLite format 3\u0000";
const REQUIRED_COLUMNS = ["symbol", "ts", "o", "h", "l", "c", "v"] as const;

type ResolvedPath =
  | { ok: true; relative: string; absolute: string }
  | { ok: false; message: string };

export function resolveDatabasePath(
  raw: string | undefined = process.env.DATABASE_PATH,
): ResolvedPath {
  const relative = raw?.trim() || "data/bars.sqlite";
  if (relative.includes("\0")) {
    return { ok: false, message: "DATABASE_PATH is invalid." };
  }
  if (path.isAbsolute(relative)) {
    return {
      ok: false,
      message: "DATABASE_PATH must be a relative path inside this project.",
    };
  }

  const normalized = path.normalize(relative);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return {
      ok: false,
      message: "DATABASE_PATH must stay inside this project.",
    };
  }

  const root = path.resolve(process.cwd());
  const absolute = path.resolve(root, normalized);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    return {
      ok: false,
      message: "DATABASE_PATH must stay inside this project.",
    };
  }

  return { ok: true, relative: normalized.split(path.sep).join("/"), absolute };
}

function report(
  partial: Pick<DatasetReport, "status" | "databasePath" | "barCount" | "message">,
): DatasetReport {
  return {
    symbol: "MNQ",
    timeframe: "1m",
    ...partial,
  };
}

function readHeader(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(16);
    const bytes = fs.readSync(fd, buf, 0, 16, 0);
    if (bytes < 16) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

async function loadDatabaseSync(): Promise<typeof DatabaseSync | null> {
  try {
    const mod = await import("node:sqlite");
    return mod.DatabaseSync;
  } catch {
    return null;
  }
}

export async function readDataset(): Promise<DatasetReport> {
  const resolved = resolveDatabasePath();
  if (!resolved.ok) {
    return report({
      status: "error",
      databasePath: "data/bars.sqlite",
      barCount: null,
      message: resolved.message,
    });
  }

  const { relative, absolute } = resolved;
  if (!fs.existsSync(absolute)) {
    return report({
      status: "empty",
      databasePath: relative,
      barCount: null,
      message:
        "No SQLite bar store yet. Apply db/schema.sql with npm run db:init, then load 1-minute bars when a data source is chosen.",
    });
  }

  const stat = fs.statSync(absolute);
  if (!stat.isFile()) {
    return report({
      status: "error",
      databasePath: relative,
      barCount: null,
      message: "DATABASE_PATH points at a directory, not a SQLite file.",
    });
  }

  if (readHeader(absolute) !== SQLITE_HEADER) {
    return report({
      status: "error",
      databasePath: relative,
      barCount: null,
      message: "The bar store file is not a SQLite database.",
    });
  }

  const DatabaseSync = await loadDatabaseSync();
  if (!DatabaseSync) {
    return report({
      status: "error",
      databasePath: relative,
      barCount: null,
      message:
        "SQLite is unavailable in this Node process. The npm scripts set NODE_OPTIONS=--experimental-sqlite.",
    });
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(absolute, { readOnly: true });
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bars'",
      )
      .get();
    if (!table) {
      return report({
        status: "error",
        databasePath: relative,
        barCount: null,
        message: "SQLite file has no bars table. Apply db/schema.sql.",
      });
    }

    const columns = db
      .prepare("SELECT name FROM pragma_table_info('bars')")
      .all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    const missing = REQUIRED_COLUMNS.filter((column) => !names.has(column));
    if (missing.length > 0) {
      return report({
        status: "error",
        databasePath: relative,
        barCount: null,
        message: `bars table is missing columns: ${missing.join(", ")}.`,
      });
    }

    const row = db
      .prepare("SELECT COUNT(*) AS n FROM bars WHERE symbol = ?")
      .get("MNQ") as { n: number };
    const barCount = Number(row.n);
    return report({
      status: "ready",
      databasePath: relative,
      barCount,
      message:
        barCount === 0
          ? "Bar store is initialized and has no MNQ rows. Ingest is not wired up yet."
          : `Bar store has ${barCount} MNQ rows. Candle drawing and playback are not built yet.`,
    });
  } catch {
    return report({
      status: "error",
      databasePath: relative,
      barCount: null,
      message: "The bar store could not be read.",
    });
  } finally {
    db?.close();
  }
}
