import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchStockData, fetchCurrentPrice } from './yahoo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'db.json');

export class BotEngine {
  constructor(initialBalance = 500000) {
    this.initialBalance = initialBalance;
    this.balance = initialBalance;
    this.portfolio = {};
    this.history = [];
    this.parameters = {};
    this.logs = [];
    this.loadData();
  }

  loadData() {
    if (fs.existsSync(DB_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
        this.balance = data.balance ?? this.initialBalance;
        this.portfolio = data.portfolio ?? {};
        this.history = data.history ?? [];
        this.parameters = data.parameters ?? {};
        this.logs = data.logs ?? [];
        console.log('Data loaded from db.json');
      } catch (err) {
        console.error('Failed to load data', err);
      }
    }
  }

  saveData() {
    const data = {
      balance: this.balance,
      portfolio: this.portfolio,
      history: this.history,
      parameters: this.parameters,
      logs: this.logs.slice(0, 100) // 最新の100件のみ保存
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  }

  addLog(message) {
    const log = `[${new Date().toLocaleTimeString()}] ${message}`;
    this.logs.unshift(log);
    if (this.logs.length > 100) this.logs.pop();
    this.saveData();
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
      this.saveData();
      return true;
    }
    return false;
  }

  sell(symbol, shares, price) {
    if (this.portfolio[symbol] && this.portfolio[symbol].shares >= shares) {
      const revenue = shares * price;
      this.balance += revenue;
      this.portfolio[symbol].shares -= shares;

      if (this.portfolio[symbol].shares === 0) {
        delete this.portfolio[symbol];
      }

      this.recordHistory('SELL', symbol, shares, price);
      this.saveData();
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
    this.saveData();
    return this.parameters[symbol];
  }

  async checkAndTrade(symbol) {
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
        if (this.buy(symbol, sharesToBuy, currentPrice)) {
          action = 'BUY';
        }
      }
    } else if (prevShort >= prevLong && currShort < currLong) {
      if (this.portfolio[symbol] && this.portfolio[symbol].shares > 0) {
        const sharesToSell = this.portfolio[symbol].shares;
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
