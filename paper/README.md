# Paper / 模擬倉 scaffold（MNQ impulse）

用 Interactive Brokers（香港）**Paper Trading**，或本機 bar 檔，先運作一段時間驗證策略，再考慮實盤。

這不是完整自動交易機器人；目標是：**本地 forward paper 今天就能跑**，IB 連線只做安全 stub／煙霧測試。

---

## 建議路徑（IBKR HK）

1. **開通 Paper Trading**  
   登入 [IBKR Account Management](https://www.interactivebrokers.com/) → **Paper Trading**（與 live 帳戶同一登入體系）。紙上帳戶有獨立帳號／資金，下單唔會動到真錢。

2. **安裝並登入 IB Gateway（建議）或 TWS**  
   - 登入時選 **Paper Trading**（唔好選 Live）。  
   - Configure → Settings → API → **Enable ActiveX and Socket Clients**。  
   - 記下 **Socket port**：**IB Gateway** Paper 多數係 **4002**（Live **4001**）；**TWS** Paper 多數係 **7497**（Live **7496**）。以設定畫面為準。  
   - Trusted IPs 加 `127.0.0.1`（本機）。

3. **市場數據**  
   Paper 可能係延遲報價（除非你有訂閱即時）。仍然可以測：**下單流程、連線、合約資格、風控**。訊號品質要以你有即時／足夠數據為準。

4. **MNQ 合約**  
   - `FUT` · symbol `MNQ` · exchange `GLOBEX` · currency `USD`  
   - 跟月（front month），到期前要 **rollover**。  
   - 本 scaffold 嘅 Python stub 會列出可用到期，方便你睇 front month。

5. **對齊 backtest 假設**（見 `config.example.json`）  
   - Session：`America/Chicago` **09:00–21:00**（唔開新倉）  
   - Filters 預設：**0.45 / 2 / 15 / 1.2**（bodyRatio · minBody · volLen · volMult）  
   - 目標 2R；收市穿 5 EMA 收窄到 1R  
   - 來回手續費預設 **$1.6**／平倉單  
   - 點值 **$2／點**，起始資金 **$10,000**  
   - 本機 fill 以 **1 張**計（同網頁 backtest）；你提到實盤大約 **最多 6 張 MNQ**——`maxContracts` 只係備註／軟上限，未做 sizing 邏輯

6. **安全**  
   - 預設只准 Paper 埠（Gateway **4002**／TWS **7497**）；會拒絕 Live 埠 **4001**／**7496**。  
   - 若 `ibPort` 係 **7496**（或 mode 似 live）而 `allowLive` 唔係 `true`，程式會 **拒絕啟動**。  
   - 未明確改 config 前，唔好指向 live。

---

## 今日就能用：本機 forward paper（唔使 IB）

策略引擎同網頁一樣（`lib/strategy-script.ts`）。你更新 `public/data/mnq-1m-bars.json` 之後跑一步，只會入帳 **新 bar 之後平倉** 的虛擬單。

```bash
cd /path/to/mnq-replay
cp paper/config.example.json paper/config.json   # 可改 filters / fee
npm run paper:local      # 全歷史 baseline（對照網頁 Combined）
npm run paper:forward    # 第一次：錨定最新 bar，唔倒灌歷史
# 之後每次刷新 bar 數據再跑：
npm run paper:forward
# 若想一次用全歷史灌入模擬倉：
npx tsx paper/forward-step.ts --bootstrap
```

產出（已 gitignore）：

| 檔案 | 用途 |
|------|------|
| `paper/state.json` | 上次處理到嘅 bar ts、權益、峰值、未平倉 |
| `paper/trades.jsonl` | 已平倉虛擬單（一行一單） |
| `paper/config.json` | 你的本地設定（由 example 複製） |

---

## IB Paper 煙霧測試（可選）

```bash
# 1. Gateway 已用 Paper 登入，API port 4002
# 2. pip install ib_insync
python paper/ib_paper_stub.py

# TypeScript stub（唔下單、唔強制裝 IB SDK）：
npx tsx paper/ib-paper-runner.ts
```

成功會印 managed accounts + MNQ front-ish contract。  
**下一步（尚未實作）**：1 分鐘 bar 循環 → 套用同款 impulse 訊號 → bracket（止損／目標）→ 記錄成交；並處理 rollover、斷線重連、每日虧損上限。

---

## English (short)

**Goal:** paper-trade the MNQ impulse strategy before live on IBKR Hong Kong.

1. Enable **Paper Trading** in IBKR Account Management; log **IB Gateway/TWS** into **Paper** (API port usually Gateway **4002** / TWS **7497** (live **4001**/**7496**) — verify in settings).
2. **Today:** `npm run paper:forward` advances a virtual book from `public/data/mnq-1m-bars.json` after each data refresh (no IB required). `npm run paper:local` is the full-history baseline matching the web Combined backtest (filters 0.45/2/15/1.2, Chicago 09–21, 2R / 1R EMA, $1.6 RT fee, $2/pt, $10k start).
3. **Optional IB smoke:** `pip install ib_insync` then `python paper/ib_paper_stub.py` (qualifies MNQ, prints account; no orders).
4. **Safety:** scaffold refuses live-looking port **7496** unless `allowLive: true`. Do not point at live until you explicitly change config.
5. **Not included yet:** live IB order loop, sizing to ~6 MNQ, rollover automation, production watchdog.

Copy `config.example.json` → `config.json` before customizing.
