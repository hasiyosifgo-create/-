import { fetchStockData, fetchCurrentPrice, fetchNews } from './yahoo.js';
import { BotState } from './db.js';

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
    this.isMarketPanicking = false;
    this.dbError = false; // DB接続失敗フラグ
  }

  // 日本市場が開いている時間か判定する（平日 9:00〜11:30, 12:30〜15:00 JST）
  isMarketOpen() {
    // 現在の日本時間（JST）を取得
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Tokyo"}));
    const day = now.getDay();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const timeNum = hours * 100 + minutes; // 例: 9:30 => 930

    // 土日（0=日曜, 6=土曜）は休場
    if (day === 0 || day === 6) return false;

    // 前場: 9:00(900) 〜 11:30(1130)
    const isMorningSession = timeNum >= 900 && timeNum <= 1130;
    // 後場: 12:30(1230) 〜 15:00(1500)
    const isAfternoonSession = timeNum >= 1230 && timeNum <= 1500;

    return isMorningSession || isAfternoonSession;
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
      this.dbError = false;
      console.log('Bot data initialized from MongoDB');
    } catch (err) {
      console.error('Failed to load data from MongoDB (Running in memory mode)', err);
      this.dbError = true;
      this.isReady = true;
      await this.addLog('⚠️【重大な警告】データベース(MongoDB)に接続できません。データは保存されず初期化されています。MongoDBのIPアクセス制限(0.0.0.0/0)等を確認してください。');
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

  async checkMacroEnvironment() {
    // 米国市場（S&P 500）の監視
    const sp500 = await fetchStockData('^GSPC', '5d', '1d');
    if (sp500.length >= 2) {
      const yesterday = sp500[sp500.length - 2].close;
      const today = sp500[sp500.length - 1].close;
      const dropRate = (today - yesterday) / yesterday;
      
      if (dropRate < -0.02) { // 2%以上の下落でパニックと判定
        if (!this.isMarketPanicking) {
          await this.addLog('⚠️ 米国市場(S&P 500)で2%以上の暴落を検知。新規購入を一時停止（連れ安警戒）します。');
          this.isMarketPanicking = true;
        }
      } else {
        if (this.isMarketPanicking) {
          await this.addLog('✅ 米国市場のパニックが収まりました。新規購入を再開します。');
          this.isMarketPanicking = false;
        }
      }
    }
  }

  async buy(symbol, shares, price, currentState) {
    const cost = shares * price;
    if (this.balance >= cost) {
      this.balance -= cost;
      if (!this.portfolio[symbol]) {
        this.portfolio[symbol] = { shares: 0, averagePrice: 0, buyState: null };
      }
      const p = this.portfolio[symbol];
      const newTotalShares = p.shares + shares;
      p.averagePrice = ((p.shares * p.averagePrice) + cost) / newTotalShares;
      p.shares = newTotalShares;
      // 買った瞬間の状態（RSIや感情）を記憶
      p.buyState = currentState;

      this.recordHistory('BUY', symbol, shares, price);
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

      // 損切りの場合、自己学習（反省）を実行
      if (reason === 'STOP_LOSS') {
        await this.analyzeMistake(symbol, price);
      }

      if (this.portfolio[symbol].shares === 0) {
        delete this.portfolio[symbol];
      }

      this.recordHistory(reason, symbol, shares, price);
      await this.saveData();
      return true;
    }
    return false;
  }

  async analyzeMistake(symbol, currentPrice) {
    const buyState = this.portfolio[symbol].buyState;
    if (!buyState) return;

    if (!this.parameters[symbol]) this.parameters[symbol] = {};
    const params = this.parameters[symbol];
    
    let analysisMsg = `${symbol} 損切り反省: `;
    
    // ニュース感情起因の可能性（買った時はポジティブだった）
    if (buyState.sentimentScore >= 0) {
      // 感情スコアの閾値を厳しくする
      params.minSentiment = (params.minSentiment || 0) + 1;
      analysisMsg += `ニュース急変リスクを学習。要求スコアを ${params.minSentiment} に引き上げ。`;
    } 
    // RSI高値掴みの可能性
    else if (buyState.rsi > 40) {
      params.maxRsi = Math.max(30, (params.maxRsi || 70) - 5);
      analysisMsg += `高値掴みを学習。RSI上限を ${params.maxRsi} に引き下げ。`;
    }
    // MACDの騙し
    else {
      params.macdStrict = true;
      analysisMsg += `MACDのダマシを学習。判定条件を厳格化。`;
    }

    await this.addLog(analysisMsg);
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
      const close = data[i].close || data[i];
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

  async checkAndTrade(symbol) {
    if (!this.isReady) return null;

    // 5分足データで直近60日分（デイトレ用）を取得
    const data = await fetchStockData(symbol, '60d', '5m');
    if (data.length < 50) return null;

    const i = data.length - 1;
    const currentPrice = data[i].close;
    let action = 'HOLD';

    // 1. リスク管理（損切り・利確）
    if (this.portfolio[symbol] && this.portfolio[symbol].shares > 0) {
      const avgPrice = this.portfolio[symbol].averagePrice;
      const profitRate = (currentPrice - avgPrice) / avgPrice;

      if (profitRate >= 0.10) {
        await this.sell(symbol, this.portfolio[symbol].shares, currentPrice, 'TAKE_PROFIT');
        return { symbol, action: 'TAKE_PROFIT', currentPrice };
      }
      if (profitRate <= -0.05) {
        await this.sell(symbol, this.portfolio[symbol].shares, currentPrice, 'STOP_LOSS');
        return { symbol, action: 'STOP_LOSS', currentPrice };
      }
    }

    // パラメータの取得（自己学習で厳しくなっている可能性がある）
    const params = this.parameters[symbol] || {};
    const maxAllowedRsi = params.maxRsi || 70;
    const minRequiredSentiment = params.minSentiment || -2;

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

    const isGoldenCross = prevShort <= prevLong && currShort > currLong;
    const isDeadCross = prevShort >= prevLong && currShort < currLong;
    const isMacdBullish = params.macdStrict ? (prevMacd < 0 && currMacd > currSignal) : (currMacd > currSignal);
    const isMacdBearish = currMacd < currSignal;

    const sentimentScore = await this.analyzeSentiment(symbol);

    // 買い条件 (米国市場がパニックでないこと)
    if (!this.isMarketPanicking && (isGoldenCross || isMacdBullish) && currRsi < maxAllowedRsi && sentimentScore >= minRequiredSentiment) {
      if (this.balance >= currentPrice * 100) { // 最低1単元（100株）買える全資金があるか確認
        // 基本は資金の20%を投資。ただし100株に満たない場合は最低ラインの100株に変更
        let targetShares = Math.floor((this.balance * 0.2) / currentPrice);
        targetShares = Math.floor(targetShares / 100) * 100;
        if (targetShares === 0) targetShares = 100; 

        // 念のため、現在持っている全資金で買える最大株数を超えないように調整
        const affordableShares = Math.floor(this.balance / currentPrice / 100) * 100;
        const sharesToBuy = Math.min(targetShares, affordableShares);

        const currentState = { rsi: currRsi, macd: currMacd, sentimentScore, price: currentPrice };
        if (sharesToBuy >= 100 && await this.buy(symbol, sharesToBuy, currentPrice, currentState)) {
          action = 'BUY';
        }
      }
    } 
    // 売り条件
    else if (isDeadCross || isMacdBearish || sentimentScore <= -3) {
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
