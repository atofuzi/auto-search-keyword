import { YahooScraper } from './yahoo';
import { GoogleScraper } from './google';
import { HIRAGANA_LIST, sleep } from './utils';
import { isRivalLess } from './analyzer';
import { createObjectCsvWriter } from 'csv-writer';
import * as path from 'path';
import * as fs from 'fs';
import { Server } from 'socket.io'; // Or just EventEmitter
import { logger, isDebugEnabled } from './logger';

// Define event types if needed, but for now we interact via Socket directly or callbacks
// Using a class that takes a socket instance to emit events

export class ScraperService {
    private scraper: YahooScraper;
    private googleScraper: GoogleScraper;
    private isRunning: boolean = false;
    private currentBaseKeyword: string = '';
    private searchCache: { [keyword: string]: any } = {};

    constructor() {
        this.scraper = new YahooScraper();
        this.googleScraper = new GoogleScraper();
        // Cache is loaded lazily when analysis starts for a specific base keyword
    }

    private getCacheFilePath(baseKeyword: string): string {
        // Sanitize base keyword for use in filename
        const safe = baseKeyword.replace(/[\s/\\:*?"<>|　]+/g, '_').replace(/^_+|_+$/g, '');
        return path.resolve(process.cwd(), `cache_${safe}.json`);
    }

    private loadCache(baseKeyword: string) {
        this.currentBaseKeyword = baseKeyword;
        this.searchCache = {};
        try {
            const filePath = this.getCacheFilePath(baseKeyword);
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf-8');
                this.searchCache = JSON.parse(data);
                logger.info(`[Cache] Loaded ${Object.keys(this.searchCache).length} entries for "${baseKeyword}" from ${path.basename(filePath)}`);
            } else {
                logger.info(`[Cache] No existing cache for "${baseKeyword}". Starting fresh.`);
            }
        } catch (e) {
            logger.error('Failed to load cache', e);
        }
    }

    private saveCache() {
        if (!this.currentBaseKeyword) return;
        try {
            const filePath = this.getCacheFilePath(this.currentBaseKeyword);
            fs.writeFileSync(filePath, JSON.stringify(this.searchCache, null, 2), 'utf-8');
        } catch (e) {
            logger.error('Failed to save cache', e);
        }
    }

    /**
     * Build Yahoo search URL with intitle: for each keyword part
     */
    private buildYahooSearchUrl(keyword: string, baseKeyword: string): string {
        // Split the full keyword (e.g. "wbc 選手") into intitle: parts.
        // Yahoo suggestions already include the base keyword, so no need to
        // re-add it separately (which caused case-duplication like intitle:WBC intitle:wbc).
        const parts = keyword.trim().split(/[\s|\u3000]+/).filter((s: string) => s.length > 0);
        const query = parts.map((p: string) => `intitle:${p}`).join(' ');
        return `https://search.yahoo.co.jp/search?p=${encodeURIComponent(query)}`;
    }

    async stop() {
        this.isRunning = false;
        await this.scraper.close();
    }

    /**
     * Phase 1: Collect suggestions only and group by Hiragana character
     */
    async getSuggestionsOnly(
        baseKeyword: string,
        socket: any,
        verificationMode: boolean = false,
        searchMode: 'yahoo' | 'google' = 'yahoo'
    ) {
        if (this.isRunning) return;
        this.isRunning = true;

        const isGoogle = searchMode === 'google';

        try {
            socket.emit('status', { state: 'collecting', message: `Collecting suggestions for: "${baseKeyword}" (${isGoogle ? 'Google 前方検索' : 'Yahoo 後方検索'})` });

            if (isGoogle) {
                await this.googleScraper.init(false);
            } else {
                await this.scraper.init(false);
            }

            const chars_to_check = verificationMode ? HIRAGANA_LIST.slice(0, 10) : HIRAGANA_LIST;
            const groupedSuggestions: { [key: string]: string[] } = {};
            const uniqueKeywords = new Set<string>();
            const totalChars = chars_to_check.length;

            for (let i = 0; i < chars_to_check.length; i++) {
                const char = chars_to_check[i];
                if (!this.isRunning) break;

                // Google: {ひらがな} {キーワード}、Yahoo: {キーワード} {ひらがな}
                const suggestions = isGoogle
                    ? await this.googleScraper.getSuggestions(char, baseKeyword)
                    : await this.scraper.getSuggestions(baseKeyword, char);

                socket.emit('progress', {
                    phase: 'suggestions',
                    char,
                    count: suggestions.length,
                    current: i + 1,
                    total: totalChars
                });

                const newWords: string[] = [];
                for (const s of suggestions) {
                    if (!uniqueKeywords.has(s)) {
                        uniqueKeywords.add(s);
                        newWords.push(s);
                    }
                }

                if (newWords.length > 0) {
                    groupedSuggestions[char] = newWords;
                }
            }

            socket.emit('log', `Total unique keywords found: ${uniqueKeywords.size}`);
            socket.emit('totalKeywords', uniqueKeywords.size);
            socket.emit('suggestionList', Array.from(uniqueKeywords));
            socket.emit('suggestionGroups', groupedSuggestions);
            socket.emit('status', { state: 'suggestions_done', message: 'Suggestions collected' });

        } catch (err) {
            logger.error('Error collecting suggestions', err);
            socket.emit('error', `Error collecting suggestions: ${err}`);
            socket.emit('status', { state: 'idle', message: 'Error' });
        } finally {
            if (isGoogle) {
                await this.googleScraper.close();
            } else {
                // Yahoo scraper は analyzeKeywords でも共有するため close しない
            }
            this.isRunning = false;
        }
    }

    /**
     * Process a single keyword and return success status
     */
    private async processKeyword(
        keyword: string,
        baseKeyword: string,
        customCheckWords: string[],
        threshold: number,
        socket: any,
        csvWriter: any,
        rivalLessKeywords: any[]
    ): Promise<'success' | 'blocked' | 'retry' | 'skip'> {
        try {
            // Step 1: Search with base keyword + suggestion keyword
            const queryParts: string[] = [];

            // Add base keyword
            const baseParts = baseKeyword.split(/[\s|　]+/).filter((s: string) => s.length > 0);

            // Build search query: use the full keyword split into intitle: parts.
            // Yahoo suggestions already include the base keyword, so adding baseParts
            // separately would cause duplication (e.g. intitle:WBC intitle:wbc).
            const keywordParts = keyword.trim().split(/[\s|\u3000]+/).filter((s: string) => s.length > 0);
            keywordParts.forEach((p: string) => queryParts.push(`intitle:${p}`));

            // Extract suggestion-only part for matching logic below
            let suggestionOnly = keyword.trim();
            const baseKeywordTrimmed = baseKeyword.trim();
            if (suggestionOnly.toLowerCase().startsWith(baseKeywordTrimmed.toLowerCase())) {
                suggestionOnly = suggestionOnly.substring(baseKeywordTrimmed.length).trim();
            }

            if (isDebugEnabled()) {
                socket.emit('log', `[DEBUG] キーワード抽出: 元="${keyword}", ベース="${baseKeyword}", サジェスト="${suggestionOnly}"`);
            }

            // Add suggestion parts (used for title matching, not for query building)
            const suggestionParts = suggestionOnly.split(/[\s|\u3000]+/).filter((s: string) => s.length > 0);

            const intitleQuery = queryParts.join(' ');
            if (isDebugEnabled()) {
                socket.emit('log', `[DEBUG] 検索クエリ: ${intitleQuery}`);
            }
            const results = await this.scraper.getSearchResults(intitleQuery, 2);

            // Step 2: Check each title individually
            if (isDebugEnabled()) {
                socket.emit('log', `[DEBUG] 検索結果: ${results.length}件取得`);
            }

            // Filter out Yahoo's "no results" message pages
            const validResults = results.filter(result =>
                !result.title.includes('に一致する情報は見つかりませんでした') &&
                !result.title.includes('に一致する情報は検出されませんでした')
            );

            if (isDebugEnabled()) {
                socket.emit('log', `[DEBUG] 有効な結果: ${validResults.length}件（除外: ${results.length - validResults.length}件）`);
            }

            // validResults が 0件 の場合はAIのみページや取得失敗の可能性があるためスキップ
            // (0件をそのままmatchCount=0にするとthreshold以下となりライバルレス誤判定になる)
            if (validResults.length === 0) {
                socket.emit('log', `⚠️ 検索結果0件のためスキップ（AIのみページの可能性）: ${keyword}`);
                logger.warn(`[スキップ] 検索結果0件: ${keyword}`);
                return 'skip';
            }

            const matchingResults = validResults.filter(result => {
                const title = result.title.toLowerCase();
                if (isDebugEnabled()) {
                    socket.emit('log', `[DEBUG] チェック: "${result.title}"`);
                    socket.emit('log', `[DEBUG] ベース="${baseKeyword}", サジェスト="${suggestionOnly}", カスタム="${customCheckWords?.join(', ') || 'なし'}"`);
                }

                // Check if all parts of suggestion keyword are in title
                const hasSuggestion = suggestionParts.every((part: string) =>
                    title.includes(part.toLowerCase())
                );

                if (!hasSuggestion) return false;

                // Check condition 1: base keyword AND suggestion keyword
                const hasBase = baseParts.every((part: string) =>
                    title.includes(part.toLowerCase())
                );

                if (hasBase) {
                    if (isDebugEnabled()) socket.emit('log', `[DEBUG] ✅ マッチ（ベース+サジェスト）`);
                    return true;
                }

                // Check condition 2: custom words AND suggestion keyword
                if (customCheckWords && customCheckWords.length > 0) {
                    const hasCustom = customCheckWords.some((customWord: string) => {
                        const customParts = customWord.split(/[\s|　]+/).filter((s: string) => s.length > 0);
                        return customParts.every((part: string) =>
                            title.includes(part.toLowerCase())
                        );
                    });

                    if (hasCustom) {
                        if (isDebugEnabled()) socket.emit('log', `[DEBUG] ✅ マッチ（カスタム+サジェスト）`);
                        return true;
                    }
                }

                if (isDebugEnabled()) socket.emit('log', `[DEBUG] ❌ マッチせず`);
                return false;
            });

            const matchCount = matchingResults.length;
            if (isDebugEnabled()) {
                socket.emit('log', `[DEBUG] マッチ結果: ${matchCount}件/${results.length}件`);
            }

            if (matchCount <= threshold) {
                // Build Yahoo search URL for the LINK column
                const yahooLink = this.buildYahooSearchUrl(keyword, baseKeyword);
                const record: any = {
                    keyword: keyword,
                    link: yahooLink,
                };

                rivalLessKeywords.push(record);
                await csvWriter.writeRecords([record]);
                socket.emit('result', record);
                logger.info(`[完了] ライバルレス発見 (${matchCount}件): ${keyword}`);
                socket.emit('log', `ライバルレス発見 (${matchCount}件): ${keyword}`);

                // Save to cache as rival-less
                this.searchCache[keyword] = { rivalLess: true, record };
            } else {
                logger.info(`[完了] スキップ (${matchCount}件): ${keyword}`);
                // Save to cache as not rival-less
                this.searchCache[keyword] = { rivalLess: false };
            }
            this.saveCache();

            return 'success'; // Success

        } catch (e: any) {
            const msg: string = e.message ?? '';

            if (
                msg.includes('Blocked/Captcha') ||
                msg.includes('incompatible') ||
                // Navigation timeout on goto = Yahoo likely blocking access
                (msg.includes('page.goto') && msg.includes('Timeout'))
            ) {
                socket.emit('log', `⚠️ Block/CAPTCHA検知 "${keyword}": ${msg.slice(0, 80)}`);
                logger.warn(`Block/CAPTCHA検知 "${keyword}": ${msg.slice(0, 80)}`);
                return 'blocked';
            } else if (
                msg.includes('Execution context was destroyed') ||
                msg.includes('temporary issue')
            ) {
                // "Execution context was destroyed" = Yahoo did a background navigation during evaluate.
                // This is a transient error, NOT a block. Retry with the same session.
                socket.emit('log', `⚠️ 一時エラー (リトライ対象) "${keyword}": ${msg.slice(0, 80)}`);
                logger.warn(`一時エラー "${keyword}": ${msg.slice(0, 80)}`);
                return 'retry';
            } else {
                socket.emit('log', `❌ Error analyzing "${keyword}": ${msg}`);
                logger.error(`Error analyzing "${keyword}": ${msg}`);
                return 'skip';
            }
        }
    }

    /**
     * Phase 2: Analyze selected keywords with batching
     */
    async analyzeKeywords(
        keywords: string[],
        socket: any,
        threshold: number = 3,
        customCheckWords: string[] = [],
        baseKeyword: string = '',
        useCache: boolean = true
    ) {
        if (this.isRunning) return;
        this.isRunning = true;

        const timestamp = Date.now();
        const filename = `rival_less_keywords_${baseKeyword || 'selected'}_${timestamp}.csv`;
        const outputPath = path.resolve(process.cwd(), filename);

        socket.emit('status', { state: 'analyzing', message: 'Starting analysis' });

        // CSV: KEYWORD and LINK columns only
        const csvWriter = createObjectCsvWriter({
            path: outputPath,
            header: [
                { id: 'keyword', title: 'KEYWORD' },
                { id: 'link', title: 'LINK' },
            ]
        });

        const rivalLessKeywords: any[] = [];
        // Collect keywords that failed even after retry
        const errorKeywordList: string[] = [];

        try {
            await this.scraper.init(false); // Enable headful mode
            socket.emit('log', '--- Starting Analysis ---');
            socket.emit('totalKeywords', keywords.length);

            let count = 0;
            const retryList: string[] = [];

            if (!useCache) {
                socket.emit('log', `🗑️ 「${baseKeyword}」のキャッシュをクリアしました`);
                this.loadCache(baseKeyword);
                this.searchCache = {};
                this.saveCache();
            } else {
                this.loadCache(baseKeyword);
                socket.emit('log', `⚡ キャッシュ: ${Object.keys(this.searchCache).length}件のデータをロード`);
            }

            // Process all keywords
            for (const keyword of keywords) {
                if (!this.isRunning) break;

                // Check Cache
                if (this.searchCache[keyword]) {
                    socket.emit('log', `⚡ キャッシュから復元 (スキップ): ${keyword}`);
                    const cachedData = this.searchCache[keyword];
                    if (cachedData.rivalLess) {
                        // Always generate the LINK from keyword (cached record may use old format without 'link')
                        const csvRecord = {
                            keyword,
                            link: this.buildYahooSearchUrl(keyword, baseKeyword),
                        };
                        rivalLessKeywords.push(csvRecord);
                        await csvWriter.writeRecords([csvRecord]);
                        socket.emit('result', csvRecord);
                    }
                    socket.emit('progress', {
                        phase: 'analysis',
                        current: keywords.indexOf(keyword) + 1,
                        total: keywords.length,
                        keyword,
                        etaSeconds: 0
                    });
                    continue; // Skip actual scraping and do NOT increment 'count'
                }

                // Increment count ONLY for actual API requests to Yahoo
                count++;

                // Batching: Session reset every 50 keywords
                if (count > 0 && count % 50 === 0) {
                    socket.emit('log', `🔄 ${count}件に到達。ブラウザセッションをリセットします...`);
                    await this.scraper.close();
                    logger.info(`ブラウザセッションを破棄しました`);

                    const cooldown = 15;
                    socket.emit('batchPause', { active: true, remainingSeconds: cooldown, totalSeconds: cooldown });
                    for (let i = 0; i < cooldown; i++) {
                        if (!this.isRunning) {
                            socket.emit('batchPause', { active: false });
                            return;
                        }
                        socket.emit('batchPause', { active: true, remainingSeconds: cooldown - i, totalSeconds: cooldown });
                        await sleep(1000);
                    }

                    socket.emit('batchPause', { active: false });
                    socket.emit('log', `▶️ セッション再起動完了。分析を続けます...`);
                    await this.scraper.init(false);
                }

                const remaining = keywords.length - (keywords.indexOf(keyword) + 1);
                const estimatedSeconds = (remaining * 3) + (Math.floor(remaining / 50) * 60);

                socket.emit('progress', {
                    phase: 'analysis',
                    current: keywords.indexOf(keyword) + 1,
                    total: keywords.length,
                    keyword,
                    etaSeconds: estimatedSeconds
                });

                logger.info(`[対象] ${keyword}`);

                // If not cached, clear cookies before searching
                await this.scraper.clearCookies();

                let result = await this.processKeyword(keyword, baseKeyword, customCheckWords, threshold, socket, csvWriter, rivalLessKeywords);

                // 2-stage block recovery
                if (result === 'blocked') {
                    socket.emit('log', `🔄 [1/2] ブロック検知。セッションを再起動してリトライします...`);
                    await this.scraper.close();
                    await sleep(5000);
                    await this.scraper.init(false);
                    socket.emit('log', `🔄 [1/2] セッション再起動完了。リトライ中...`);
                    result = await this.processKeyword(keyword, baseKeyword, customCheckWords, threshold, socket, csvWriter, rivalLessKeywords);

                    if (result === 'blocked') {
                        socket.emit('log', `🚫 [2/2] 再試行後もブロック検知。IPアドレスの変更をお願いします。`);
                        logger.warn('2段階ブロック検知。IPアドレス変更が必要');
                        socket.emit('blockDetected');
                        this.isRunning = false;
                        return;
                    }
                }

                if (result === 'retry') {
                    retryList.push(keyword);
                } else if (result === 'skip') {
                    // Immediately treat skip as error (won't improve on retry)
                    errorKeywordList.push(keyword);
                    logger.warn(`[エラー] スキップ（手動確認推奨）: ${keyword}`);
                }

                // Short delay between keywords — no blocks observed so 300-800ms is sufficient
                const delay = 300 + Math.random() * 500;
                await sleep(delay);
            }

            // Process retry list — retry once, then move to errorKeywordList if still failing
            if (retryList.length > 0 && this.isRunning) {
                socket.emit('log', `\n📋 リトライリスト: ${retryList.length}件のキーワードを再処理します...`);

                for (const keyword of retryList) {
                    if (!this.isRunning) break;
                    count++;

                    socket.emit('progress', {
                        phase: 'analysis',
                        current: count,
                        total: keywords.length + retryList.length,
                        keyword,
                        etaSeconds: 0
                    });
                    socket.emit('log', `🔄 リトライ: ${keyword}`);
                    logger.info(`[リトライ] ${keyword}`);

                    const retryResult = await this.processKeyword(keyword, baseKeyword, customCheckWords, threshold, socket, csvWriter, rivalLessKeywords);

                    if (retryResult === 'retry' || retryResult === 'skip' || retryResult === 'blocked') {
                        // Still failing → move to error list for manual review
                        errorKeywordList.push(keyword);
                        socket.emit('log', `⚠️ リトライ後も失敗。手動確認リストに追加: ${keyword}`);
                        logger.warn(`[エラー] リトライ後も失敗（手動確認推奨）: ${keyword}`);
                    }

                    const delay = 300 + Math.random() * 500;
                    await sleep(delay);
                }
            }

            // Emit error keywords for manual review
            if (errorKeywordList.length > 0) {
                socket.emit('errorKeywords', errorKeywordList);
                logger.info(`[完了] エラーキーワード ${errorKeywordList.length}件を手動確認リストに送信`);
            }

            socket.emit('log', `Analysis complete. Found ${rivalLessKeywords.length} rival-less keywords.`);
            if (errorKeywordList.length > 0) {
                socket.emit('log', `⚠️ ${errorKeywordList.length}件のキーワードでエラーが発生しました。手動確認が必要です。`);
            }
            socket.emit('status', {
                state: 'finished',
                message: 'Analysis complete',
                downloadUrl: `/download/${filename}`
            });

        } catch (err) {
            logger.error('Error during analysis', err);
            socket.emit('error', `Error during analysis: ${err}`);
            socket.emit('status', { state: 'idle', message: 'Error' });
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Legacy method for backward compatibility (if needed)
     */
    async start(baseKeyword: string, customCheckWords: string[], socket: any, threshold: number = 3, verificationMode: boolean = false) {
        if (this.isRunning) return;
        this.isRunning = true;

        const timestamp = Date.now();
        const filename = `rival_less_keywords_${baseKeyword}_${timestamp}.csv`;
        const outputPath = path.resolve(process.cwd(), filename);

        // Notify client about start
        socket.emit('status', { state: 'running', message: `Starting analysis for: "${baseKeyword}"` });

        await this.scraper.init(false); // Enable headful mode

        // CSV: KEYWORD and LINK columns only
        const csvWriter = createObjectCsvWriter({
            path: outputPath,
            header: [
                { id: 'keyword', title: 'KEYWORD' },
                { id: 'link', title: 'LINK' },
            ]
        });

        const uniqueKeywords = new Set<string>();
        const rivalLessKeywords: any[] = [];

        try {
            // --- Phase 1: Suggestions ---
            socket.emit('log', '--- Phase 1: Collecting Suggestions ---');

            const chars_to_check = verificationMode ? HIRAGANA_LIST.slice(0, 10) : HIRAGANA_LIST;

            for (const char of chars_to_check) {
                if (!this.isRunning) break;

                const suggestions = await this.scraper.getSuggestions(baseKeyword, char);
                socket.emit('progress', { phase: 'suggestions', char, count: suggestions.length });

                for (const s of suggestions) {
                    if (!uniqueKeywords.has(s)) {
                        uniqueKeywords.add(s);
                    }
                }
            }

            socket.emit('log', `Total unique keywords found: ${uniqueKeywords.size}`);
            socket.emit('totalKeywords', uniqueKeywords.size);

            // Emit full suggestion list for UI
            socket.emit('suggestionList', Array.from(uniqueKeywords));

            // --- Phase 2: Search & Analysis ---
            socket.emit('log', '--- Phase 2: Analyzing Search Results ---');

            let count = 0;
            const keywordsArray = Array.from(uniqueKeywords);

            for (const keyword of keywordsArray) {
                if (!this.isRunning) break;
                count++;

                socket.emit('progress', { phase: 'analysis', current: count, total: keywordsArray.length, keyword });
                logger.info(`[対象] ${keyword}`);

                // Retry loop for this specific keyword
                while (this.isRunning) {
                    try {
                        const parts = keyword.split(/[\s|　]+/).filter(s => s.length > 0);
                        const intitleQuery = parts.map(p => `intitle:${p}`).join(' ');

                        const results = await this.scraper.getSearchResults(intitleQuery, 2);

                        if (results.length <= threshold) {
                            const yahooLink = `https://search.yahoo.co.jp/search?p=${encodeURIComponent(intitleQuery)}`;
                            const record: any = {
                                keyword: keyword,
                                link: yahooLink,
                            };

                            rivalLessKeywords.push(record);
                            await csvWriter.writeRecords([record]);

                            socket.emit('result', record);
                            socket.emit('log', `Found Rival-less (${results.length} hits): ${keyword}`);
                            logger.info(`[完了] ライバルレス発見 (${results.length}件): ${keyword}`);
                        } else {
                            logger.info(`[完了] スキップ (${results.length}件): ${keyword}`);
                        }

                        await sleep(2000);
                        break;

                    } catch (e: any) {
                        if (e.message && e.message.includes('Blocked/Captcha')) {
                            const minutes = 3;
                            socket.emit('log', `⚠️ Block detected! Cooling down for ${minutes} minutes... (Will retry "${keyword}")`);
                            logger.warn(`Block detected for "${keyword}"`);
                            await sleep(minutes * 60 * 1000);
                            socket.emit('log', `♻️ Resuming analysis for "${keyword}"...`);
                        } else {
                            logger.error(`Error processing ${keyword}: ${e.message}`);
                            socket.emit('log', `Error processing ${keyword}: ${e.message}`);
                            break;
                        }
                    }
                }
            }

        } catch (err) {
            logger.error('Fatal error', err);
            socket.emit('error', `Fatal error: ${err}`);
        } finally {
            this.isRunning = false;
            await this.scraper.close();
            socket.emit('status', { state: 'idle', message: 'Done', downloadUrl: `/download/${path.basename(filename)}` });
            socket.emit('log', `Done. Saved ${rivalLessKeywords.length} keywords.`);
        }
    }
}
