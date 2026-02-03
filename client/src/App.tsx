import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import './index.css';

const socket = io('http://localhost:3000');

interface Result {
  keyword: string;
  [key: string]: string;
}

type Phase = 'input' | 'selection' | 'analysis' | 'complete';

function App() {
  // Phase management
  const [phase, setPhase] = useState<Phase>('input');
  const [baseKeyword, setBaseKeyword] = useState('');

  // Phase 2 inputs (shown after suggestions collected)
  const [customWords, setCustomWords] = useState('');
  const [threshold, setThreshold] = useState(3);

  // Suggestion state
  const [suggestionGroups, setSuggestionGroups] = useState<{ [key: string]: string[] }>({});
  const [allSuggestions, setAllSuggestions] = useState<string[]>([]);
  const [selectedKeywords, setSelectedKeywords] = useState<Set<string>>(new Set());

  // Analysis state
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0, label: '待機中' });
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  // Modal state
  const [selectedResult, setSelectedResult] = useState<Result | null>(null);

  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    socket.on('log', (msg: string) => {
      setLogs(prev => [...prev, msg]);
    });

    socket.on('status', (data: any) => {
      console.log('[DEBUG] Status event received:', data);
      if (data.state === 'collecting') {
        setIsRunning(true);
        setLogs([]);
        setProgress({ current: 0, total: 0, label: 'サジェスト収集中...' });
      } else if (data.state === 'suggestions_done') {
        setIsRunning(false);
        setPhase('selection');
        setProgress({ current: 0, total: 0, label: 'キーワード選択待ち' });
      } else if (data.state === 'analyzing') {
        console.log('[DEBUG] Setting isRunning to true');
        setIsRunning(true);
        setPhase('analysis');
        setProgress({ current: 0, total: 0, label: '分析中...' });
      } else if (data.state === 'finished') {
        setIsRunning(false);
        setPhase('complete');
        if (data.downloadUrl) setDownloadUrl(data.downloadUrl);
        setProgress(p => ({ ...p, label: '完了' }));
      }
    });

    socket.on('progress', (data: any) => {
      if (data.phase === 'suggestions') {
        setProgress({
          current: data.current || 0,
          total: data.total || 0,
          label: `サジェスト収集中... (${data.char}行) - ${data.count}件`
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
      setAllSuggestions(list);
      setSelectedKeywords(new Set(list)); // Auto-select all
    });

    socket.on('suggestionGroups', (groups: { [key: string]: string[] }) => {
      setSuggestionGroups(groups);
      // Flatten groups to get all suggestions
      const allWords = Object.values(groups).flat();
      setAllSuggestions(allWords);
      setSelectedKeywords(new Set(allWords)); // Auto-select all
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
      socket.off('suggestionList');
      socket.off('suggestionGroups');
    };
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleGetSuggestions = () => {
    if (!baseKeyword) return;
    socket.emit('getSuggestions', { keyword: baseKeyword });
  };

  const handleStartAnalysis = () => {
    if (selectedKeywords.size === 0) return;
    socket.emit('startAnalysis', {
      keywords: Array.from(selectedKeywords),
      threshold,
      customWords,
      baseKeyword
    });
  };

  const handleStop = () => {
    socket.emit('stop');
  };

  const handleSelectAll = () => {
    setSelectedKeywords(new Set(allSuggestions));
  };

  const handleUnselectAll = () => {
    setSelectedKeywords(new Set());
  };

  const toggleKeyword = (keyword: string) => {
    const newSet = new Set(selectedKeywords);
    if (newSet.has(keyword)) {
      newSet.delete(keyword);
    } else {
      newSet.add(keyword);
    }
    setSelectedKeywords(newSet);
  };

  // Generate Yahoo search URL with intitle for each word
  const getYahooSearchUrl = (keyword: string) => {
    const parts = keyword.split(/[\s|　]+/).filter(s => s.length > 0);
    const query = parts.map(p => `intitle:${p}`).join(' ');
    return `https://search.yahoo.co.jp/search?p=${encodeURIComponent(query)}`;
  };

  const progressPercent = progress.total > 0 && progress.current > 0
    ? (progress.current / progress.total) * 100
    : 0;

  return (
    <div className="container">
      <h1>Yahoo Rival-less Keyword Finder</h1>

      {/* Tool Description */}
      <div className="card" style={{ marginBottom: '2rem', fontSize: '0.9rem', color: '#cbd5e1' }}>
        <h3 style={{ marginTop: 0, marginBottom: '0.5rem', color: '#fff' }}>このツールの仕様</h3>
        <ul style={{ paddingLeft: '1.5rem', margin: 0, lineHeight: '1.6' }}>
          <li>検索エンジン：<strong>Yahoo! JAPAN</strong></li>
          <li><strong>Phase 1</strong>: 「狙っているワード」を入力してサジェストワードを収集します（五十音50音で検索）</li>
          <li><strong>Phase 2</strong>: 収集したサジェストから分析対象を選択し、ライバル記事数を調査します</li>
          <li>検索結果の最大取得ページは <strong>2ページ</strong> までです</li>
          <li>100件ごとに1分間の休憩を挟みます（ブロック対策）</li>
        </ul>
      </div>

      {/* Phase 1: Input */}
      <div className="card">
        <h3>Phase 1: サジェスト収集</h3>
        <div className="controls">
          <div className="input-group">
            <label>狙っているワード</label>
            <input
              type="text"
              value={baseKeyword}
              onChange={e => setBaseKeyword(e.target.value)}
              placeholder="例: ミラノオリンピック"
              disabled={isRunning || phase !== 'input'}
            />
          </div>
          <div style={{ width: '100%', marginTop: '1rem' }}>
            {phase === 'input' ? (
              <button
                onClick={handleGetSuggestions}
                disabled={!baseKeyword || isRunning}
                style={{ width: '100%' }}
              >
                サジェスト取得開始
              </button>
            ) : (
              <button disabled style={{ width: '100%', opacity: 0.5 }}>
                サジェスト取得済み
              </button>
            )}
          </div>
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

      {/* Phase 2: Selection */}
      {(phase === 'selection' || phase === 'analysis' || phase === 'complete') && (
        <div className="card">
          <h3>Phase 2: キーワード選択と分析</h3>

          {/* Phase 2 Inputs */}
          <div className="controls" style={{ marginBottom: '1.5rem' }}>
            <div className="input-group" style={{ flex: '1 1 100%' }}>
              <label>ライバル記事タイトルに含まれているかチェックしたいキーワード（オプション）</label>
              <p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: '0 0 0.5rem 0' }}>
                例）ミラノオリンピック → ミラノも対象にしたい場合は「ミラノ」と記載
              </p>
              <input
                type="text"
                value={customWords}
                onChange={e => setCustomWords(e.target.value)}
                placeholder="例: ミラノ オリンピック"
                disabled={phase !== 'selection'}
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
                  disabled={phase !== 'selection'}
                  style={{ width: '60px', textAlign: 'center' }}
                />
                <span>記事以内</span>
              </div>
            </div>
          </div>

          {/* Keyword Selection Grid */}
          {phase === 'selection' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h4 style={{ margin: 0 }}>
                  分析対象キーワード選択 ({selectedKeywords.size} / {allSuggestions.length})
                </h4>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button onClick={handleSelectAll} className="outline-btn">全選択</button>
                  <button onClick={handleUnselectAll} className="outline-btn">全解除</button>
                </div>
              </div>

              <div className="checkbox-grid-container">
                {Object.entries(suggestionGroups).map(([char, words]) => (
                  <div key={char} className="group-section">
                    <h4 className="group-title">{char}行</h4>
                    <div className="checkbox-grid">
                      {words.map(word => (
                        <label
                          key={word}
                          className={`checkbox-item ${selectedKeywords.has(word) ? 'checked' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedKeywords.has(word)}
                            onChange={() => toggleKeyword(word)}
                          />
                          <span>{word}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
                <button
                  onClick={handleStartAnalysis}
                  disabled={selectedKeywords.size === 0 || isRunning}
                  style={{ padding: '1rem 3rem', fontSize: '1.1rem' }}
                >
                  選択した {selectedKeywords.size} 件で分析開始
                </button>
              </div>
            </>
          )}

          {(phase === 'analysis' || phase === 'complete') && (
            <div className="progress-section" style={{ marginTop: '1rem' }}>
              <div className="progress-label">
                <span>{progress.label}</span>
                <span>{Math.round(progressPercent)}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-bar" style={{ width: `${progressPercent}%` }}></div>
              </div>
              {isRunning && (
                <div style={{ marginTop: '1rem', textAlign: 'center' }}>
                  <button
                    onClick={handleStop}
                    className="stop-btn"
                    style={{ padding: '0.75rem 2rem', fontSize: '1rem', backgroundColor: '#ef4444', borderColor: '#ef4444' }}
                  >
                    ⏹️ 停止
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Results Section */}
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
              <a
                href={getYahooSearchUrl(r.keyword)}
                target="_blank"
                rel="noreferrer"
                className="result-keyword"
                onClick={(e) => e.stopPropagation()}
              >
                {r.keyword}
              </a>
              <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: '0.5rem' }}>
                Top 1: {r.title_1 ? r.title_1.substring(0, 30) + '...' : 'なし'}
              </div>
              <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#38bdf8' }}>
                クリックして詳細を確認 →
              </div>
            </div>
          ))}
        </div>
        {results.length === 0 && !isRunning && (
          <div style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>
            結果はまだありません
          </div>
        )}
      </div>

      {/* System Logs */}
      <div className="card">
        <h3>システムログ</h3>
        <div className="logs" ref={logContainerRef}>
          {logs.map((log, i) => (
            <div key={i} className="log-entry">&gt; {log}</div>
          ))}
        </div>
      </div>

      {/* Detail Modal */}
      {selectedResult && (
        <div className="modal-overlay" onClick={() => setSelectedResult(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <button className="close-btn" onClick={() => setSelectedResult(null)}>&times;</button>

            <h2>{selectedResult.keyword}</h2>

            <div className="modal-actions">
              <a
                href={getYahooSearchUrl(selectedResult.keyword)}
                target="_blank"
                rel="noreferrer"
                className="button-link"
              >
                Yahoo検索で確認 (intitle検索)
              </a>
            </div>

            <div className="result-details">
              <h3>上位の検索結果</h3>
              {[1, 2, 3, 4, 5].map(num => {
                const title = selectedResult[`title_${num}`];
                const url = selectedResult[`url_${num}`];
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
      )}
    </div>
  );
}

export default App;
