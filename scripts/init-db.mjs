import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const relative = process.env.DATABASE_PATH?.trim() || "data/bars.sqlite";

if (relative.includes("\0") || path.isAbsolute(relative)) {
  console.error("DATABASE_PATH must be a relative path inside this project.");
  process.exit(1);
}

const normalized = path.normalize(relative);
if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
  console.error("DATABASE_PATH must stay inside this project.");
  process.exit(1);
}

const root = path.resolve(process.cwd());
const absolute = path.resolve(root, normalized);
if (absolute !== root && !absolute.startsWith(root + path.sep)) {
  console.error("DATABASE_PATH must stay inside this project.");
  process.exit(1);
}

const schemaPath = path.join(root, "db", "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");
fs.mkdirSync(path.dirname(absolute), { recursive: true });

const db = new DatabaseSync(absolute);
db.exec(schema);
db.exec("PRAGMA journal_mode = WAL");
db.close();

const shown = normalized.split(path.sep).join("/");
console.log(`Initialized empty bar store at ${shown}`);
