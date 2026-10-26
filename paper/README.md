# Paper / 模擬倉（MNQ impulse）

用 Interactive Brokers（香港）**Paper Trading**，或本機 bar 檔，先運作一段時間驗證策略，再考慮實盤。

---

## IBKR Paper 即時循環（已實作）

`paper/ib_paper_loop.py`：長連 Gateway → 一次 warmup 歷史 1m → `keepUpToDate` 串流 → **每根完成嘅 1m bar** 先決策 →（可選）限價＋bracket。

### 點解用 keepUpToDate，唔用 reqRealTimeBars？

IB 嘅 `reqRealTimeBars` 係 **5 秒** bar；策略同 backtest 係 **1 分鐘**。  
所以用 `reqHistoricalData(..., barSizeSetting="1 min", keepUpToDate=True)`：啟動拉一次歷史做 SMA／EMA，之後只處理新完成嘅 1m bar，**唔會每分鐘重拉成段歷史**。

### Windows 啟動（Gateway Paper 已開、埠 4002）

喺跑緊 IB Gateway 嘅 Windows 機執行（呢個專案用過 **DESKTOP-HL3340K**）。Gateway 要登入 **Paper**，API socket 係 **4002**。唔好用 **4001**（Gateway live）或 **7496**（TWS live）；程式預設拒絕呢兩個埠。

Log 入面 `Managed accounts:` 必須係 Paper 戶口（呢個專案用過 **DUR299195**）。如果見到 live 戶口，停低，將 Gateway 改返登入 Paper。

```bat
cd C:\path\to\mnq-replay
copy /Y paper\config.example.json paper\config.json
py -3 -m pip install --user ib_insync tzdata
py -3 paper\ib_paper_loop.py --dry-run --host 127.0.0.1 --port 4002
py -3 paper\ib_paper_loop.py --place-orders --host 127.0.0.1 --port 4002
```

