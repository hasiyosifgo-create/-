import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { BotEngine } from './backend/BotEngine.js';

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
  bot.addLog('BOTが市場データを分析中...');
  let traded = false;
  for (const symbol of SYMBOLS) {
    const result = await bot.checkAndTrade(symbol);
    if (result && result.action !== 'HOLD') {
      bot.addLog(`${symbol}: ${result.action} シグナル検知 (価格: $${result.currentPrice.toFixed(2)})`);
      traded = true;
    }
  }
  if (!traded) {
    bot.addLog('新たな取引シグナルはありませんでした。');
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
  if (isRunning) {
    clearInterval(botInterval);
    isRunning = false;
    bot.addLog('BOTを停止しました。');
  } else {
    isRunning = true;
    bot.addLog('BOTを起動しました。初期分析を開始します...');
    runBotCycle(); // 初回実行
    // 定期実行 (15秒毎)
    botInterval = setInterval(() => {
      runBotCycle();
    }, 15000);
  }
  res.json({ isRunning });
});

// Serve frontend build in production
app.use(express.static(path.join(__dirname, 'dist')));
// Express 5対応: '*' ではなく全てにマッチするミドルウェアとして使用
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  bot.addLog('サーバーが起動しました。待機中...');
});
