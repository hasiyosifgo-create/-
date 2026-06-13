import { fetchStockData, fetchCurrentPrice, fetchNews } from './yahoo.js';
import { BotState } from './db.js';

// 感情分析用のキーワード辞書
const POSITIVE_WORDS = ['buy', 'up', 'bull', 'growth', 'profit', 'beats', 'positive', 'surge', 'record', 'gain', 'jump', 'upgrade', 'strong'];
const NEGATIVE_WORDS = ['sell', 'down', 'bear', 'loss', 'misses', 'negative', 'drop', 'plunge', 'contaminated', 'lawsuit', 'panic', 'downgrade', 'weak', 'crash', 'fall'];

export class BotEngine {
  constructor(initialBalance = 500000) {
    this.initialBalance = initialBalance;
    this.balance = initialBalance;
    this.portfolio = {};
    this.history = [];
    this.parameters = {};
    this.logs = [];
    this.dbState = null;
    this.isReady = false;
  }

  async initialize() {
    try {
      let state = await BotState.findOne({ id: 'bot_state' });
      if (!state) {
        state = new BotState({
          id: 'bot_state',
          balance: this.initialBalance,
          initialBalance: this.initialBalance,
          portfolio: {},
          history: [],
          parameters: {},
          logs: []
        });
        await state.save();
      }
      this.dbState = state;
      this.balance = state.balance;
      this.portfolio = state.portfolio || {};
      this.history = state.history || [];
      this.parameters = state.parameters || {};
      this.logs = state.logs || [];
      this.isReady = true;
      console.log('Bot data initialized from MongoDB');
    } catch (err) {
      console.error('Failed to load data from MongoDB (Running in memory mode)', err);
      this.isReady = true;
    }
  }

  async saveData() {
    if (!this.dbState) return;
    this.dbState.balance = this.balance;
    this.dbState.portfolio = this.portfolio;
    this.dbState.history = this.history;
    this.dbState.parameters = this.parameters;
    this.dbState.logs = this.logs.slice(0, 100);
    this.dbState.markModified('portfolio');
    this.dbState.markModified('parameters');
    this.dbState.markModified('history');
    this.dbState.markModified('logs');
    try {
      await this.dbState.save();
    } catch (err) {
      console.error('Failed to save data to MongoDB', err);
    }
  }

  async addLog(message) {
    const log = `[${new Date().toLocaleTimeString()}] ${message}`;
    this.logs.unshift(log);
    if (this.logs.length > 100) this.logs.pop();
    await this.saveData();
    console.log(log);
  }

  async getTotalAssets() {
    let total = this.balance;
    for (const symbol in this.portfolio) {
      const currentPrice = await fetchCurrentPrice(symbol);
      if (currentPrice) {
        total += currentPrice * this.portfolio[symbol].shares;
      }
    }
    return total;
  }

  async buy(symbol, shares, price, reason = 'BUY') {
    const cost = shares * price;
    if (this.balance >= cost) {
      this.balance -= cost;
      if (!this.portfolio[symbol]) {
        this.portfolio[symbol] = { shares: 0, averagePrice: 0 };
      }
      const p = this.portfolio[symbol];
      const newTotalShares = p.shares + shares;
      p.averagePrice = ((p.shares * p.averagePrice) + cost) / newTotalShares;
      p.shares = newTotalShares;

      this.recordHistory(reason, symbol, shares, price);
      await this.saveData();
      return true;
    }
    return false;
  }

  async sell(symbol, shares, price, reason = 'SELL') {
    if (this.portfolio[symbol] && this.portfolio[symbol].shares >= shares) {
      const revenue = shares * price;
      this.balance += revenue;
      this.portfolio[symbol].shares -= shares;

      if (this.portfolio[symbol].shares === 0) {
        delete this.portfolio[symbol];
      }

      this.recordHistory(reason, symbol, shares, price);
      await this.saveData();
      return true;
    }
    return false;
  }

  recordHistory(type, symbol, shares, price) {
    this.history.unshift({
      id: Date.now().toString() + Math.random().toString(),
      date: new Date().toISOString(),
      type,
      symbol,
      shares,
      price,
      total: shares * price
    });
  }

  // ==== テクニカル指標の計算 ====

