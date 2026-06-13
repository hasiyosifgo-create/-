/**
 * Yahoo Finance APIから株価データを取得するユーティリティ
 * vite.config.js の proxy 経由でリクエストを行う
 */

export const fetchStockData = async (symbol, range = '1y', interval = '1d') => {
  try {
    const response = await fetch(`/api/yahoo/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch data for ${symbol}`);
    }
    const data = await response.json();
    const result = data.chart.result[0];
    
    const timestamps = result.timestamp;
    const quotes = result.indicators.quote[0];
    
    // { time, open, high, low, close, volume } の形式に整形
    const formattedData = timestamps.map((timestamp, index) => ({
      time: timestamp * 1000,
      open: quotes.open[index],
      high: quotes.high[index],
      low: quotes.low[index],
      close: quotes.close[index],
      volume: quotes.volume[index],
    })).filter(item => item.close !== null); // 欠損値を除去
    
    return formattedData;
  } catch (error) {
    console.error("Error fetching stock data:", error);
    return [];
  }
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
