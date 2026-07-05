import { YahooFinance } from 'yahoo-finance2';
const yahooFinance = new YahooFinance();
yahooFinance.quoteSummary('7203.T', { modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData'] })
  .then(console.log)
  .catch(console.error);
