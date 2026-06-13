import { fetchStockData, fetchCurrentPrice } from '../api/yahoo';

export class BotEngine {
  constructor(initialBalance = 500000) {
    this.initialBalance = initialBalance;
    this.balance = initialBalance;
    this.portfolio = {}; // { AAPL: { shares: 10, averagePrice: 150 } }
    this.history = []; // { id, date, symbol, type, shares, price, total }
    this.parameters = {}; // 各銘柄の最適化された移動平均日数など
  }

  // ポートフォリオの総資産を計算する
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

  // 買い注文
  buy(symbol, shares, price) {
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

      this.recordHistory('BUY', symbol, shares, price);
      return true;
    }
    return false; // 資金不足
  }

  // 売り注文
  sell(symbol, shares, price) {
    if (this.portfolio[symbol] && this.portfolio[symbol].shares >= shares) {
      const revenue = shares * price;
      this.balance += revenue;
      this.portfolio[symbol].shares -= shares;

      if (this.portfolio[symbol].shares === 0) {
        delete this.portfolio[symbol];
      }

      this.recordHistory('SELL', symbol, shares, price);
      return true;
    }
    return false; // 株数不足
  }

  recordHistory(type, symbol, shares, price) {
    this.history.push({
      id: Date.now().toString() + Math.random().toString(),
      date: new Date().toISOString(),
      type,
      symbol,
      shares,
      price,
      total: shares * price
    });
  }

  // 移動平均を計算するヘルパー
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

  // 過去データから最適な短期・長期移動平均線を「学習」する（バックテスト）
  async optimizeParameters(symbol) {
    const data = await fetchStockData(symbol, '1y', '1d');
    if (data.length === 0) return;

    let bestProfit = -Infinity;
    let bestShort = 5;
    let bestLong = 20;

    const shortPeriods = [5, 10, 15];
    const longPeriods = [20, 30, 50];

    // 全ての組み合わせをテスト
    for (const short of shortPeriods) {
      for (const long of longPeriods) {
        if (short >= long) continue;

        let virtualBalance = 100000;
        let virtualShares = 0;

        const shortSma = this.calculateSMA(data, short);
        const longSma = this.calculateSMA(data, long);

        for (let i = long; i < data.length; i++) {
          const currentPrice = data[i].close;
          const prevShort = shortSma[i - 1];
          const prevLong = longSma[i - 1];
          const currShort = shortSma[i];
          const currLong = longSma[i];

          // ゴールデンクロス（買い）
          if (prevShort <= prevLong && currShort > currLong) {
            if (virtualBalance > currentPrice) {
              const sharesToBuy = Math.floor(virtualBalance / currentPrice);
              virtualBalance -= sharesToBuy * currentPrice;
              virtualShares += sharesToBuy;
            }
          }
          // デッドクロス（売り）
          else if (prevShort >= prevLong && currShort < currLong) {
            if (virtualShares > 0) {
              virtualBalance += virtualShares * currentPrice;
              virtualShares = 0;
            }
          }
        }
        
        // 最終的な評価額
        const finalValue = virtualBalance + (virtualShares > 0 ? virtualShares * data[data.length - 1].close : 0);
        
        if (finalValue > bestProfit) {
          bestProfit = finalValue;
          bestShort = short;
          bestLong = long;
        }
      }
    }

    this.parameters[symbol] = {
      shortSMA: bestShort,
      longSMA: bestLong,
      expectedProfitRate: ((bestProfit - 100000) / 100000) * 100
    };
    
    return this.parameters[symbol];
  }

  // 学習したパラメータを用いて現在状況を分析し、自動で売買判断を下す
  async checkAndTrade(symbol) {
    if (!this.parameters[symbol]) {
      await this.optimizeParameters(symbol);
    }
    const params = this.parameters[symbol];
    if (!params) return null; // データ不足等

    const data = await fetchStockData(symbol, '1y', '1d');
    if (data.length < params.longSMA) return null;

    const shortSma = this.calculateSMA(data, params.shortSMA);
    const longSma = this.calculateSMA(data, params.longSMA);

    const i = data.length - 1; // 最新日
    const currentPrice = data[i].close;
    const prevShort = shortSma[i - 1];
    const prevLong = longSma[i - 1];
    const currShort = shortSma[i];
    const currLong = longSma[i];

    let action = 'HOLD';

    if (prevShort <= prevLong && currShort > currLong) {
      // 買いシグナル
      const investAmount = this.balance * 0.2; // 資金の20%を投資
      if (investAmount >= currentPrice) {
        const sharesToBuy = Math.floor(investAmount / currentPrice);
        if (this.buy(symbol, sharesToBuy, currentPrice)) {
          action = 'BUY';
        }
      }
    } else if (prevShort >= prevLong && currShort < currLong) {
      // 売りシグナル
      if (this.portfolio[symbol] && this.portfolio[symbol].shares > 0) {
        const sharesToSell = this.portfolio[symbol].shares; // 全売却
        if (this.sell(symbol, sharesToSell, currentPrice)) {
          action = 'SELL';
        }
      }
    }

    return {
      symbol,
      action,
      currentPrice,
      shortSma: currShort,
      longSma: currLong
    };
  }
}
