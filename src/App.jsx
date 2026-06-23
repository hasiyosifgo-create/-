import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { TrendingUp, Activity, History, DollarSign, BrainCircuit, Play, Pause } from 'lucide-react';
import './index.css';

function App() {
  const [status, setStatus] = useState(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (err) {
      console.error("Failed to fetch status", err);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000); // 3秒ごとに状況更新
    return () => clearInterval(interval);
  }, []);

  const toggleBot = async () => {
    try {
      const res = await fetch('/api/toggle', { method: 'POST' });
      if (res.ok) {
        fetchStatus();
      }
    } catch (err) {
      console.error("Failed to toggle bot", err);
    }
  };

  if (!status) return <div className="app-container"><div className="loader"></div> サーバーに接続中...</div>;

  const profit = status.totalAssets - status.initialBalance;
  const profitColor = profit >= 0 ? 'value-positive' : 'value-negative';

  return (
    <div className="app-container">
      <header className="header">
        <h1><TrendingUp size={28} /> AntiGravity TradeBot AI</h1>
        <div className="bot-status">
          <Activity size={18} />
          {status.isRunning ? '稼働中 (クラウドで自動運用中)' : '停止中'}
        </div>
      </header>

      {status.dbError && (
        <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.2)', border: '1px solid #ef4444', color: '#fca5a5', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
          <strong>⚠️ データベース接続エラー</strong><br />
          現在MongoDBへの接続に失敗しており、BOTが「一時メモリモード」で動いています。この状態だと15分ごとにデータ（資産や保有株）がリセットされて消えてしまいます。<br />
          MongoDBの管理画面で「Network Access」が <code>0.0.0.0/0</code> に設定されているか、またはRenderの <code>MONGODB_URI</code> が間違っていないか確認してください。
        </div>
      )}

      <div className="dashboard-grid">
        <div className="panel">
          <h2><DollarSign size={20} /> 総資産</h2>
          <div className="value-large">¥{status.totalAssets.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
          <div className={`text-muted ${profitColor}`}>
            損益: {profit >= 0 ? '+' : ''}¥{profit.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            ({((profit / status.initialBalance) * 100).toFixed(2)}%)
          </div>
          <div style={{ marginTop: '1rem', padding: '0.75rem', backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: '8px', fontSize: '0.9rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
              <span className="text-muted">現金残高 (買付余力):</span>
              <span style={{ fontWeight: 500 }}>¥{status.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-muted">株式評価額:</span>
              <span style={{ fontWeight: 500 }}>¥{(status.totalAssets - status.balance).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
          </div>
          <button 
            className="btn" 
            style={{ marginTop: '1.5rem', width: '100%', justifyContent: 'center' }}
            onClick={toggleBot}
          >
            {status.isRunning ? <><Pause size={18} /> 自動取引を停止</> : <><Play size={18} /> 自動取引を開始</>}
          </button>
        </div>

        <div className="panel" style={{ gridColumn: 'span 2' }}>
          <h2><Activity size={20} /> 資産推移</h2>
          <div style={{ width: '100%', height: '200px' }}>
            <ResponsiveContainer>
              <LineChart data={status.assetHistory || []}>
                <XAxis dataKey="time" stroke="#94a3b8" fontSize={12} />
                <YAxis domain={['auto', 'auto']} stroke="#94a3b8" fontSize={12} width={80} tickFormatter={(val) => `¥${val.toLocaleString()}`} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', border: 'none', borderRadius: '8px' }}
                  itemStyle={{ color: '#f8fafc' }}
                />
                <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={3} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel">
          <h2><BrainCircuit size={20} /> 保有銘柄ポートフォリオ</h2>
          {Object.keys(status.portfolio).length === 0 ? (
            <div className="text-muted" style={{ padding: '2rem 0', textAlign: 'center' }}>
              現在保有している銘柄はありません。
            </div>
          ) : (
            <table className="history-table">
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>保有数</th>
                  <th>平均取得単価</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(status.portfolio).map(symbol => {
                  const companyName = status.symbolsMap?.[symbol]?.name || symbol;
                  return (
                    <tr key={symbol}>
                      <td style={{ fontWeight: 600 }}>
                        {companyName} <br />
                        <span className="text-muted" style={{ fontSize: '0.8rem', fontWeight: 'normal' }}>{symbol}</span>
                      </td>
                      <td>{status.portfolio[symbol].shares} 株</td>
                      <td>¥{status.portfolio[symbol].averagePrice.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel" style={{ maxHeight: '300px', overflowY: 'auto' }}>
          <h2><Activity size={20} /> AI アクションログ (サーバー)</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.85rem' }}>
            {status.logs.map((log, i) => (
              <div key={i} style={{ color: log.includes('BUY') || log.includes('SELL') ? '#f8fafc' : '#94a3b8', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '0.3rem' }}>
                {log}
              </div>
            ))}
            {status.logs.length === 0 && <div className="text-muted">ログはありません</div>}
          </div>
        </div>

        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2><BrainCircuit size={20} /> AI 学習・分析レポート</h2>
          <div style={{ backgroundColor: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '8px', whiteSpace: 'pre-wrap', fontSize: '0.9rem', lineHeight: '1.6' }}>
            {status.learningReport || '現在データを収集中です。日本市場が閉まった後（15:00以降）に最初の学習レポートが生成されます。'}
          </div>
        </div>

        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2><History size={20} /> 取引履歴</h2>
          {status.history.length === 0 ? (
            <div className="text-muted" style={{ padding: '2rem 0', textAlign: 'center' }}>
              まだ取引履歴がありません。
            </div>
          ) : (
            <table className="history-table">
              <thead>
                <tr>
                  <th>日時</th>
                  <th>種別</th>
                  <th>銘柄</th>
                  <th>株数</th>
                  <th>単価</th>
                  <th>総額</th>
                  <th>確定損益 (税引後)</th>
                </tr>
              </thead>
              <tbody>
                {status.history.map((item) => {
                  const companyName = status.symbolsMap?.[item.symbol]?.name || item.symbol;
                  return (
                    <tr key={item.id}>
                      <td>{new Date(item.date).toLocaleString()}</td>
                      <td>
                        <span className={`badge ${item.type.toLowerCase()}`}>{item.type}</span>
                      </td>
                      <td style={{ fontWeight: 600 }}>
                        {companyName} <br />
                        <span className="text-muted" style={{ fontSize: '0.8rem', fontWeight: 'normal' }}>{item.symbol}</span>
                      </td>
                      <td>{item.shares}</td>
                      <td>¥{item.price.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                      <td>¥{item.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                      <td 
                        style={{ fontWeight: 600, color: item.profitLoss > 0 ? '#10b981' : (item.profitLoss < 0 ? '#ef4444' : 'inherit') }}
                        title={item.tax > 0 ? `源泉徴収税: -¥${item.tax.toLocaleString()}` : ''}
                      >
                        {item.type !== 'BUY' && item.profitLoss !== undefined ? (
                          <>
                            {item.profitLoss > 0 ? '+' : ''}¥{item.profitLoss.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            {item.tax > 0 && <span style={{fontSize:'0.7rem', color:'#94a3b8', display:'block'}}>税: -¥{item.tax.toLocaleString()}</span>}
                          </>
                        ) : '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
