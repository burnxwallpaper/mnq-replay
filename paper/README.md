# Paper / 模擬倉（MNQ impulse）

用 Interactive Brokers（香港）**Paper Trading**，或本機 bar 檔，先運作一段時間驗證策略，再考慮實盤。

---

## IBKR Paper 即時循環（已實作）

`paper/ib_paper_loop.py`：長連 Gateway → 一次 warmup 歷史 1m → `keepUpToDate` 串流 → **每根完成嘅 1m bar** 先決策 →（可選）限價＋bracket。

### 點解用 keepUpToDate，唔用 reqRealTimeBars？

IB 嘅 `reqRealTimeBars` 係 **5 秒** bar；策略同 backtest 係 **1 分鐘**。  
所以用 `reqHistoricalData(..., barSizeSetting="1 min", keepUpToDate=True)`：啟動拉一次歷史做 SMA／EMA，之後只處理新完成嘅 1m bar，**唔會每分鐘重拉成段歷史**。

### Windows 啟動（Gateway Paper 已開、埠 4002）

```bat
cd C:\Users\leosiu\mnq-paper-smoke
copy /Y config.example.json config.json
py -3 -m pip install --user ib_insync tzdata
py -3 ib_paper_loop.py --dry-run
```

或喺 repo：

```bat
cd path\to\mnq-replay
copy paper\config.example.json paper\config.json
py -3 paper\ib_paper_loop.py --dry-run
```

**只跑數根 stream bar 就停（煙霧測試）：**

```bat
py -3 ib_paper_loop.py --dry-run --max-bars 2
```

### dry-run vs place-orders

| 模式 | 指令 | 行為 |
|------|------|------|
| **Dry-run（預設）** | `py -3 ib_paper_loop.py --dry-run` | 連 Paper、收 1m、印訊號／收窄；**唔下單**（readonly） |
| **Paper 下單** | `py -3 ib_paper_loop.py --place-orders` | 訊號時掛 **Limit@收市價**＋TP／SL bracket；`maxContracts` 預設 **1**；**未成交入場限價喺訊號後 2 根完結 1m bar 自動撤**（`entryLimitExpiryBars`，預設 2） |

`config.json` 入面 `placeOrders: false` 係預設；即使改成 true，都建議第一次用 CLI `--dry-run` 確認 bar／訊號先。

### Kill switch（停手）

1. **終端** `Ctrl+C` — 斷 API、寫 `state.json`；已掛嘅 bracket **可能仲喺 Gateway**  
2. **取消未成交／子單**：Gateway／TWS → 訂單簿取消；或重開 Gateway 前先清  
3. **緊急**：喺 TWS／Gateway 將帳戶設 **Read-Only API**，或登出 Gateway  
4. **程式安全**：預設拒絕 Live 埠 **4001／7496**（除非 `allowLive: true`）

### 策略對齊（同網頁 Combined 預設）

- Filters：`0.45 / 2 / 15 / 1.2`  
- Session：`America/Chicago` **09:00–20:29** 先開新倉（session close 21:00；收市前 30 分鐘唔再開新倉）；**星期五 CT 14:45 起唔再開新倉**；已開倉照常管理／平倉  
- Long 陽燭 impulse／Short 陰燭 impulse；目標 **2.5R**；收市穿 5 EMA 收窄到 **1R**（改 TP）  
- 入場：**Limit@訊號收市**；訊號後 **2 根完結 1m bar** 仍未成交 → 取消 parent（未啟動嘅 TP／SL 一齊撤）；成交後止蝕／止賺 GTC 照留  
- 會計用來回費 **$1.6**（只記帳；IB Paper 另有模擬費用）  
- 合約：**MNQ · CME** front month（唔係 GLOBEX）


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

## English (short)

- **Loop:** `py -3 paper/ib_paper_loop.py --dry-run` then `--place-orders` on Paper (port **4002**).  
- **Bars:** 1m via historical `keepUpToDate` (not 5s realtime bars).  
- **Orders:** limit at bar close + bracket stop/target; unfilled entry cancels after **2** completed 1m bars; EMA tighten modifies TP to 1R after fill.  
- **Safety:** refuses 4001/7496; Ctrl+C stops the loop — cancel resting orders in Gateway if needed.
