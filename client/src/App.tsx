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
        setProgress({ current: 0, total: 0, label: 'Starting...' });
      } else if (data.state === 'idle') {
        setIsRunning(false);
        if (data.downloadUrl) setDownloadUrl(data.downloadUrl);
        setProgress(p => ({ ...p, label: 'Complete' }));
      }
    });

    socket.on('progress', (data: any) => {
      if (data.phase === 'suggestions') {
        setProgress({
          current: 0,
          total: 0,
          label: `Collecting Suggestions... (${data.char}) - Found: ${data.count}`
        });
      } else if (data.phase === 'analysis') {
        setProgress({
          current: data.current,
          total: data.total,
          label: `Analyzing: ${data.keyword} (${data.current}/${data.total})`
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
    alert('Copied prompt to clipboard! Now open Gemini and paste it.');
  };

  const progressPercent = progress.total > 0 && progress.current > 0
    ? (progress.current / progress.total) * 100
    : 0;

  return (
    <div className="container">
      <h1>Yahoo Rival-less Keyword Finder</h1>

      <div className="card">
        <div className="controls">
          <div className="input-group">
            <label>Base Keyword</label>
            <input
              type="text"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="e.g. ミラノオリンピック"
              disabled={isRunning}
            />
          </div>
          <div className="input-group">
            <label>Custom Check Words (Optional)</label>
            <input
              type="text"
              value={customWords}
              onChange={e => setCustomWords(e.target.value)}
              placeholder="e.g. ミラノ オリンピック"
              disabled={isRunning}
            />
          </div>
          <div className="input-group">
            <label>Rival Threshold (Default: 3)</label>
            <input
              type="number"
              value={threshold}
              onChange={e => setThreshold(Number(e.target.value))}
              min="0"
              max="20"
              disabled={isRunning}
            />
          </div>
          {!isRunning ? (
            <button onClick={handleStart} disabled={!keyword}>START SCRAPING</button>
          ) : (
            <button className="stop" onClick={handleStop}>STOP</button>
          )}
        </div>

        <div className="progress-section">
          <div className="progress-label">
            <span>{progress.label}</span>
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
            {isRunning ? 'Running...' : (downloadUrl ? 'Finished' : 'Ready')}
          </div>
          {downloadUrl && (
            <a href={`http://localhost:3000${downloadUrl}`} className="download-link" download>
              Downloads CSV
            </a>
          )}
        </div>

        <h2>Results ({results.length})</h2>
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
                Top 1: {r.title_1 ? r.title_1.substring(0, 30) + '...' : 'N/A'}
              </div>
              <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#38bdf8' }}>
                Click for AI Analysis &rarr;
              </div>
            </div>
          ))}
        </div>
        {results.length === 0 && !isRunning && (
          <div style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>
            No results yet. Click START to begin.
          </div>
        )}
      </div>

      {/* Suggestions List Card */}
      {
        suggestions.length > 0 && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3>Collected Suggestions ({suggestions.length})</h3>
              <button
                onClick={() => setShowSuggestions(!showSuggestions)}
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
              >
                {showSuggestions ? 'Hide' : 'Show'} List
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
        <h3>System Logs</h3>
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
                  1. Copy Prompt for Gemini
                </button>
                <a
                  href="https://gemini.google.com/app"
                  target="_blank"
                  rel="noreferrer"
                  className="button-link"
                >
                  2. Open Gemini
                </a>
              </div>

              <div className="result-details">
                <h3>Top Search Results</h3>
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