  calculateSMA(data, period) {
    const sma = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        sma.push(null);
        continue;
      }
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j].close;
      }
      sma.push(sum / period);
    }
    return sma;
  }

  calculateEMA(data, period) {
    const ema = [];
    const k = 2 / (period + 1);
    let prevEma = null;

    for (let i = 0; i < data.length; i++) {
      const close = data[i].close || data[i]; // dataがオブジェクト配列か数値配列か対応
      if (i === 0) {
        ema.push(close);
        prevEma = close;
      } else {
        const currentEma = (close * k) + (prevEma * (1 - k));
        ema.push(currentEma);
        prevEma = currentEma;
      }
    }
    return ema;
  }

  calculateMACD(data) {
    const ema12 = this.calculateEMA(data, 12);
    const ema26 = this.calculateEMA(data, 26);
    const macdLine = [];
    for (let i = 0; i < data.length; i++) {
      macdLine.push(ema12[i] - ema26[i]);
    }
    const signalLine = this.calculateEMA(macdLine, 9);
    return { macdLine, signalLine };
  }

  calculateRSI(data, period = 14) {
    const rsi = [];
    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 0; i < data.length; i++) {
      if (i === 0) {
        rsi.push(null);
        continue;
      }
      const change = data[i].close - data[i - 1].close;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;

      if (i < period) {
        avgGain += gain;
        avgLoss += loss;
        rsi.push(null);
      } else if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        const rs = avgGain / (avgLoss === 0 ? 1 : avgLoss);
        rsi.push(100 - (100 / (1 + rs)));
      } else {
        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;
        const rs = avgGain / (avgLoss === 0 ? 1 : avgLoss);
        rsi.push(100 - (100 / (1 + rs)));
      }
    }
    return rsi;
  }

  // ==== センチメント分析 ====

  async analyzeSentiment(symbol) {
    const newsTitles = await fetchNews(symbol);
    if (newsTitles.length === 0) return 0;

    let score = 0;
    for (const title of newsTitles) {
      const lowerTitle = title.toLowerCase();
      for (const word of POSITIVE_WORDS) {
        if (lowerTitle.includes(word)) score += 1;
      }
      for (const word of NEGATIVE_WORDS) {
        if (lowerTitle.includes(word)) score -= 1;
      }
    }
    return score;
  }

  // ==== メイン取引ロジック ====

  async checkAndTrade(symbol) {
    if (!this.isReady) return null;

    const data = await fetchStockData(symbol, '1y', '1d');
    if (data.length < 50) return null; // データ不足

    const i = data.length - 1;
    const currentPrice = data[i].close;
    let action = 'HOLD';

    // 1. リスク管理（損切り・利確の優先評価）
    if (this.portfolio[symbol] && this.portfolio[symbol].shares > 0) {
      const avgPrice = this.portfolio[symbol].averagePrice;
      const profitRate = (currentPrice - avgPrice) / avgPrice;

      // 利確（+10%）
      if (profitRate >= 0.10) {
        await this.sell(symbol, this.portfolio[symbol].shares, currentPrice, 'TAKE_PROFIT');
        return { symbol, action: 'TAKE_PROFIT', currentPrice };
      }
      // 損切り（-5%）
      if (profitRate <= -0.05) {
        await this.sell(symbol, this.portfolio[symbol].shares, currentPrice, 'STOP_LOSS');
        return { symbol, action: 'STOP_LOSS', currentPrice };
      }
    }

    // 2. テクニカル指標の計算
    const shortSma = this.calculateSMA(data, 10);
    const longSma = this.calculateSMA(data, 30);
    const { macdLine, signalLine } = this.calculateMACD(data);
    const rsi = this.calculateRSI(data, 14);

    const prevShort = shortSma[i - 1];
    const prevLong = longSma[i - 1];
    const currShort = shortSma[i];
    const currLong = longSma[i];

    const prevMacd = macdLine[i - 1];
    const prevSignal = signalLine[i - 1];
    const currMacd = macdLine[i];
    const currSignal = signalLine[i];

    const currRsi = rsi[i];

    // サインの判定
    const isGoldenCross = prevShort <= prevLong && currShort > currLong;
    const isDeadCross = prevShort >= prevLong && currShort < currLong;
    const isMacdBullish = prevMacd <= prevSignal && currMacd > currSignal;
    const isMacdBearish = prevMacd >= prevSignal && currMacd < currSignal;
    const isRsiOversold = currRsi < 30;
    const isRsiOverbought = currRsi > 70;

    // 3. センチメント分析
    const sentimentScore = await this.analyzeSentiment(symbol);

    // 4. 複合判断による売買実行
    // 買い条件: SMAゴールデンクロス、または (MACD強気 ＆ RSI売られすぎ)、かつ ニュースが極端に悪くないこと
    if ((isGoldenCross || (isMacdBullish && isRsiOversold)) && sentimentScore > -2) {
      const investAmount = this.balance * 0.2;
      if (investAmount >= currentPrice) {
        const sharesToBuy = Math.floor(investAmount / currentPrice);
        if (sharesToBuy > 0 && await this.buy(symbol, sharesToBuy, currentPrice)) {
          action = 'BUY';
        }
      }
    } 
    // 売り条件: SMAデッドクロス、または (MACD弱気 ＆ RSI買われすぎ)、または ニュースが極端に悪い
    else if (isDeadCross || (isMacdBearish && isRsiOverbought) || sentimentScore <= -2) {
      if (this.portfolio[symbol] && this.portfolio[symbol].shares > 0) {
        const sharesToSell = this.portfolio[symbol].shares;
        if (await this.sell(symbol, sharesToSell, currentPrice)) {
          action = 'SELL';
        }
      }
    }

    return {
      symbol,
      action,
      currentPrice,
      shortSma: currShort,
      longSma: currLong,
      macd: currMacd,
      rsi: currRsi,
      sentimentScore
    };
  }
}
