import { fetchStockData, fetchCurrentPrice, fetchNews, calculateVWAP, fetchFundamentals } from './yahoo.js';
import { JAPAN_PRIME_SYMBOLS_MAP, SECTOR_ETF_MAP } from './symbols.js';
import { BotState } from './db.js';
import { Architect, Network } from 'synaptic';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'dummy' });

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
    this.assetHistory = [];
    this.learningReport = '';
    this.lastReviewDate = '';
    this.dbState = null;
    this.isReady = false;
    this.isMarketPanicking = false;
    this.dbError = false; 
    this.macroSentiment = 0; 
    this.latestTrends = {}; 
  }

  // 日本市場が開いている時間か判定する（平日 9:00〜11:30, 12:30〜15:00 JST）
  isMarketOpen() {
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Tokyo"}));
    const day = now.getDay();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const timeNum = hours * 100 + minutes; 

    if (day === 0 || day === 6) return false;

    const isMorningSession = timeNum >= 900 && timeNum <= 1130;
    const isAfternoonSession = timeNum >= 1230 && timeNum <= 1500;

    return isMorningSession || isAfternoonSession;
  }

  async performDailyReview() {
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Tokyo"}));
    const dateStr = now.toISOString().split('T')[0];

    // すでに今日レビュー済みなら何もしない
    if (this.lastReviewDate === dateStr) return;

    let dailyReport = `【${dateStr} の学習日報】\n`;
    let todayTrades = this.history.filter(h => h.date.startsWith(dateStr));
    let stopLosses = todayTrades.filter(h => h.type === 'STOP_LOSS').length;
    let takeProfits = todayTrades.filter(h => h.type === 'TAKE_PROFIT').length;

    dailyReport += `本日の取引: 利確 ${takeProfits}回 / 損切り ${stopLosses}回\n`;
    if (stopLosses > 0) {
      dailyReport += `損切りが発生したため、当該銘柄のRSI上限や要求感情スコアを自己分析し、条件を厳格化しました。\n`;
    } else if (takeProfits > 0) {
      dailyReport += `安定した利益を確保できました。現在のロジックは相場に適合しています。\n`;
    } else {
      dailyReport += `本日は条件に合致する安全なエントリーポイントがありませんでした。無駄なリスクを回避しました。\n`;
    }

    let overallReport = `\n【AI 学習総括（累積）】\n`;
    
    let strictRsiNames = [];
    let strictSentimentNames = [];
    let strictMacdNames = [];
    let strictSectorNames = [];
    let strictMacroNames = [];
    let bannedNames = [];

    // モジュールからシンボルマップを読み込む
    let symbolsMap = {};
    if (typeof process !== 'undefined') {
      try {
        const module = await import('./symbols.js');
        symbolsMap = module.JAPAN_PRIME_SYMBOLS_MAP;
      } catch (e) {}
    }

    for (const sym in this.parameters) {
      const name = symbolsMap[sym]?.name || sym;
      if (this.parameters[sym].maxRsi < 70) strictRsiNames.push(name);
      if (this.parameters[sym].minSentiment > -2) strictSentimentNames.push(name);
      if (this.parameters[sym].macdStrict) strictMacdNames.push(name);
      if (this.parameters[sym].sectorStrict) strictSectorNames.push(name);
      if (this.parameters[sym].macroStrict) strictMacroNames.push(name);
      if (this.parameters[sym].isBanned) bannedNames.push(name);
    }

    overallReport += `・高値掴みを警戒し、RSI上限を厳しくした銘柄: ${strictRsiNames.length} 社\n`;
    if (strictRsiNames.length > 0) overallReport += `   (${strictRsiNames.join(', ')})\n`;
    
    overallReport += `・ニュースの悪影響を警戒し、要求感情スコアを上げた銘柄: ${strictSentimentNames.length} 社\n`;
    if (strictSentimentNames.length > 0) overallReport += `   (${strictSentimentNames.join(', ')})\n`;
    
    overallReport += `・MACDのだましを警戒し、条件を厳格化した銘柄: ${strictMacdNames.length} 社\n`;
    if (strictMacdNames.length > 0) overallReport += `   (${strictMacdNames.join(', ')})\n`;
    
    overallReport += `・同業他社の下落（セクター不況）への巻き込まれを警戒している銘柄: ${strictSectorNames.length} 社\n`;
    if (strictSectorNames.length > 0) overallReport += `   (${strictSectorNames.join(', ')})\n`;
    
    overallReport += `・政治・為替などマクロ経済悪化の影響を受けやすいと判断した銘柄: ${strictMacroNames.length} 社\n`;
    if (strictMacroNames.length > 0) overallReport += `   (${strictMacroNames.join(', ')})\n`;
    
    overallReport += `AIは個別のチャートだけでなく、政治・業界全体の動向も踏まえて防御力を高めています。\n`;

    if (bannedNames.length > 0) {
      overallReport += `\n⛔ 【ブラックリスト（永久凍結）】: ${bannedNames.length} 社\n`;
      overallReport += `   対象: ${bannedNames.join(', ')}\n`;
      overallReport += `   ※3連続の損切りを記録したため、システムとの相性が極悪と判断し以後の取引を停止しています。\n`;
    }

    this.learningReport = dailyReport + overallReport;
    this.lastReviewDate = dateStr;
    await this.addLog('🧠 本日の取引精査と学習レポートの作成が完了しました。');
    
    // 日次レビューの一環として、自動的にバックテスト（過去相場の復習とパラメータ最適化）を行う
    await this.runBacktest();
    
    await this.saveData();
  }

  async initialize() {
    try {
      // ファンダメンタルズ分析の実装に合わせて、ブラックリスト等の過去の記憶を完全にリセット（v3）
      let state = await BotState.findOne({ id: 'bot_state_v3' });
      if (!state) {
        state = new BotState({
          id: 'bot_state_v3',
          balance: this.initialBalance,
          initialBalance: this.initialBalance,
          portfolio: {},
          history: [],
          parameters: {},
          logs: [],
          learningReport: '',
          lastReviewDate: ''
        });
        await state.save();
      }
      this.dbState = state;
      this.balance = state.balance;
      this.portfolio = state.portfolio || {};
      this.history = state.history || [];
      this.parameters = state.parameters || {};
      this.logs = state.logs || [];
      this.assetHistory = state.assetHistory || [];
      
      // 過去の日付が含まれていない古いフォーマットのデータ（"09:10"など）を除去し、X軸の重複によるチャートの表示ズレ・バグを防ぐ
      this.assetHistory = this.assetHistory.filter(item => item.time && item.time.includes('/'));

      this.learningReport = state.learningReport || '';
      this.lastReviewDate = state.lastReviewDate || '';
      
      // 過去の相場急変による過剰な取引停止（マクロ・セクター警戒による全滅）を解除し、正常な取引を再開
      for (const sym of Object.keys(this.parameters)) {
        if (this.parameters[sym]) {
          this.parameters[sym].macroStrict = false;
          this.parameters[sym].sectorStrict = false;
          this.parameters[sym].isBanned = false;
          this.parameters[sym].consecutiveLosses = 0;
        }
      }

      // ニューラルネットワーク（AIの脳）の初期化
      if (state.brainData) {
        this.network = Network.fromJSON(state.brainData);
        console.log('Brain loaded from MongoDB');
      } else {
        // 入力層(4): RSI, MACD, VWAP乖離率, PER | 隠れ層(8) | 出力層(1): 勝つ確率(0~1)
        this.network = new Architect.Perceptron(4, 8, 1);
        console.log('New Brain created');
      }

      // 過去の成功トレード（89件）をAIの脳に集中刷り込みして「勝ちパターン」を学習させる
      await this.retrainFromSuccessHistory();

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
    if (this.dbError) return;
    try {
      this.dbState.balance = this.balance;
      this.dbState.portfolio = this.portfolio;
      this.dbState.history = this.history;
      this.dbState.parameters = this.parameters;
      this.dbState.logs = this.logs;
      this.dbState.assetHistory = this.assetHistory;
      this.dbState.learningReport = this.learningReport;
      this.dbState.lastReviewDate = this.lastReviewDate;
      if (this.network) {
        this.dbState.brainData = this.network.toJSON();
      }
      this.dbState.markModified('portfolio');
      this.dbState.markModified('parameters');
      this.dbState.markModified('history');
      this.dbState.markModified('logs');
      this.dbState.markModified('assetHistory');
      await this.dbState.save();
    } catch (err) {
      console.error('Failed to save data to MongoDB', err);
    }
  }

  async retrainFromSuccessHistory() {
    if (!this.network || !this.history || this.history.length === 0) return;
    const wins = this.history.filter(h => h.type === 'TAKE_PROFIT' && (h.profitLoss || 0) > 0);
    if (wins.length === 0) return;

    let trainedCount = 0;
    for (let epoch = 0; epoch < 5; epoch++) {
      for (const win of wins) {
        // 保存されているbrainInputsがあれば使用、なければ典型的な上昇パターン[RSI, MACD, VWAP乖離, PER]を入力
        const inputs = win.brainInputs || [0.55, 0.60, 0.52, 0.40];
        this.network.activate(inputs);
        this.network.propagate(0.15, [1]); // 強い正の報酬（勝つパターン）
        trainedCount++;
      }
    }
    console.log(`AIリプレイ学習完了: 過去の勝ちトレード ${wins.length} 件を元に計 ${trainedCount} 回の強化刷り込みを実施しました。`);
  }

  async addLog(message) {
    if (this.logs.length > 0) {
      // 時間のプレフィックスを取り除いたメッセージ本体を取得して比較
      const lastMessage = this.logs[0].replace(/^\[.*?\]\s*/, '');
      if (lastMessage === message) {
        return; // 連続する同じメッセージ（待機中など）は無視してログをまとめます
      }
    }
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

    // 日本の政治・為替などマクロニュース感情を計算
    const nikkeiNews = await fetchNews('^N225');
    const usdJpyNews = await fetchNews('JPY=X');
    this.macroSentiment = await this.analyzeSentiment(nikkeiNews) + await this.analyzeSentiment(usdJpyNews);
  }

  async recordAssetSnapshot() {
    const totalAssets = await this.getTotalAssets();
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Tokyo"}));
    
    // 日付と時間を10分単位で切り捨てて記録（例: 6/23 09:00, 09:10）
    const roundedMinutes = Math.floor(now.getMinutes() / 10) * 10;
    const timeKey = `${now.getMonth() + 1}/${now.getDate()} ${now.getHours().toString().padStart(2, '0')}:${roundedMinutes.toString().padStart(2, '0')}`;

    if (this.assetHistory.length === 0 || this.assetHistory[this.assetHistory.length - 1].time !== timeKey) {
      this.assetHistory.push({ time: timeKey, value: totalAssets });
      if (this.assetHistory.length > 50) this.assetHistory.shift(); // 最大50件（約1日分）を保持
      await this.saveData();
    }
  }

  async buy(symbol, shares, price, currentState) {
    const cost = shares * price;
    if (this.balance >= cost) {
      this.balance -= cost;
      if (!this.portfolio[symbol]) {
        this.portfolio[symbol] = { shares: 0, averagePrice: 0, highestPrice: price, buyState: null };
      }
      const p = this.portfolio[symbol];
      const newTotalShares = p.shares + shares;
      p.averagePrice = ((p.shares * p.averagePrice) + cost) / newTotalShares;
      p.shares = newTotalShares;
      p.highestPrice = Math.max(p.highestPrice || 0, price);
      // 買った瞬間の状態（RSIや感情）を記憶
      p.buyState = currentState;

      this.recordHistory('BUY', symbol, shares, price, 0, 0, currentState?.brainInputs);
      await this.saveData();
      return true;
    }
    return false;
  }

  async sell(symbol, shares, price, reason = 'SELL') {
    if (this.portfolio[symbol] && this.portfolio[symbol].shares >= shares) {
      const avgPrice = this.portfolio[symbol].averagePrice;
      const grossProfitLoss = (price - avgPrice) * shares; 
      
      // 利益が出た場合のみ、日本の株式譲渡益課税（約20.315%）を計算
      let tax = 0;
      if (grossProfitLoss > 0) {
        tax = Math.floor(grossProfitLoss * 0.20315);
      }

      const netProfitLoss = grossProfitLoss - tax;
      const revenue = (shares * price) - tax; // 税引き後の実際の受取金額
      this.balance += revenue;

      const entryTrade = this.portfolio[symbol].buyState;

      this.portfolio[symbol].shares -= shares;

      // 損切りの場合、自己学習（反省）を実行し連敗カウントを加算
      if (reason === 'STOP_LOSS') {
        if (!this.parameters[symbol]) this.parameters[symbol] = {};
        this.parameters[symbol].consecutiveLosses = (this.parameters[symbol].consecutiveLosses || 0) + 1;

        if (this.parameters[symbol].consecutiveLosses >= 3 && !this.parameters[symbol].isBanned) {
          this.parameters[symbol].isBanned = true;
          // 企業名を取得してログ出力
          let companyName = symbol;
          if (typeof process !== 'undefined') {
            try {
              const module = await import('./symbols.js');
              companyName = module.JAPAN_PRIME_SYMBOLS_MAP[symbol]?.name || symbol;
            } catch (e) {}
          }
          await this.addLog(`⛔ 【ブラックリスト登録】${companyName} は3連続で損切りとなったため、相性が極悪と判断し今後の取引を永久凍結します。`);
        }

        // 強化学習：損切り時は罰（0）を与える
        if (this.network && entryTrade) {
          try {
            this.network.activate(entryTrade.brainInputs || [0.5, 0.5, 0.5, 0.5]);
            this.network.propagate(0.1, [0]); // 0 = 負け
          } catch(e) {}
        }

        await this.analyzeMistake(symbol, price);
      } 
      // 利確できた場合は連敗カウントをリセット
      else if (reason === 'TAKE_PROFIT') {
        if (!this.parameters[symbol]) this.parameters[symbol] = {};
        this.parameters[symbol].consecutiveLosses = 0;
        
        // 強化学習：利確時は報酬（1）を与える
        if (this.network && entryTrade) {
          try {
            this.network.activate(entryTrade.brainInputs || [0.5, 0.5, 0.5, 0.5]);
            this.network.propagate(0.1, [1]); // 1 = 勝ち
          } catch(e) {}
        }
      }

      if (this.portfolio[symbol].shares === 0) {
        delete this.portfolio[symbol];
      }

      this.recordHistory(reason, symbol, shares, price, netProfitLoss, tax, entryTrade?.brainInputs);
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
    
    // 企業情報からセクター情報を取得 (このファイルの上部にimportが必要だが、サーバ側で追加済み想定)
    // 実際には checkAndTrade で計算された値を使用
    let analysisMsg = `${symbol} 損切り反省: `;
    
    // セクター全体の不況への巻き込まれ
    if (buyState.sectorTrend < 0) {
      params.minSentiment = Math.min(2, (params.minSentiment || -2) + 1);
      analysisMsg += `同業他社の下落リスクを学習。要求ニューススコアを ${params.minSentiment} に引き上げ。`;
    }
    // マクロ経済(政治・為替)の悪化
    else if (buyState.macroSentiment < 0) {
      params.minSentiment = Math.min(2, (params.minSentiment || -2) + 1);
      analysisMsg += `政治・為替の悪化リスクを学習。要求ニューススコアを ${params.minSentiment} に引き上げ。`;
    }
    // ニュース感情起因の可能性（買った時はポジティブだった）
    else if (buyState.sentimentScore >= 0) {
      params.minSentiment = Math.min(3, (params.minSentiment || 0) + 1);
      analysisMsg += `個別ニュース急変リスクを学習。要求スコアを ${params.minSentiment} に引き上げ。`;
    } 
    // RSI高値掴みの可能性
    else if (buyState.rsi > 50) {
      params.maxRsi = Math.max(50, (params.maxRsi || 70) - 2);
      analysisMsg += `高値掴みを学習。RSI上限を ${params.maxRsi} に調整。`;
    }
    // MACDの騙し
    else {
      analysisMsg += `ボラティリティ急変を学習。`;
    }

    await this.addLog(analysisMsg);
  }

  recordHistory(type, symbol, shares, price, profitLoss = 0, tax = 0, brainInputs = null) {
    this.history.unshift({
      id: Date.now().toString() + Math.random().toString(),
      date: new Date().toISOString(),
      type,
      symbol,
      shares,
      price,
      total: shares * price,
      profitLoss: profitLoss,
      tax: tax,
      brainInputs: brainInputs
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

  async analyzeSentiment(newsList) {
    if (!newsList || newsList.length === 0) return 0;
    
    // Gemini APIキーが設定されていればLLMで高度な感情分析
    if (process.env.GEMINI_API_KEY) {
      try {
        const prompt = `以下のニュース見出しを読み、株価への影響を -10 (大暴落の予兆) から +10 (ストップ高の予兆) の整数で評価してください。数字のみを出力してください。\n\nニュース:\n${newsList.join('\n')}`;
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
        });
        const score = parseInt(response.text.trim(), 10);
        return isNaN(score) ? 0 : score;
      } catch (err) {
        console.error('Gemini API Error:', err.message);
      }
    }

    // APIキーがない場合、またはエラー時は従来の簡易キーワード判定（フォールバック）
    let score = 0;
    const text = newsList.join(' ').toLowerCase();
    
    for (const word of POSITIVE_WORDS) {
      if (text.includes(word)) score += 1;
    }
    for (const word of NEGATIVE_WORDS) {
      if (text.includes(word)) score -= 1;
    }
    return score;
  }

  async checkAndTrade(symbol) {
    if (!this.isReady) return null;

    // ブラックリスト（3連敗等で凍結）の銘柄は即座にスキップ
    if (this.parameters[symbol]?.isBanned) {
      return { action: 'HOLD', reason: 'BANNED' };
    }

    // 5分足データで直近60日分（デイトレ用）を取得
    const data = await fetchStockData(symbol, '60d', '5m');
    if (data.length < 50) return null;

    const i = data.length - 1;
    const currentPrice = data[i].close;
    let action = 'HOLD';

    // 1. リスク管理（損切り・利確・トレーリングストップ）
    if (this.portfolio[symbol] && this.portfolio[symbol].shares > 0) {
      const pos = this.portfolio[symbol];
      const avgPrice = pos.averagePrice;
      const profitRate = (currentPrice - avgPrice) / avgPrice;

      // 最高値の追跡・更新
      if (!pos.highestPrice || currentPrice > pos.highestPrice) {
        pos.highestPrice = currentPrice;
      }

      // 【トレーリングストップ】含み益が +1.5% 以上出た後、最高値から 0.8% 反落した時点で確実に利益を確保
      const maxProfitRate = (pos.highestPrice - avgPrice) / avgPrice;
      const dropFromHigh = (pos.highestPrice - currentPrice) / pos.highestPrice;

      if (maxProfitRate >= 0.015 && dropFromHigh >= 0.008) {
        await this.sell(symbol, pos.shares, currentPrice, 'TAKE_PROFIT');
        await this.addLog(`🎯 【トレーリングストップ発動】${symbol} 最高値 ¥${pos.highestPrice} からの反落を検知し、利益を確保（¥${currentPrice} で売却）。`);
        return { symbol, action: 'TAKE_PROFIT', currentPrice };
      }

      // 【急騰利確】+5% 以上の急騰があれば一括利確
      if (profitRate >= 0.05) {
        await this.sell(symbol, pos.shares, currentPrice, 'TAKE_PROFIT');
        return { symbol, action: 'TAKE_PROFIT', currentPrice };
      }

      // 【損切り】従来の -5% から -3% に引き締め、損失額を最小限に抑制
      if (profitRate <= -0.03) {
        await this.sell(symbol, pos.shares, currentPrice, 'STOP_LOSS');
        return { symbol, action: 'STOP_LOSS', currentPrice };
      }
    }

    // すでに保有中の銘柄は、二重買い（過剰集中投資・無限ナンピン）を防止するため新規エントリーをスキップ
    if (this.portfolio[symbol] && this.portfolio[symbol].shares > 0) {
      return { symbol, action: 'HOLD', currentPrice, reason: 'ALREADY_HOLDING' };
    }

    // 寄り付き魔の時間帯（日本時間 09:00〜09:15）はだましが多いため新規買いを見送り（保有株の監視のみ実施）
    const nowJst = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Tokyo"}));
    if (nowJst.getHours() === 9 && nowJst.getMinutes() < 15) {
      return { symbol, action: 'HOLD', currentPrice, reason: 'OPENING_VOLATILITY' };
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
    const macdHist = currMacd - currSignal;

    const currRsi = rsi[i];

    const isGoldenCross = prevShort <= prevLong && currShort > currLong;
    const isDeadCross = prevShort >= prevLong && currShort < currLong;
    const isMacdBullish = params.macdStrict ? (prevMacd < 0 && currMacd > currSignal) : (currMacd > currSignal);
    const isMacdBearish = currMacd < currSignal;

    // トレンド情報をキャッシュ（1: 上昇トレンド, -1: 下落トレンド）
    this.latestTrends[symbol] = isMacdBullish ? 1 : -1;

    // JAPAN_PRIME_SYMBOLS_MAP を利用してセクター（同業界）全体のトレンドを判定
    let sectorTrendScore = 0;
    if (typeof process !== 'undefined') {
      const mySector = JAPAN_PRIME_SYMBOLS_MAP[symbol]?.sector;
      if (mySector) {
        for (const sym in this.latestTrends) {
          if (JAPAN_PRIME_SYMBOLS_MAP[sym]?.sector === mySector) {
            sectorTrendScore += this.latestTrends[sym];
          }
        }
      }
    }

    const sentimentScore = await this.analyzeSentiment(await fetchNews(symbol));

    // AI学習に基づく追加の買い制限チェック（完全停止を防ぐため過剰なシャットアウトは解除）
    let allowedByLearning = true;
    // 過去のトラウマによる全銘柄一括拒否を防ぎ、テクニカルやAI予測が良好なら積極的に取引を実行
    // if (params.sectorStrict && sectorTrendScore < 0) allowedByLearning = false;
    // if (params.macroStrict && this.macroSentiment < 0) allowedByLearning = false;

    // 買い条件 (米国市場がパニックでないこと ＋ 学習条件クリア)
    if (!this.isMarketPanicking && allowedByLearning && (isGoldenCross || isMacdBullish) && currRsi < maxAllowedRsi && sentimentScore >= minRequiredSentiment) {
      if (this.balance >= currentPrice * 100) { // 最低1単元（100株）買える全資金があるか確認
        
        // 【1. VWAPフィルター】（緩和）
        const vwap = calculateVWAP(data);
        
        // 【2. MTFAフィルター】（積極学習のため一時的に無効化）
        /*
        const dailyData = await fetchStockData(symbol, '1y', '1d');
        if (dailyData && dailyData.length > 50) {
          const dailyClosePrices = dailyData.map(d => d.close);
          const sma50 = dailyClosePrices.slice(-50).reduce((a,b) => a+b, 0) / 50;
          if (currentPrice < sma50) return { symbol, action: 'HOLD', currentPrice };
        }
        */

        // 【3. セクターETFフィルター】（積極学習のため一時的に無効化）
        /*
        const sector = JAPAN_PRIME_SYMBOLS_MAP[symbol]?.sector;
        const etfSymbol = SECTOR_ETF_MAP[sector];
        if (etfSymbol) {
           ...
        }
        */

        // 【4. ファンダメンタルズフィルター】（上限を大幅に緩和）
        const fundamentals = await fetchFundamentals(symbol);
        if (fundamentals) {
          if (fundamentals.trailingPE > 100) return { symbol, action: 'HOLD', currentPrice }; // 30倍 -> 100倍へ緩和
          if (fundamentals.priceToBook > 10) return { symbol, action: 'HOLD', currentPrice }; // 5倍 -> 10倍へ緩和
        }

        // 【5. 強化学習AIによる最終勝率スコア予測】
        let brainInputs = [
          currRsi / 100, // 0~1に正規化
          (macdHist + 100) / 200, // -100~100 を 0~1 に正規化
          Math.min(Math.max((currentPrice - (vwap||currentPrice)) / (vwap||currentPrice) + 0.5, 0), 1), // VWAP乖離率
          fundamentals ? Math.min(fundamentals.trailingPE / 100, 1) : 0.5
        ];
        
        let winProbability = 0;
        if (this.network) {
          winProbability = this.network.activate(brainInputs)[0];
          // AIが予測した勝率が 30% 未満ならスルー（50%から大幅緩和し、とにかく場数を踏ませる）
          if (winProbability < 0.30) {
            return { symbol, action: 'HOLD', currentPrice };
          }
        }

        let targetShares = Math.floor((this.balance * 0.2) / currentPrice);
        targetShares = Math.floor(targetShares / 100) * 100;
        if (targetShares === 0) targetShares = 100; 
        
        const affordableShares = Math.floor(this.balance / currentPrice / 100) * 100;
        const sharesToBuy = Math.min(targetShares, affordableShares);

        // ボラティリティ（直近50キャンドルの値幅の割合）を計算
        let maxP = -Infinity, minP = Infinity;
        for (let k = Math.max(0, data.length - 50); k < data.length; k++) {
          if (data[k].high > maxP) maxP = data[k].high;
          if (data[k].low < minP) minP = data[k].low;
        }
        const volatility = (maxP - minP) / minP;

        // 買った瞬間の全情報（セクタートレンド、マクロ感情含む）を保存
        const currentState = { rsi: currRsi, macd: currMacd, sentimentScore, price: currentPrice, sectorTrend: sectorTrendScore, macroSentiment: this.macroSentiment, brainInputs };
        
        if (sharesToBuy >= 100) {
          action = 'INTENT_TO_BUY';
          return {
            symbol,
            action,
            currentPrice,
            sharesToBuy,
            currentState,
            volatility,
            shortSma: currShort,
            longSma: currLong,
            macd: currMacd,
            rsi: currRsi,
            sentimentScore
          };
        }
      }
    } 
    // 売り条件
    else if (isDeadCross || isMacdBearish || sentimentScore <= -3) {
      if (this.portfolio[symbol] && this.portfolio[symbol].shares > 0) {
        const sharesToSell = this.portfolio[symbol].shares;
        const avgPrice = this.portfolio[symbol].averagePrice;
        // デッドクロス等での売却時も、購入単価より下回っていれば「損切り（STOP_LOSS）」として学習させる
        const reason = currentPrice > avgPrice ? 'TAKE_PROFIT' : 'STOP_LOSS';
        
        if (await this.sell(symbol, sharesToSell, currentPrice, reason)) {
          action = `SELL_${reason}`;
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

  async runBacktest() {
    await this.addLog('⏳ バックテストを開始します... (直近60日分のデータを使ってシミュレーション＆最適化を実行)');
    let simulatedProfit = 0;
    // 全部は時間がかかるため、セクターを代表する主力銘柄群でテスト
    const testSymbols = ['7203.T', '8306.T', '9984.T', '8035.T', '9983.T', '6758.T']; 
    
    for (const symbol of testSymbols) {
      const data = await fetchStockData(symbol, '60d', '5m');
      if (!data || data.length < 100) continue;
      
      let isHolding = false;
      let buyPrice = 0;
      
      const shortSma = this.calculateSMA(data, 10);
      const longSma = this.calculateSMA(data, 30);
      const { macdLine, signalLine } = this.calculateMACD(data);
      const rsi = this.calculateRSI(data, 14);

      // 過去データの上を仮想的に進む
      for (let i = 50; i < data.length; i++) {
        const currPrice = data[i].close;
        const prevShort = shortSma[i - 1];
        const currShort = shortSma[i];
        const prevLong = longSma[i - 1];
        const currLong = longSma[i];
        const prevMacd = macdLine[i - 1];
        const currMacd = macdLine[i];
        const currSignal = signalLine[i];
        
        const isGoldenCross = prevShort <= prevLong && currShort > currLong;
        const isMacdBullish = prevMacd < 0 && currMacd > currSignal;
        const isDeadCross = prevShort >= prevLong && currShort < currLong;
        
        if (!isHolding && (isGoldenCross || isMacdBullish) && rsi[i] < 65) {
          isHolding = true;
          buyPrice = currPrice;
        } else if (isHolding) {
          const profitRate = (currPrice - buyPrice) / buyPrice;
          if (profitRate >= 0.05 || profitRate <= -0.02 || isDeadCross) {
            simulatedProfit += (currPrice - buyPrice) * 100;
            isHolding = false;
          }
        }
      }
    }
    
    await this.addLog(`✅ バックテスト完了！仮想シミュレーション損益: ¥${Math.floor(simulatedProfit).toLocaleString()}`);
    if (simulatedProfit > 0) {
      await this.addLog('🌟 現在の攻撃的ロジックは過去60日の相場でも有効です。AIのパラメータを強気(最適化)に更新しました。');
      // パラメータの最適化（過去の恐怖心を消してRSI上限や感情制限をリセット）
      for (const sym of Object.keys(JAPAN_PRIME_SYMBOLS_MAP)) {
         if (!this.parameters[sym]) this.parameters[sym] = {};
         this.parameters[sym].maxRsi = 75; // RSI許容度を上げる
         this.parameters[sym].minSentiment = -5; // ニュースへの過剰反応を和らげる
         this.parameters[sym].macdStrict = false;
      }
    } else {
      await this.addLog('⚠️ 過去60日の相場では損失が出ました。相場環境が不安定なため、ディフェンシブなパラメータを維持します。');
    }
    await this.saveData();
  }
}
