import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { BotEngine } from './backend/BotEngine.js';
import { connectDB } from './backend/db.js';
import { JAPAN_PRIME_SYMBOLS } from './backend/symbols.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const bot = new BotEngine(500000);
let isRunning = false;
let botInterval = null;

// バッチスキャン用のカーソル
let scanIndex = 0;
const BATCH_SIZE = 5; // 1回にチェックする銘柄数（API制限対策）

const runBotCycle = async () => {
  // 米国市場のチェック（マクロ環境の監視）
  await bot.checkMacroEnvironment();

  // 日本株のバッチスキャン
  const symbolsToCheck = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    symbolsToCheck.push(JAPAN_PRIME_SYMBOLS[scanIndex]);
    scanIndex++;
    if (scanIndex >= JAPAN_PRIME_SYMBOLS.length) {
      scanIndex = 0; // ループして最初に戻る
    }
  }

  await bot.addLog(`🔍 スキャン中... (${symbolsToCheck.join(', ')})`);
  let traded = false;
  
  for (const symbol of symbolsToCheck) {
    try {
      const result = await bot.checkAndTrade(symbol);
      if (result && result.action !== 'HOLD') {
        await bot.addLog(`[${symbol}] ${result.action} 成立! (価格: ¥${result.currentPrice.toLocaleString()})`);
        traded = true;
      }
    } catch (e) {
      console.error(`Error checking ${symbol}:`, e);
    }
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
    scanProgress: `${scanIndex} / ${JAPAN_PRIME_SYMBOLS.length}`
  });
});

app.post('/api/toggle', async (req, res) => {
  if (!bot.isReady) {
    return res.status(500).json({ error: "DB not ready" });
  }
  if (isRunning) {
    clearInterval(botInterval);
    isRunning = false;
    await bot.addLog('BOTを停止しました。');
  } else {
    isRunning = true;
    await bot.addLog('BOTを起動しました。デイトレスキャンを開始します...');
    runBotCycle(); // 初回実行
    botInterval = setInterval(() => {
      runBotCycle();
    }, 20000); // 20秒ごとにバッチスキャンを実行
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
  await bot.addLog('サーバーが起動しました。待機中...');
});
