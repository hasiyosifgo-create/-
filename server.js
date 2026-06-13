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
// 初期状態を「稼働中」に変更（スリープから復帰しても自動で再開する）
let isRunning = true;
let botInterval = null;

let scanIndex = 0;
const BATCH_SIZE = 5; 

const runBotCycle = async () => {
  if (!bot.isMarketOpen()) {
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
    scanProgress: `${scanIndex} / ${JAPAN_PRIME_SYMBOLS.length}`,
    dbError: bot.dbError // DB接続エラーをフロントエンドに伝える
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
    botInterval = setInterval(runBotCycle, 20000);
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
  botInterval = setInterval(runBotCycle, 20000);

  // Renderのスリープ防止用（10分ごとに自分自身にアクセスする）
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    console.log(`Self-pinging ${url} to prevent sleep...`);
    fetch(url).catch(() => {});
  }, 10 * 60 * 1000);
});
