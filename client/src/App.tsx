import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import './index.css';

const socket = io('http://localhost:3000');

interface Result {
  keyword: string;
  [key: string]: string;
}

function App() {
  const [keyword, setKeyword] = useState('');
  const [customWords, setCustomWords] = useState('');
  const [threshold, setThreshold] = useState(3);
  // Verification Mode is now env var only
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, label: 'Standard' });
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  // Modal State
  const [selectedResult, setSelectedResult] = useState<Result | null>(null);

  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    socket.on('log', (msg: string) => {
      setLogs(prev => [...prev, msg]);
    });

    socket.on('status', (data: any) => {
      if (data.state === 'running') {
        setIsRunning(true);
        setIsRunning(true);
        setLogs([]);
        setResults([]);
        setSuggestions([]);
        setShowSuggestions(false);
        setDownloadUrl(null);
        setProgress({ current: 0, total: 0, label: '開始中...' });
      } else if (data.state === 'idle') {
        setIsRunning(false);
        if (data.downloadUrl) setDownloadUrl(data.downloadUrl);
        setProgress(p => ({ ...p, label: '完了' }));
      }
    });

    socket.on('progress', (data: any) => {
      if (data.phase === 'suggestions') {
        setProgress({
          current: 0,
          total: 0,
          label: `サジェスト収集中... (${data.char}) - 発見数: ${data.count}`
        });
      } else if (data.phase === 'analysis') {
        setProgress({
          current: data.current,
          total: data.total,
          label: `分析中: ${data.keyword} (${data.current}/${data.total})`
        });
      }
    });

    socket.on('result', (result: Result) => {
      setResults(prev => [result, ...prev]);
    });

    socket.on('suggestionList', (list: string[]) => {
      setSuggestions(list);
    });

    socket.on('totalKeywords', (total: number) => {
      setProgress(p => ({ ...p, total }));
    });

    return () => {
      socket.off('log');
      socket.off('status');
      socket.off('progress');
      socket.off('result');
      socket.off('totalKeywords');
    };
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleStart = () => {
    if (!keyword) return;
    socket.emit('start', { keyword, customWords, threshold });
  };

  const handleStop = () => {
    socket.emit('stop');
  };

  // Generate Prompt
  const generatePrompt = (r: Result) => {
    let prompt = `キーワード「${r.keyword}」について記事を書きたいです。\n以下は現在の上位記事のタイトルです。\n\n`;
    for (let i = 1; i <= 5; i++) {
      if (r[`title_${i}`]) {
        prompt += `${i}. ${r[`title_${i}`]}\n`;
      }
    }
    prompt += `\nこれらを踏まえて、検索意図を満たしつつ、差別化できる記事構成案（タイトル案・見出し構成）を作成してください。`;
    return prompt;
  };

  const handleCopyPrompt = (r: Result) => {
    const prompt = generatePrompt(r);
    navigator.clipboard.writeText(prompt);
    alert('Gemini用のプロンプトをコピーしました！Geminiを開いて貼り付けてください。');
  };

  const progressPercent = progress.total > 0 && progress.current > 0
    ? (progress.current / progress.total) * 100
    : 0;

  return (
    <div className="container">
      <h1>Yahoo Rival-less Keyword Finder</h1>

      <div className="card" style={{ marginBottom: '2rem', fontSize: '0.9rem', color: '#cbd5e1' }}>
        <h3 style={{ marginTop: 0, marginBottom: '0.5rem', color: '#fff' }}>このツールの仕様</h3>
        <ul style={{ paddingLeft: '1.5rem', margin: 0, lineHeight: '1.6' }}>
          <li>検索エンジン：<strong>Yahoo! JAPAN</strong></li>
          <li><strong>Step 1</strong>: 「狙っているワード」+「あいうえお（五十音）」検索で、虫眼鏡のサジェストワードを自動収集します。</li>
          <li><strong>Step 2</strong>: 「狙っているワード」+「サジェストワード」で検索し、ライバル記事の数（すべてのキーワードがタイトルに含まれる記事数）を調査します。</li>
          <li>検索結果の最大取得ページは <strong>2ページ</strong> までです。</li>
        </ul>
      </div>

      <div className="card">
        <div className="controls">
          <div className="input-group">
            <label>狙っているワード</label>
            <input
              type="text"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="例: ミラノオリンピック"
              disabled={isRunning}
            />
          </div>
          <div className="input-group" style={{ flex: '1 1 100%' }}>
            <label>ライバル記事タイトルに含まれているかチェックしたいキーワード（オプション）</label>
            <p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: '0 0 0.5rem 0' }}>例）ミラノオリンピック → ミラノも対象にしたい場合は「ミラノ」と記載</p>
            <input
              type="text"
              value={customWords}
              onChange={e => setCustomWords(e.target.value)}
              placeholder="例: ミラノ オリンピック"
              disabled={isRunning}
            />
          </div>
          <div className="input-group" style={{ flex: '1 1 100%' }}>
            <label>ライバルレス判定基準</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f8fafc' }}>
              <span>すべてのキーワードがタイトルに含まれる記事が</span>
              <input
                type="number"
                value={threshold}
                onChange={e => setThreshold(Number(e.target.value))}
                min="0"
                max="20"
                disabled={isRunning}
                style={{ width: '60px', textAlign: 'center' }}
              />
              <span>記事以内</span>
            </div>
          </div>
          <div style={{ width: '100%', marginTop: '1rem' }}>
            {!isRunning ? (
              <button onClick={handleStart} disabled={!keyword} style={{ width: '100%' }}>実行</button>
            ) : (
              <button className="stop" onClick={handleStop} style={{ width: '100%' }}>停止</button>
            )}
          </div>
        </div>

        <div className="progress-section">
          <div className="progress-label">
            <span>{progress.label === 'Standard' ? '待機中' : progress.label}</span>
            <span>{Math.round(progressPercent)}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-bar" style={{ width: `${progressPercent}%` }}></div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="status-bar">
          <div className="status-indicator">
            <span className={`status-dot ${isRunning ? 'active' : ''}`}></span>
            {isRunning ? '実行中...' : (downloadUrl ? '完了' : '準備完了')}
          </div>
          {downloadUrl && (
            <a href={`http://localhost:3000${downloadUrl}`} className="download-link" download>
              CSVをダウンロード
            </a>
          )}
        </div>

        <h2>分析結果 ({results.length})</h2>
        <div className="results-grid">
          {results.map((r, i) => (
            <div
              key={i}
              className="result-card"
              onClick={() => setSelectedResult(r)}
              style={{ cursor: 'pointer' }}
            >
              <div className="result-keyword">{r.keyword}</div>
              <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                Top 1: {r.title_1 ? r.title_1.substring(0, 30) + '...' : 'なし'}
              </div>
              <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#38bdf8' }}>
                クリックしてAI分析 &rarr;
              </div>
            </div>
          ))}
        </div>
        {results.length === 0 && !isRunning && (
          <div style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>
            結果はまだありません。「実行」ボタンを押して開始してください。
          </div>
        )}
      </div>

      {/* Suggestions List Card */}
      {
        suggestions.length > 0 && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3>取得した関連キーワード ({suggestions.length})</h3>
              <button
                onClick={() => setShowSuggestions(!showSuggestions)}
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
              >
                {showSuggestions ? 'リストを隠す' : 'リストを表示'}
              </button>
            </div>

            {showSuggestions && (
              <div className="keyword-list" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', maxHeight: '300px', overflowY: 'auto' }}>
                {suggestions.map((k, i) => (
                  <span key={i} style={{
                    background: '#334155',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '0.8rem',
                    color: '#e2e8f0',
                    border: '1px solid #475569'
                  }}>
                    {k}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      }

      <div className="card">
        <h3>システムログ</h3>
        <div className="logs" ref={logContainerRef}>
          {logs.map((log, i) => (
            <div key={i} className="log-entry">&gt; {log}</div>
          ))}
        </div>
      </div>

      {/* Detail Modal */}
      {
        selectedResult && (
          <div className="modal-overlay" onClick={() => setSelectedResult(null)}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
              <button className="close-btn" onClick={() => setSelectedResult(null)}>&times;</button>

              <h2>{selectedResult.keyword}</h2>

              <div className="modal-actions">
                <button onClick={() => handleCopyPrompt(selectedResult)} style={{ marginRight: '1rem' }}>
                  1. Gemini用プロンプトをコピー
                </button>
                <a
                  href="https://gemini.google.com/app"
                  target="_blank"
                  rel="noreferrer"
                  className="button-link"
                >
                  2. Geminiを開く
                </a>
              </div>

              <div className="result-details">
                <h3>上位の検索結果</h3>
                {[1, 2, 3, 4, 5].map(num => {
                  const title = selectedResult[`title_${num}`];
                  const url = selectedResult[`url_${num}`]; // Raw URL
                  if (!title) return null;
                  return (
                    <div key={num} className="detail-item">
                      <span className="rank-badge">{num}</span>
                      <div className="detail-content">
                        <div className="detail-title">{title}</div>
                        {url && (
                          <a href={url} target="_blank" rel="noreferrer" className="detail-link">
                            {url}
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )
      }
    </div >
  );
}

export default App;