只複製咗 `paper\` 嘅話：

```bat
cd C:\Users\leosiu\mnq-paper-smoke
copy /Y config.example.json config.json
py -3 -m pip install --user ib_insync tzdata
py -3 ib_paper_loop.py --dry-run --host 127.0.0.1 --port 4002
py -3 ib_paper_loop.py --place-orders --host 127.0.0.1 --port 4002
```

**只跑數根 stream bar 就停（煙霧測試）：**

```bat
py -3 paper\ib_paper_loop.py --dry-run --host 127.0.0.1 --port 4002 --max-bars 2
```

**Flip lock（預設 15；0 = 關）。** CLI 優先於環境變數，環境變數優先於 `config.json` 嘅 `flipLockBars`：

```bat
py -3 paper\ib_paper_loop.py --dry-run --port 4002 --flip-lock-bars 15
set FLIP_LOCK_BARS=0
py -3 paper\ib_paper_loop.py --dry-run --port 4002
```

### dry-run vs place-orders

| 模式 | 指令 | 行為 |
|------|------|------|
| **Dry-run（預設）** | `py -3 paper\ib_paper_loop.py --dry-run --host 127.0.0.1 --port 4002` | 連 Paper、收 1m、用本地虛擬倉模擬限價／止蝕／止賺／flip lock；**唔下單**（readonly） |
| **Paper 下單** | `py -3 paper\ib_paper_loop.py --place-orders --host 127.0.0.1 --port 4002` | 訊號時掛 **Limit@收市價**＋TP／SL bracket；`maxContracts` 預設 **1**；**未成交入場限價喺訊號後 2 根完結 1m bar 自動撤**（`entryLimitExpiryBars`，預設 2）。只會去 Paper socket |

`config.json` 入面 `placeOrders: false` 係預設；即使改成 true，都建議第一次用 CLI `--dry-run` 確認 bar／訊號先。

### Kill switch（停手）

1. **終端** `Ctrl+C` — 斷 API、寫 `state.json`；已掛嘅 bracket **可能仲喺 Gateway**  
2. **取消未成交／子單**：Gateway／TWS → 訂單簿取消；或重開 Gateway 前先清  
3. **緊急**：喺 TWS／Gateway 將帳戶設 **Read-Only API**，或登出 Gateway  
4. **程式安全**：預設拒絕 Live 埠 **4001／7496**（除非 `allowLive: true`）

### 策略對齊（同網頁 Daytime 預設）

網頁 Preset 入面嘅 **Eve 20:30–23:59 · stop2 asym · 2.5R+EMA** 只係 replay 候選，唔會改呢度。Paper／IB 循環保持下面嘅日盤預設。

- Filters：`0.45 / 2 / 15 / 1.2`  
- Session：`America/Chicago` **09:00–20:29** 先開新倉（session close 21:00；收市前 30 分鐘唔再開新倉）；**星期五 CT 14:45 起唔再開新倉**；已開倉照常管理／平倉  
- Long 陽燭 impulse／Short 陰燭 impulse；目標 **2.5R**；收市穿 5 EMA 收窄到 **1R**（改 TP）  
- 入場：**Limit@訊號收市**；訊號後 **2 根完結 1m bar** 仍未成交 → 取消 parent（未啟動嘅 TP／SL 一齊撤）；成交後止蝕／止賺 GTC 照留  
- 會計用來回費 **$1.6**（只記帳；IB Paper 另有模擬費用）  
- 合約：**MNQ · CME** front month（唔係 GLOBEX）
- **Flip lock 15（同網頁）**：完整止蝕（stop）之後，對面新倉封鎖接下來 15 根完成嘅 1m bar（訊號 bar 喺 E+1 … E+15）；同方向仍可開；止賺唔鎖；止蝕嗰根 bar 上面嘅訊號仍可開。`0` 關閉。`side=both`（預設）先啟用，long／short 共用 `state.json` 入面同一組 `flip_locks`。單邊 `side=long` 或 `short` 唔鎖，同網頁只開一邊一樣。覆寫：`--flip-lock-bars`、環境變數 `FLIP_LOCK_BARS`、或 `config.json` 嘅 `flipLockBars`（CLI > env > config）。Warmup 會用同一套單倉規則重建鎖；Ctrl+C 之後鎖會留喺 `state.json`。


### 常見阻礙

- **Error 162 / different IP**：同一個 IB username 喺另一個 IP 開住 TWS／Gateway／手機交易 → 歷史 1m 拉唔到。登出其他 session，等約 1 分鐘再跑。
- **Windows `tzdata`**：缺 timezone 套件時裝 `tzdata`（見上面 pip）。
- **週末**：MNQ 多數週五收市到週日晚（芝加哥）先有新 1m bar；dry-run 仍可用 warmup 歷史做驗證。

### 產出（已 gitignore）

| 檔案 | 用途 |
|------|------|
| `paper/state.json` | 權益、未平倉、合約、上次 bar |
| `paper/trades.jsonl` | 平倉會計紀錄 |
| `paper/config.json` | 本地設定（由 example 複製） |

---

## 本機 forward paper（唔使 IB）

```bash
cp paper/config.example.json paper/config.json
npm run paper:local      # 全歷史 baseline
npm run paper:forward    # 數據更新後只入帳新 bar
```

---

## IB 煙霧測試（只連線）

```bash
py -3 paper/ib_paper_stub.py
```

---

## English — start IBKR Paper (not live)

Run this on the Windows PC where **IB Gateway is logged into Paper**. This project has used **DESKTOP-HL3340K**. The Paper API port is **4002**. Do not point the loop at **4001** or **7496** (live sockets). The process refuses those ports unless `allowLive` is set, and that flag is not part of this runbook.

`Managed accounts:` in the log must be a Paper account. This project has used **DUR299195**. If the line shows a live account, stop and log Gateway into Paper.

From the repo:

```bat
cd C:\path\to\mnq-replay
copy /Y paper\config.example.json paper\config.json
py -3 -m pip install --user ib_insync tzdata
py -3 paper\ib_paper_loop.py --dry-run --host 127.0.0.1 --port 4002
py -3 paper\ib_paper_loop.py --place-orders --host 127.0.0.1 --port 4002
```

| Mode | Command | What it does |
| --- | --- | --- |
| Dry-run (default) | `py -3 paper\ib_paper_loop.py --dry-run --host 127.0.0.1 --port 4002` | Paper connection, 1m bars, virtual fills, stops, targets, and flip lock. **No orders.** |
| Paper orders | `py -3 paper\ib_paper_loop.py --place-orders --host 127.0.0.1 --port 4002` | Limit at the signal close + bracket stop/target on the **Paper** account. Size `maxContracts` (default 1). Unfilled entry cancels after 2 completed 1m bars. |
| Smoke | `py -3 paper\ib_paper_loop.py --dry-run --port 4002 --max-bars 2` | Stop after two completed stream bars. |

Flip lock matches the web daytime helper (`noteStopFlipLock` / `isOppositeFlipLocked`): after a **full stop**, block a new **opposite** entry for the next **15** completed 1-minute bars. Same-side entries stay allowed. A target exit does not lock. A signal on the stop bar itself is still allowed. `0` turns the lock off. It is shared by long and short, and it is active only when `side` is `both` (the default). Override, first match wins:

```bat
py -3 paper\ib_paper_loop.py --place-orders --port 4002 --flip-lock-bars 15
set FLIP_LOCK_BARS=0
py -3 paper\ib_paper_loop.py --dry-run --port 4002
```

`config.json` key: `"flipLockBars": 15`.

Ctrl+C writes `paper/state.json` (including `flip_locks`) and disconnects. Resting brackets can remain in Gateway — cancel them there if you want them gone. A full stop on the Paper stop order arms the lock; a target fill does not. Dry-run simulates that book locally and tags closes `"simulated": true`. Delete `paper/state.json` and `paper/trades.jsonl` before the first `--place-orders` run if you do not want the dry-run equity line to carry over. Locks in that file are the ones that will still block after you switch to orders.

Connection check only (no strategy, no orders): `py -3 paper/ib_paper_stub.py --port 4002`.

Local bars, no Gateway: `npm run paper:local` and `npm run paper:forward`. Both call the web engine's linked runner, so long and short share the same lock. `FLIP_LOCK_BARS=0` or `npx tsx paper/local-runner.ts --flip-lock-bars 0` turns it off.

- **Bars:** 1m via historical `keepUpToDate` (not 5s realtime bars).
- **Preset:** the replay page can load an optional Eve candidate. This loop stays on the daytime default above.
- **Safety:** Paper only. Refuses 4001/7496. Does not send live orders.
