/**
 * Download CME_MINI:MNQ1! 1-minute bars from TradingView Premium (prodata).
 *
 * Requires process.env.TRADINGVIEW_SESSION (sessionid cookie only).
 * Writes public/mnq-1m.json. Does not print the cookie or auth token.
 *
 *   TRADINGVIEW_SESSION=... node scripts/fetch-mnq-history.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";

const SYMBOL = "CME_MINI:MNQ1!";
const DAYS = 32;
const OUT = resolve("public/mnq-1m.json");

const session = process.env.TRADINGVIEW_SESSION ?? "";
if (!session) {
  console.error(
    "TRADINGVIEW_SESSION is not set. Export the TradingView sessionid cookie and rerun.",
  );
  process.exit(1);
}

function frame(payload) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `~m~${body.length}~m~${body}`;
}

function parseFrames(raw) {
  const frames = [];
  let index = 0;
  while (raw.startsWith("~m~", index)) {
    const lengthStart = index + 3;
    const lengthEnd = raw.indexOf("~m~", lengthStart);
    if (lengthEnd < 0) break;
    const length = Number(raw.slice(lengthStart, lengthEnd));
    const payloadStart = lengthEnd + 3;
    frames.push(raw.slice(payloadStart, payloadStart + length));
    index = payloadStart + length;
  }
  return frames;
}

function randomId(prefix) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let value = prefix;
  for (let i = 0; i < 12; i += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

async function authToken() {
  const response = await fetch("https://www.tradingview.com/chart/", {
    headers: {
      Cookie: `sessionid=${session}`,
      "User-Agent": "Mozilla/5.0",
    },
    redirect: "follow",
  });
  const html = await response.text();
  const match = html.match(/"auth_token"\s*:\s*"([^"]+)"/);
  if (!response.ok || !match || match[1] === "unauthorized_user_token") {
    throw new Error(
      `TradingView did not return a Premium auth token (HTTP ${response.status}).`,
    );
  }
  return match[1];
}

function readBars(message, into) {
  if (!message || message.m !== "du" || !Array.isArray(message.p)) return 0;
  let added = 0;
  for (const part of message.p) {
    if (typeof part !== "object" || part === null) continue;
    for (const series of Object.values(part)) {
      if (typeof series !== "object" || series === null || !("s" in series)) continue;
      const rows = series.s;
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (typeof row !== "object" || row === null || !("v" in row)) continue;
        const values = row.v;
        if (!Array.isArray(values) || values.length < 5) continue;
        const time = values[0];
        const open = values[1];
        const high = values[2];
        const low = values[3];
        const close = values[4];
        const volume = values.length > 5 ? values[5] : 0;
        if (
          typeof time !== "number" ||
          typeof open !== "number" ||
          typeof high !== "number" ||
          typeof low !== "number" ||
          typeof close !== "number"
        ) {
          continue;
        }
        into.set(time, {
          ts: time * 1000,
          o: open,
          h: high,
          l: low,
          c: close,
          v: typeof volume === "number" ? volume : 0,
        });
        added += 1;
      }
    }
  }
  return added;
}

async function download(token) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - DAYS * 24 * 60 * 60;
  const chart = randomId("cs_");
  const bars = new Map();
  const ws = new WebSocket(
    "wss://prodata.tradingview.com/socket.io/websocket?type=chart",
    {
      headers: {
        Origin: "https://www.tradingview.com",
        Cookie: `sessionid=${session}`,
      },
    },
  );

  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener("open", () => resolveOpen());
    ws.addEventListener("error", () => rejectOpen(new Error("prodata websocket failed")));
  });

  const send = (method, params) => {
    ws.send(frame({ m: method, p: params }));
  };

  send("set_auth_token", [token]);
  send("chart_create_session", [chart, ""]);
  send("resolve_symbol", [
    chart,
    "sds_sym_1",
    `=${JSON.stringify({
      symbol: SYMBOL,
      adjustment: "splits",
      session: "regular",
    })}`,
  ]);
  send("create_series", [
    chart,
    "sds_1",
    "s1",
    "sds_sym_1",
    "1",
    0,
    `r,${start}:${end}`,
  ]);

  let completed = 0;
  let staleRounds = 0;
  await new Promise((resolveDone, rejectDone) => {
    const timer = setTimeout(() => {
      rejectDone(new Error("Timed out waiting for MNQ history"));
    }, 120000);

    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      for (const payload of parseFrames(raw)) {
        if (payload.startsWith("~h~")) {
          ws.send(frame(payload));
          continue;
        }
        let message;
        try {
          message = JSON.parse(payload);
        } catch {
          continue;
        }
        if (message.m === "symbol_error" || message.m === "series_error") {
          clearTimeout(timer);
          rejectDone(new Error(`${message.m}: ${JSON.stringify(message.p)}`));
          return;
        }
        const before = bars.size;
        readBars(message, bars);
        if (message.m !== "series_completed") continue;
        completed += 1;
        const earliest = bars.size === 0 ? end : Math.min(...bars.keys());
        if (earliest <= start || completed >= 12) {
          clearTimeout(timer);
          resolveDone();
          return;
        }
        if (bars.size === before) staleRounds += 1;
        else staleRounds = 0;
        if (staleRounds >= 2) {
          clearTimeout(timer);
          resolveDone();
          return;
        }
        send("request_more_data", [chart, "sds_1", 8000]);
      }
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      if (bars.size === 0) rejectDone(new Error("prodata closed before any bars"));
      else resolveDone();
    });
  });

  ws.close();
  return [...bars.values()]
    .filter((bar) => bar.ts >= start * 1000)
    .sort((left, right) => left.ts - right.ts);
}

const token = await authToken();
const bars = await download(token);
if (bars.length < 1000) {
  console.error(`Only ${bars.length} bars returned; expected weeks of 1-minute MNQ.`);
  process.exit(1);
}

const first = new Date(bars[0].ts).toISOString();
const last = new Date(bars[bars.length - 1].ts).toISOString();
writeFileSync(
  OUT,
  JSON.stringify({
    symbol: SYMBOL,
    interval: "1",
    source: "TradingView Premium",
    session: "regular",
    fetchedAt: new Date().toISOString(),
    bars,
  }),
);
console.log(`Wrote ${bars.length} bars ${first} → ${last} to ${OUT}`);
