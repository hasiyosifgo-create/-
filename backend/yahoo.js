import fs from 'fs';

export const fetchStockData = async (symbol, range = '1y', interval = '1d') => {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch data for ${symbol}`);
    }
    const data = await response.json();
    const result = data.chart.result[0];
    
    const timestamps = result.timestamp;
    const quotes = result.indicators.quote[0];
    
    const formattedData = timestamps.map((timestamp, index) => ({
      time: timestamp * 1000,
      open: quotes.open[index],
      high: quotes.high[index],
      low: quotes.low[index],
      close: quotes.close[index],
      volume: quotes.volume[index],
    })).filter(item => item.close !== null);
    
    return formattedData;
  } catch (error) {
    console.error("Error fetching stock data:", error);
    return [];
  }
};

export const calculateVWAP = (data) => {
  if (!data || data.length === 0) return null;
  
  // 直近の日付（今日）のデータだけで計算する
  const lastItem = data[data.length - 1];
  const lastDate = new Date(lastItem.time).toDateString();
  
  let cumulativePV = 0;
  let cumulativeV = 0;
  
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    const itemDate = new Date(item.time).toDateString();
    // 今日のデータに絞る
    if (itemDate === lastDate) {
      const typicalPrice = (item.high + item.low + item.close) / 3;
      cumulativePV += typicalPrice * item.volume;
      cumulativeV += item.volume;
    }
  }
  
  if (cumulativeV === 0) return null;
  return cumulativePV / cumulativeV;
};

export const fetchCurrentPrice = async (symbol) => {
  try {
    const data = await fetchStockData(symbol, '5d', '1d');
    if (data && data.length > 0) {
      return data[data.length - 1].close;
    }
    return null;
  } catch (error) {
    console.error("Error fetching current price:", error);
    return null;
  }
};

export const fetchNews = async (symbol) => {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=5`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch news for ${symbol}`);
    }
    const data = await response.json();
    if (data.news && data.news.length > 0) {
      return data.news.map(item => item.title);
    }
    return [];
  } catch (error) {
    console.error("Error fetching news:", error);
    return [];
  }
};
