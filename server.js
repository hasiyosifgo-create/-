import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { BotEngine } from './backend/BotEngine.js';
import { connectDB } from './backend/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const bot = new BotEngine(500000);
let isRunning = false;
let botInterval = null;

const SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'NVDA'];

const runBotCycle = async () => {
  await bot.addLog('BOTが市場データを分析中...');
  let traded = false;
  for (const symbol of SYMBOLS) {
    const result = await bot.checkAndTrade(symbol);
    if (result && result.action !== 'HOLD') {
      await bot.addLog(`${symbol}: ${result.action} シグナル検知 (価格: $${result.currentPrice.toFixed(2)})`);
      traded = true;
    }
  }
  if (!traded) {
    await bot.addLog('新たな取引シグナルはありませんでした。');
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
    logs: bot.logs
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
    await bot.addLog('BOTを起動しました。初期分析を開始します...');
    runBotCycle(); // 初回実行
    botInterval = setInterval(() => {
      runBotCycle();
    }, 15000);
  }
  res.json({ isRunning });
});

app.use(express.static(path.join(__dirname, 'dist')));

// Express 5対応: '*' ではなく全てにマッチするミドルウェアとして使用
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
