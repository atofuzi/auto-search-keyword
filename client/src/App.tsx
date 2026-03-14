import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import './index.css';

const socket = io('http://localhost:3000');

interface Result {
  keyword: string;
  link?: string;
  [key: string]: string | undefined;
}

type Phase = 'input' | 'selection' | 'analysis' | 'complete';

function App() {
  // Phase management
  const [phase, setPhase] = useState<Phase>('input');
  const [baseKeyword, setBaseKeyword] = useState('');
  const [searchMode, setSearchMode] = useState<'yahoo' | 'google'>('yahoo');

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
  const [phase1Progress, setPhase1Progress] = useState({ current: 0, total: 0, label: '待機中' });
  const [phase2Progress, setPhase2Progress] = useState({ current: 0, total: 0, label: '待機中', etaSeconds: 0 });
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  // Error keywords that need manual review
  const [errorKeywords, setErrorKeywords] = useState<string[]>([]);

  // Pause Modal state
  const [pauseState, setPauseState] = useState<{ active: boolean, remainingSeconds: number, totalSeconds: number }>({ active: false, remainingSeconds: 0, totalSeconds: 0 });

  // Confirmation Modals
  const [showCacheConfirm, setShowCacheConfirm] = useState(false);
  const [showBlockModal, setShowBlockModal] = useState(false);

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
        setPhase1Progress({ current: 0, total: 0, label: 'サジェスト収集中...' });
      } else if (data.state === 'suggestions_done') {
        setIsRunning(false);
        setPhase('selection');
        setPhase1Progress(p => ({ ...p, label: '完了' }));
      } else if (data.state === 'analyzing') {
        console.log('[DEBUG] Setting isRunning to true');
        setIsRunning(true);
        setPhase('analysis');
        setPhase2Progress({ current: 0, total: 0, label: '分析中...', etaSeconds: 0 });
      } else if (data.state === 'finished') {
        setIsRunning(false);
        setPhase('complete');
        if (data.downloadUrl) setDownloadUrl(data.downloadUrl);
        setPhase2Progress(p => ({ ...p, label: '完了' }));
      }
    });

    socket.on('progress', (data: any) => {
      if (data.phase === 'suggestions') {
        setPhase1Progress({
          current: data.current || 0,
          total: data.total || 0,
          label: `サジェスト収集中... (${data.char}行) - ${data.count}件`
        });
      } else if (data.phase === 'analysis') {
        setPhase2Progress({
          current: data.current,
          total: data.total,
          label: `分析中: ${data.keyword} (${data.current}/${data.total})`,
          etaSeconds: data.etaSeconds || 0
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
      const allWords = Object.values(groups).flat();
      setAllSuggestions(allWords);
      setSelectedKeywords(new Set(allWords)); // Auto-select all
    });

    socket.on('totalKeywords', (total: number) => {
      setPhase1Progress(p => ({ ...p, total }));
    });

    socket.on('batchPause', (data: { active: boolean, remainingSeconds?: number, totalSeconds?: number }) => {
      setPauseState({
        active: data.active,
        remainingSeconds: data.remainingSeconds || 0,
        totalSeconds: data.totalSeconds || 1
      });
    });

    socket.on('blockDetected', () => {
      setShowBlockModal(true);
      setIsRunning(false);
    });

    socket.on('errorKeywords', (keywords: string[]) => {
      setErrorKeywords(prev => [...prev, ...keywords]);
    });

    return () => {
      socket.off('log');
      socket.off('status');
      socket.off('progress');
      socket.off('result');
      socket.off('totalKeywords');
      socket.off('suggestionList');
      socket.off('suggestionGroups');
      socket.off('batchPause');
      socket.off('blockDetected');
      socket.off('errorKeywords');
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
    socket.emit('getSuggestions', { keyword: baseKeyword, searchMode });
  };

  const handleStartAnalysisClick = () => {
    if (selectedKeywords.size === 0) return;
    setShowCacheConfirm(true);
  };

  const confirmStartAnalysis = (useCache: boolean) => {
    setShowCacheConfirm(false);
    socket.emit('startAnalysis', {
      keywords: Array.from(selectedKeywords),
      threshold,
      customWords,
      baseKeyword,
      useCache
    });
  };

  const handleStop = () => {
    socket.emit('stop');
    setIsRunning(false);
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

  const formatEta = (seconds: number) => {
    if (seconds <= 0) return '';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `(想定残り時間: ${m}分 ${s}秒)`;
  };

  // Add an error keyword manually to the rival-less results list
  const handleReset = () => {
    setPhase('input');
    setBaseKeyword('');
    setCustomWords('');
    setThreshold(3);
    setSearchMode('yahoo');
    setSuggestionGroups({});
    setAllSuggestions([]);
    setSelectedKeywords(new Set());
    setResults([]);
    setLogs([]);
    setDownloadUrl(null);
    setErrorKeywords([]);
    setPhase1Progress({ current: 0, total: 0, label: '待機中' });
    setPhase2Progress({ current: 0, total: 0, label: '待機中', etaSeconds: 0 });
  };

  const addErrorKeywordToResults = (keyword: string) => {
    const yahooLink = getYahooSearchUrl(keyword);
    const record: Result = { keyword, link: yahooLink };
    setResults(prev => [record, ...prev]);
    // Remove from error list
    setErrorKeywords(prev => prev.filter(k => k !== keyword));
  };

  const phase1Percent = phase1Progress.total > 0 && phase1Progress.current > 0
    ? (phase1Progress.current / phase1Progress.total) * 100
    : 0;

  const phase2Percent = phase2Progress.total > 0 && phase2Progress.current > 0
    ? (phase2Progress.current / phase2Progress.total) * 100
    : 0;

  return (
    <div className="container">
      <h1>Yahoo Rival-less Keyword Finder</h1>

      {/* Tool Description */}
      <div className="card" style={{ marginBottom: '2rem', fontSize: '0.9rem', color: '#cbd5e1' }}>
        <h3 style={{ marginTop: 0, marginBottom: '0.5rem', color: '#fff' }}>このツールの仕様</h3>
        <ul style={{ paddingLeft: '1.5rem', margin: 0, lineHeight: '1.6' }}>
          <li><strong>後方検索（Yahoo）</strong>: 「キーワード ＋ 五十音」で Yahoo サジェストを取得</li>
          <li><strong>前方検索（Google）</strong>: 「五十音 ＋ キーワード」で Google サジェストを取得</li>
          <li><strong>Phase 2</strong>: 収集したサジェストから分析対象を選択し、Yahoo でライバル記事数を調査します</li>
          <li>検索結果の最大取得ページは <strong>2ページ</strong> までです</li>
          <li>1回の検索ごとに1〜3秒のランダムな待機時間を設けます（ブロック対策）</li>
          <li>50件ごとにブラウザセッションを再構築します（休憩は15秒）</li>
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
              placeholder="例: 髪型"
              disabled={isRunning || phase !== 'input'}
            />
          </div>

          {/* 検索モード選択 */}
          <div className="input-group" style={{ flex: '1 1 100%' }}>
            <label>検索モード</label>
            <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', color: '#f8fafc', fontWeight: 'normal' }}>
                <input
                  type="radio"
                  name="searchMode"
                  value="yahoo"
                  checked={searchMode === 'yahoo'}
                  onChange={() => setSearchMode('yahoo')}
                  disabled={isRunning || phase !== 'input'}
                  style={{ accentColor: '#38bdf8', width: '16px', height: '16px' }}
                />
                <span>
                  <strong>後方検索（Yahoo）</strong>
                  <span style={{ fontSize: '0.8rem', color: '#94a3b8', marginLeft: '0.4rem' }}>例: 髪型 あ</span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', color: '#f8fafc', fontWeight: 'normal' }}>
                <input
                  type="radio"
                  name="searchMode"
                  value="google"
                  checked={searchMode === 'google'}
                  onChange={() => setSearchMode('google')}
                  disabled={isRunning || phase !== 'input'}
                  style={{ accentColor: '#34d399', width: '16px', height: '16px' }}
                />
                <span>
                  <strong>前方検索（Google）</strong>
                  <span style={{ fontSize: '0.8rem', color: '#94a3b8', marginLeft: '0.4rem' }}>例: あ 髪型</span>
                </span>
              </label>
            </div>
          </div>

          <div style={{ width: '100%', marginTop: '1rem' }}>
            {phase === 'input' ? (
              <button
                onClick={handleGetSuggestions}
                disabled={!baseKeyword || isRunning}
                style={{ width: '100%' }}
              >
                {searchMode === 'google' ? '🔍 Google で' : '🔍 Yahoo で'}サジェスト取得開始
              </button>
            ) : (
              <button disabled style={{ width: '100%', opacity: 0.5 }}>
                サジェスト取得済み（{searchMode === 'google' ? 'Google 前方検索' : 'Yahoo 後方検索'}）
              </button>
            )}
          </div>
        </div>

        {phase === 'input' && (
          <div className="progress-section">
            <div className="progress-label">
              <span>{phase1Progress.label}</span>
              <span>{Math.round(phase1Percent)}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-bar" style={{ width: `${phase1Percent}%` }}></div>
            </div>
          </div>
        )}
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
                  disabled={isRunning || phase !== 'selection'}
                  style={{ width: '60px', textAlign: 'center' }}
                />
                <span>記事以内</span>
              </div>
            </div>
          </div>

          {/* Keyword Selection Grid */}
          {(phase === 'selection' || phase === 'analysis' || phase === 'complete') && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h4 style={{ margin: 0 }}>
                  分析対象キーワード選択 ({selectedKeywords.size} / {allSuggestions.length})
                </h4>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button onClick={handleSelectAll} className="outline-btn" disabled={isRunning || phase !== 'selection'}>全選択</button>
                  <button onClick={handleUnselectAll} className="outline-btn" disabled={isRunning || phase !== 'selection'}>全解除</button>
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
                            disabled={isRunning || phase !== 'selection'}
                          />
                          <span>{word}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: '1.5rem', textAlign: 'center', display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                {!isRunning ? (
                  <>
                    <button
                      onClick={handleStartAnalysisClick}
                      disabled={selectedKeywords.size === 0}
                      style={{ padding: '1rem 3rem', fontSize: '1.1rem', backgroundColor: phase === 'analysis' || phase === 'complete' ? '#10b981' : undefined }}
                    >
                      {phase === 'analysis' || phase === 'complete' ? '▶️ 停止した分析を再開する' : `選択した ${selectedKeywords.size} 件で分析開始`}
                    </button>
                    {phase === 'complete' && (
                      <button
                        onClick={handleReset}
                        style={{ padding: '1rem 3rem', fontSize: '1.1rem', backgroundColor: '#475569' }}
                      >
                        🔄 新しいキーワードで始める
                      </button>
                    )}
                  </>
                ) : (
                  <button disabled style={{ padding: '1rem 3rem', fontSize: '1.1rem', opacity: 0.5 }}>
                    分析実行中...
                  </button>
                )}
              </div>
            </>
          )}

          {(phase === 'analysis' || phase === 'complete') && (
            <div className="progress-section" style={{ marginTop: '1rem' }}>
              <div className="progress-label">
                <span>{phase2Progress.label} {isRunning && phase2Progress.etaSeconds > 0 ? formatEta(phase2Progress.etaSeconds) : ''}</span>
                <span>{Math.round(phase2Percent)}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-bar" style={{ width: `${phase2Percent}%` }}></div>
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

      {/* Results Section — Rival-less Keywords */}
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

        <h2>分析結果 — ライバルレスキーワード ({results.length})</h2>
        <div className="results-grid">
          {results.map((r, i) => (
            <div key={i} className="result-card">
              <a
                href={r.link ?? getYahooSearchUrl(r.keyword)}
                target="_blank"
                rel="noreferrer"
                className="result-keyword"
              >
                {r.keyword}
              </a>
            </div>
          ))}
        </div>
        {results.length === 0 && !isRunning && (
          <div style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>
            結果はまだありません
          </div>
        )}
      </div>

      {/* Error Keywords Section — Manual Review */}
      {errorKeywords.length > 0 && (
        <div className="card" style={{ borderTop: '3px solid #f59e0b' }}>
          <h2 style={{ color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>⚠️</span> エラーキーワード（手動確認が必要） ({errorKeywords.length})
          </h2>
          <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: 0, marginBottom: '1rem' }}>
            分析中にエラーが発生しリトライしても失敗したキーワードです。Yahoo検索で手動確認し、ライバルレスであれば「ライバルレスに追加」ボタンを押してください。
          </p>
          <div className="results-grid">
            {errorKeywords.map((keyword, i) => (
              <div key={i} className="result-card" style={{ borderColor: '#f59e0b' }}>
                <a
                  href={getYahooSearchUrl(keyword)}
                  target="_blank"
                  rel="noreferrer"
                  className="result-keyword"
                >
                  {keyword}
                </a>
                <div style={{ marginTop: '0.75rem' }}>
                  <button
                    onClick={() => addErrorKeywordToResults(keyword)}
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.35rem 0.75rem',
                      backgroundColor: '#10b981',
                      borderColor: '#10b981',
                      width: '100%',
                    }}
                  >
                    ✅ ライバルレスに追加
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* System Logs */}
      <div className="card">
        <h3>システムログ</h3>
        <div className="logs" ref={logContainerRef}>
          {logs.map((log, i) => (
            <div key={i} className="log-entry">&gt; {log}</div>
          ))}
        </div>
      </div>

      {/* Cache Confirmation Modal */}
      {showCacheConfirm && (
        <div className="modal-overlay" style={{ zIndex: 10000 }}>
          <div className="modal-content" style={{ textAlign: 'center', maxWidth: '450px' }}>
            <h2 style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', color: '#10b981' }}>
              <span>💾</span> キャッシュの利用
            </h2>
            <p style={{ margin: '1rem 0' }}>
              前回分析したキーワードの履歴（キャッシュ）が存在する場合、そのデータを再利用して続きから開始できます。
            </p>
            <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '2rem' }}>
              ※初めからすべてやり直したい場合は、「キャッシュを削除してやり直す」を選択してください。
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <button
                onClick={() => confirmStartAnalysis(true)}
                style={{ padding: '0.75rem', fontSize: '1rem', backgroundColor: '#3b82f6', borderColor: '#3b82f6' }}
              >
                🔄 キャッシュを利用して再開する（推奨）
              </button>
              <button
                onClick={() => confirmStartAnalysis(false)}
                style={{ padding: '0.75rem', fontSize: '1rem', backgroundColor: '#ef4444', borderColor: '#ef4444' }}
              >
                🗑️ キャッシュを削除して最初からやり直す
              </button>
              <button
                onClick={() => setShowCacheConfirm(false)}
                className="outline-btn"
                style={{ padding: '0.75rem', fontSize: '1rem' }}
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Block Alert Modal */}
      {showBlockModal && (
        <div className="modal-overlay" style={{ zIndex: 10000 }}>
          <div className="modal-content" style={{ textAlign: 'center', maxWidth: '450px', borderTop: '4px solid #ef4444' }}>
            <h2 style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', color: '#ef4444' }}>
              <span>🚨</span> Yahooアクセス制限（IPブロック）エラー
            </h2>
            <p style={{ margin: '1rem 0', fontWeight: 'bold' }}>
              複数回の検索により、YahooからBotとして検知・ブロックされました。
            </p>

            <div style={{ textAlign: 'left', backgroundColor: '#1e293b', padding: '1.5rem', borderRadius: '8px', marginBottom: '1.5rem' }}>
              <h4 style={{ marginTop: 0, color: '#f8fafc' }}>【解決方法】IPアドレスを変更してください</h4>
              <ol style={{ paddingLeft: '1.2rem', margin: 0, color: '#cbd5e1', lineHeight: '1.7' }}>
                <li>スマートフォンのテザリングでPCをネットに繋ぎます</li>
                <li>スマホの<strong>「機内モードをON → OFF」</strong>にして新しいIPアドレスを取得します</li>
                <li>下記の「確認して閉じる」を押し、再度<strong>「▶️ 分析を再開する」</strong>をクリックしてください</li>
              </ol>
            </div>

            <p style={{ fontSize: '0.85rem', color: '#94a3b8', margin: '0 0 1.5rem 0' }}>
              ※キャッシュが有効なため、IP変更後に再開すれば中断したキーワードから瞬時に再開されます。
            </p>

            <button
              onClick={() => setShowBlockModal(false)}
              style={{ padding: '0.75rem 2rem', fontSize: '1rem', width: '100%' }}
            >
              確認して閉じる
            </button>
          </div>
        </div>
      )}

      {/* Pause Modal */}
      {pauseState.active && (
        <div className="modal-overlay" style={{ zIndex: 9999 }}>
          <div className="modal-content" style={{ textAlign: 'center', maxWidth: '400px' }}>
            <h2 style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', color: '#f59e0b' }}>
              <span>⏳</span> 一時休憩中
            </h2>
            <p style={{ margin: '1rem 0' }}>
              Yahooの制限を回避するため、安全機能が作動し一時待機しています。
            </p>

            <div style={{ fontSize: '2rem', fontWeight: 'bold', margin: '1.5rem 0', color: '#38bdf8' }}>
              残り {pauseState.remainingSeconds} 秒
            </div>

            <div className="progress-track" style={{ marginBottom: '2rem' }}>
              <div
                className="progress-bar"
                style={{
                  width: `${(pauseState.remainingSeconds / pauseState.totalSeconds) * 100}%`,
                  transition: 'width 1s linear',
                  backgroundColor: '#f59e0b'
                }}
              ></div>
            </div>

            <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '1rem' }}>
              ここで中止しても、次回はキャッシュから即座に続きから再開できます。
            </p>

            <button
              onClick={handleStop}
              className="stop-btn"
              style={{ padding: '0.75rem 2rem', fontSize: '1rem', backgroundColor: '#ef4444', borderColor: '#ef4444', width: '100%' }}
            >
              ⏹️ このまま終了する
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
