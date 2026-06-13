import { fetchStockData, fetchCurrentPrice } from './yahoo.js';
import { BotState } from './db.js';

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

  async buy(symbol, shares, price) {
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
      await this.saveData();
      return true;
    }
    return false;
  }

  async sell(symbol, shares, price) {
    if (this.portfolio[symbol] && this.portfolio[symbol].shares >= shares) {
      const revenue = shares * price;
      this.balance += revenue;
      this.portfolio[symbol].shares -= shares;

      if (this.portfolio[symbol].shares === 0) {
        delete this.portfolio[symbol];
      }

      this.recordHistory('SELL', symbol, shares, price);
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

  async optimizeParameters(symbol) {
    const data = await fetchStockData(symbol, '1y', '1d');
    if (data.length === 0) return;

    let bestProfit = -Infinity;
    let bestShort = 5;
    let bestLong = 20;

    const shortPeriods = [5, 10, 15];
    const longPeriods = [20, 30, 50];

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

          if (prevShort <= prevLong && currShort > currLong) {
            if (virtualBalance > currentPrice) {
              const sharesToBuy = Math.floor(virtualBalance / currentPrice);
              virtualBalance -= sharesToBuy * currentPrice;
              virtualShares += sharesToBuy;
            }
          } else if (prevShort >= prevLong && currShort < currLong) {
            if (virtualShares > 0) {
              virtualBalance += virtualShares * currentPrice;
              virtualShares = 0;
            }
          }
        }
        
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
    await this.saveData();
    return this.parameters[symbol];
  }

  async checkAndTrade(symbol) {
    if (!this.isReady) return null;

    if (!this.parameters[symbol]) {
      await this.optimizeParameters(symbol);
    }
    const params = this.parameters[symbol];
    if (!params) return null;

    const data = await fetchStockData(symbol, '1y', '1d');
    if (data.length < params.longSMA) return null;

    const shortSma = this.calculateSMA(data, params.shortSMA);
    const longSma = this.calculateSMA(data, params.longSMA);

    const i = data.length - 1;
    const currentPrice = data[i].close;
    const prevShort = shortSma[i - 1];
    const prevLong = longSma[i - 1];
    const currShort = shortSma[i];
    const currLong = longSma[i];

    let action = 'HOLD';

    if (prevShort <= prevLong && currShort > currLong) {
      const investAmount = this.balance * 0.2;
      if (investAmount >= currentPrice) {
        const sharesToBuy = Math.floor(investAmount / currentPrice);
        if (await this.buy(symbol, sharesToBuy, currentPrice)) {
          action = 'BUY';
        }
      }
    } else if (prevShort >= prevLong && currShort < currLong) {
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
      longSma: currLong
    };
  }
}
