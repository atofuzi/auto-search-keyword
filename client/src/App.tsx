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
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0, label: 'Standard' });
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    socket.on('log', (msg: string) => {
      setLogs(prev => [...prev, msg]);
    });

    socket.on('status', (data: any) => {
      if (data.state === 'running') {
        setIsRunning(true);
        setLogs([]);
        setResults([]);
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
    socket.emit('start', { keyword, customWords });
  };

  const handleStop = () => {
    socket.emit('stop');
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
            <div key={i} className="result-card">
              <div className="result-keyword">{r.keyword}</div>
              <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                Top 1: {r.title_1.substring(0, 30)}...
              </div>
            </div>
          ))}
          {results.length === 0 && !isRunning && (
            <div style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>
              No results yet. Click START to begin.
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3>System Logs</h3>
        <div className="logs" ref={logContainerRef}>
          {logs.map((log, i) => (
            <div key={i} className="log-entry">&gt; {log}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
