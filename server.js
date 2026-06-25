import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { BotEngine } from './backend/BotEngine.js';
import { connectDB } from './backend/db.js';
import { JAPAN_PRIME_SYMBOLS, JAPAN_PRIME_SYMBOLS_MAP } from './backend/symbols.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const bot = new BotEngine(500000);
// 初期状態を「稼働中」に変更（スリープから復帰しても自動で再開する）
let isRunning = true;
let botInterval = null;

let scanIndex = 0;
const BATCH_SIZE = 10; // 1回あたりのスキャン数を増やす

const runBotCycle = async () => {
  const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Tokyo"}));
  const hours = now.getHours();

  // 15:00以降（15時〜23時）なら学習レポート作成（日次レビュー）を実行
  if (hours >= 15) {
    await bot.performDailyReview();
  }

  if (!bot.isMarketOpen()) {
    // 履歴が空になってしまった場合は、早期リターンの前に1件だけ強制的に記録する
    if (bot.assetHistory.length === 0) {
      await bot.recordAssetSnapshot();
    }

    // 市場が閉まっている時間は数時間に1回ログを出す程度にしてスキップする
    if (Math.random() < 0.05) {
      await bot.addLog('🌙 現在は日本市場の営業時間外（夜間・休日または昼休み）です。待機中...');
    }
    return;
  }

  await bot.checkMacroEnvironment();

  const symbolsToCheck = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    symbolsToCheck.push(JAPAN_PRIME_SYMBOLS[scanIndex]);
    scanIndex++;
    if (scanIndex >= JAPAN_PRIME_SYMBOLS.length) {
      scanIndex = 0; 
    }
  }

  await bot.addLog(`🔍 スキャン中... (${symbolsToCheck.join(', ')})`);
  let traded = false;
  
  const buyIntents = [];

  for (const symbol of symbolsToCheck) {
    try {
      const result = await bot.checkAndTrade(symbol);
      if (result) {
        if (result.action === 'INTENT_TO_BUY') {
          buyIntents.push(result);
        } else if (result.action !== 'HOLD') {
          // 売却成立の場合のログ
          const companyName = JAPAN_PRIME_SYMBOLS_MAP[symbol]?.name || symbol;
          await bot.addLog(`[${companyName}] ${result.action.replace('_', ' ')} 成立! (価格: ¥${result.currentPrice.toLocaleString()})`);
          traded = true;
        }
      }
    } catch (e) {
      console.error(`Error checking ${symbol}:`, e);
    }
  }

  // ここから「品評会（ランキング＆優先購入）」システム
  if (buyIntents.length > 0) {
    // ボラティリティ（値幅）が大きい順にソート（最も利益が狙える銘柄を1位にする）
    buyIntents.sort((a, b) => b.volatility - a.volatility);

    for (const intent of buyIntents) {
      const companyName = JAPAN_PRIME_SYMBOLS_MAP[intent.symbol]?.name || intent.symbol;

      // 足切りルール（直近の値幅が1%未満の鈍足銘柄は、利益が薄いため買わない）
      if (intent.volatility < 0.01) {
        await bot.addLog(`⏭️ [${companyName}] 買い条件を満たしましたが、値動きが弱すぎる(${(intent.volatility * 100).toFixed(2)}%)ため見送りました。`);
        continue;
      }

      // 1位の銘柄を購入実行
      const success = await bot.buy(intent.symbol, intent.sharesToBuy, intent.currentPrice, intent.currentState);
      if (success) {
        await bot.addLog(`⭐ [${companyName}] 優先購入実行! (ボラティリティ: ${(intent.volatility * 100).toFixed(2)}%, 価格: ¥${intent.currentPrice.toLocaleString()})`);
        traded = true;
        break; // 1サイクルにつき一番期待値の高い1銘柄だけ買って終了する
      } else {
        // 資金不足等で買えなかった場合（通常はここでbreakするがログだけ残す）
        await bot.addLog(`⚠️ [${companyName}] 資金不足で優先購入をスキップしました。`);
      }
    }
  }
  
  // 1サイクル終わるごとに資産スナップショットを記録（内部で10分おきに間引かれる）
  if (bot.isMarketOpen()) {
    await bot.recordAssetSnapshot();
  }
};

app.get('/api/status', async (req, res) => {
  const totalAssets = await bot.getTotalAssets();
  res.json({
    isRunning,
    balance: bot.balance,
    initialBalance: bot.initialBalance,
    totalAssets,
    portfolio: bot.portfolio,
    history: bot.history,
    logs: bot.logs,
    assetHistory: bot.assetHistory,
    scanProgress: `${scanIndex} / ${JAPAN_PRIME_SYMBOLS.length}`,
    dbError: bot.dbError,
    learningReport: bot.learningReport,
    symbolsMap: JAPAN_PRIME_SYMBOLS_MAP
  });
});

app.post('/api/toggle', async (req, res) => {
  if (isRunning) {
    clearInterval(botInterval);
    isRunning = false;
    await bot.addLog('BOTを停止しました。');
  } else {
    isRunning = true;
    await bot.addLog('BOTを起動しました。デイトレスキャンを開始します...');
    runBotCycle(); 
    botInterval = setInterval(runBotCycle, 10000); // 10秒間隔に短縮
  }
  res.json({ isRunning });
});

app.use(express.static(path.join(__dirname, 'dist')));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  await connectDB();
  await bot.initialize();
  await bot.addLog('サーバーが起動しました。自動取引ループを開始します。');
  
  // 自動起動
  runBotCycle();
  botInterval = setInterval(runBotCycle, 10000); // 10秒間隔に短縮

  // Renderのスリープ防止用（10分ごとに自分自身にアクセスする）
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    console.log(`Self-pinging ${url} to prevent sleep...`);
    fetch(url).catch(() => {});
  }, 10 * 60 * 1000);
});
