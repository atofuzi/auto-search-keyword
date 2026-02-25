import { YahooScraper } from './yahoo';
import { HIRAGANA_LIST, sleep } from './utils';
import { isRivalLess } from './analyzer';
import { createObjectCsvWriter } from 'csv-writer';
import * as path from 'path';
import * as fs from 'fs';
import { Server } from 'socket.io'; // Or just EventEmitter

// Define event types if needed, but for now we interact via Socket directly or callbacks
// Using a class that takes a socket instance to emit events

export class ScraperService {
    private scraper: YahooScraper;
    private isRunning: boolean = false;
    private currentBaseKeyword: string = '';
    private searchCache: { [keyword: string]: any } = {};

    constructor() {
        this.scraper = new YahooScraper();
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
                console.log(`[Cache] Loaded ${Object.keys(this.searchCache).length} entries for "${baseKeyword}" from ${path.basename(filePath)}`);
            } else {
                console.log(`[Cache] No existing cache for "${baseKeyword}". Starting fresh.`);
            }
        } catch (e) {
            console.error('Failed to load cache', e);
        }
    }

    private saveCache() {
        if (!this.currentBaseKeyword) return;
        try {
            const filePath = this.getCacheFilePath(this.currentBaseKeyword);
            fs.writeFileSync(filePath, JSON.stringify(this.searchCache, null, 2), 'utf-8');
        } catch (e) {
            console.error('Failed to save cache', e);
        }
    }

    async stop() {
        this.isRunning = false;
        await this.scraper.close();
    }

    /**
     * Phase 1: Collect suggestions only and group by Hiragana character
     */
    async getSuggestionsOnly(baseKeyword: string, socket: any, verificationMode: boolean = false) {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            socket.emit('status', { state: 'collecting', message: `Collecting suggestions for: "${baseKeyword}"` });
            await this.scraper.init(false); // Enable headful mode

            const chars_to_check = verificationMode ? HIRAGANA_LIST.slice(0, 10) : HIRAGANA_LIST;
            const groupedSuggestions: { [key: string]: string[] } = {};
            const uniqueKeywords = new Set<string>();
            const totalChars = chars_to_check.length;

            for (let i = 0; i < chars_to_check.length; i++) {
                const char = chars_to_check[i];
                if (!this.isRunning) break;

                const suggestions = await this.scraper.getSuggestions(baseKeyword, char);
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
            console.error(err);
            socket.emit('error', `Error collecting suggestions: ${err}`);
            socket.emit('status', { state: 'idle', message: 'Error' });
        } finally {
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
            baseParts.forEach((p: string) => queryParts.push(`intitle:${p}`));

            // Extract suggestion-only part (remove base keyword from full keyword)
            // Example: keyword="高市早苗 愛車", baseKeyword="高市早苗" → suggestion="愛車"
            let suggestionOnly = keyword.trim();
            const baseKeywordTrimmed = baseKeyword.trim();
            if (suggestionOnly.startsWith(baseKeywordTrimmed)) {
                suggestionOnly = suggestionOnly.substring(baseKeywordTrimmed.length).trim();
            }

            socket.emit('log', `[DEBUG] キーワード抽出: 元="${keyword}", ベース="${baseKeyword}", サジェスト="${suggestionOnly}"`);

            // Add suggestion keyword
            const suggestionParts = suggestionOnly.split(/[\s|　]+/).filter((s: string) => s.length > 0);
            suggestionParts.forEach((p: string) => queryParts.push(`intitle:${p}`));

            const intitleQuery = queryParts.join(' ');
            socket.emit('log', `[DEBUG] 検索クエリ: ${intitleQuery}`);
            const results = await this.scraper.getSearchResults(intitleQuery, 2);

            // Step 2: Check each title individually
            // Count titles that match: (base AND suggestion) OR (custom AND suggestion)
            socket.emit('log', `[DEBUG] 検索結果: ${results.length}件取得`);

            // Filter out Yahoo's "no results" message pages
            const validResults = results.filter(result =>
                !result.title.includes('に一致する情報は見つかりませんでした') &&
                !result.title.includes('に一致する情報は検出されませんでした')
            );

            socket.emit('log', `[DEBUG] 有効な結果: ${validResults.length}件（除外: ${results.length - validResults.length}件）`);

            // If all results were filtered out (Yahoo error pages), this is likely a temporary issue
            if (results.length > 0 && validResults.length === 0) {
                socket.emit('log', `⚠️ All results were Yahoo error pages for "${keyword}". This is likely temporary. Adding to retry list.`);
                throw new Error('temporary issue: all results filtered');
            }

            const matchingResults = validResults.filter(result => {
                const title = result.title.toLowerCase();
                socket.emit('log', `[DEBUG] チェック: "${result.title}"`);
                socket.emit('log', `[DEBUG] ベース="${baseKeyword}", サジェスト="${suggestionOnly}", カスタム="${customCheckWords?.join(', ') || 'なし'}"`);

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
                    socket.emit('log', `[DEBUG] ✅ マッチ（ベース+サジェスト）`);
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
                        socket.emit('log', `[DEBUG] ✅ マッチ（カスタム+サジェスト）`);
                        return true;
                    }
                }

                socket.emit('log', `[DEBUG] ❌ マッチせず`);
                return false;
            });

            const matchCount = matchingResults.length;
            socket.emit('log', `[DEBUG] マッチ結果: ${matchCount}件/${results.length}件`);

            if (matchCount <= threshold) {
                const record: any = { keyword: keyword };

                // Display top 5 search results (not just matched ones)
                validResults.slice(0, 5).forEach((r, idx) => {
                    const num = idx + 1;
                    record[`title_${num}`] = r.title;
                    record[`link_${num}`] = `=HYPERLINK("${r.url}", "Link")`;
                    record[`url_${num}`] = r.url;
                });

                rivalLessKeywords.push(record);
                await csvWriter.writeRecords([record]);
                socket.emit('result', record);
                socket.emit('log', `ライバルレス発見 (${matchCount}件): ${keyword}`);

                // Save to cache as rival-less
                this.searchCache[keyword] = { rivalLess: true, record };
            } else {
                // Save to cache as not rival-less
                this.searchCache[keyword] = { rivalLess: false };
            }
            this.saveCache();

            return 'success'; // Success

        } catch (e: any) {
            if (e.message && (e.message.includes('Blocked/Captcha') || e.message.includes('incompatible'))) {
                socket.emit('log', `⚠️ Block/CAPTCHA detected for "${keyword}".`);
                return 'blocked';
            } else if (e.message && e.message.includes('temporary issue')) {
                socket.emit('log', `⚠️ Temporary issue detected for "${keyword}". Adding to retry list.`);
                return 'retry'; // Add to retry list
            } else {
                socket.emit('log', `❌ Error analyzing "${keyword}": ${e.message}`);
                return 'skip'; // Skip this keyword
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

        const csvWriter = createObjectCsvWriter({
            path: outputPath,
            header: [
                { id: 'keyword', title: 'KEYWORD' },
                { id: 'title_1', title: 'Title_1' },
                { id: 'link_1', title: 'Link_1' },
                { id: 'title_2', title: 'Title_2' },
                { id: 'link_2', title: 'Link_2' },
                { id: 'title_3', title: 'Title_3' },
                { id: 'link_3', title: 'Link_3' },
                { id: 'title_4', title: 'Title_4' },
                { id: 'link_4', title: 'Link_4' },
                { id: 'title_5', title: 'Title_5' },
                { id: 'link_5', title: 'Link_5' }
            ]
        });

        const rivalLessKeywords: any[] = [];

        try {
            await this.scraper.init(false); // Enable headful mode
            socket.emit('log', '--- Starting Analysis ---');
            socket.emit('totalKeywords', keywords.length);

            let count = 0;
            const retryList: string[] = [];

            if (!useCache) {
                socket.emit('log', `🗑️ 「${baseKeyword}」のキャッシュをクリアしました`);
                // Load to set currentBaseKeyword correctly, then wipe
                this.loadCache(baseKeyword);
                this.searchCache = {};
                this.saveCache();
            } else {
                // Load only this base keyword's cache
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
                    if (cachedData.rivalLess && cachedData.record) {
                        rivalLessKeywords.push(cachedData.record);
                        await csvWriter.writeRecords([cachedData.record]);
                        socket.emit('result', cachedData.record);
                    }
                    // emit progress even if skipped
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

                // Batching: Session reset every 50 keywords (no long pause needed - session restart is the key)
                if (count > 0 && count % 50 === 0) {
                    socket.emit('log', `🔄 ${count}件に到達。ブラウザセッションをリセットします...`);

                    await this.scraper.close();
                    socket.emit('log', `[Scraper] ブラウザセッションを破棄しました`);

                    // Short 15s cooldown instead of 1 minute
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
                // 1 search ~ 3 seconds, + 60s pause every 50 searches remaining.
                const estimatedSeconds = (remaining * 3) + (Math.floor(remaining / 50) * 60);

                socket.emit('progress', {
                    phase: 'analysis',
                    current: keywords.indexOf(keyword) + 1,
                    total: keywords.length,
                    keyword,
                    etaSeconds: estimatedSeconds
                });

                // If not cached, clear cookies before searching
                await this.scraper.clearCookies();

                let result = await this.processKeyword(keyword, baseKeyword, customCheckWords, threshold, socket, csvWriter, rivalLessKeywords);

                // 2-stage block recovery
                if (result === 'blocked') {
                    socket.emit('log', `🔄 [1/2] ブロック検知。セッションを再起動してリトライします...`);
                    await this.scraper.close();
                    await sleep(5000); // Short cooldown
                    await this.scraper.init(false);
                    socket.emit('log', `🔄 [1/2] セッション再起動完了。リトライ中...`);
                    result = await this.processKeyword(keyword, baseKeyword, customCheckWords, threshold, socket, csvWriter, rivalLessKeywords);

                    if (result === 'blocked') {
                        socket.emit('log', `🚫 [2/2] 再試行後もブロック検知。IPアドレスの変更をお願いします。`);
                        socket.emit('blockDetected');
                        this.isRunning = false;
                        return;
                    }
                }

                if (result === 'retry') {
                    retryList.push(keyword);
                }

                // Random delay to avoid rate limiting
                const delay = 1000 + Math.random() * 2000; // 1-3 seconds random delay
                await sleep(delay);
            }

            // Process retry list
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

                    await this.processKeyword(keyword, baseKeyword, customCheckWords, threshold, socket, csvWriter, rivalLessKeywords);

                    // Random delay
                    const delay = 1000 + Math.random() * 2000; // 1-3 seconds random delay
                    await sleep(delay);
                }
            }

            socket.emit('log', `Analysis complete. Found ${rivalLessKeywords.length} rival-less keywords.`);
            socket.emit('status', {
                state: 'finished',
                message: 'Analysis complete',
                downloadUrl: `/download/${filename}`
            });

        } catch (err) {
            console.error(err);
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

        const csvWriter = createObjectCsvWriter({
            path: outputPath,
            header: [
                { id: 'keyword', title: 'KEYWORD' },
                { id: 'title_1', title: 'Title_1' },
                { id: 'link_1', title: 'Link_1' },
                { id: 'title_2', title: 'Title_2' },
                { id: 'link_2', title: 'Link_2' },
                { id: 'title_3', title: 'Title_3' },
                { id: 'link_3', title: 'Link_3' },
                { id: 'title_4', title: 'Title_4' },
                { id: 'link_4', title: 'Link_4' },
                { id: 'title_5', title: 'Title_5' },
                { id: 'link_5', title: 'Link_5' }
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

                // Retry loop for this specific keyword
                while (this.isRunning) {
                    try {
                        // Construct intitle query
                        // Split keyword into parts and prepend intitle:
                        const parts = keyword.split(/[\s|　]+/).filter(s => s.length > 0);
                        const intitleQuery = parts.map(p => `intitle:${p}`).join(' ');

                        // Search with pagination support (up to 2 pages = 20 results)
                        // Note: If we need strictly top 20, maxPages=2 is correct.
                        const results = await this.scraper.getSearchResults(intitleQuery, 2);

                        // Logic: If the number of exact match results is <= threshold, it is rival-less.
                        if (results.length <= threshold) {
                            const record: any = { keyword: keyword };

                            // Populate up to 5 results for CSV (even if we fetched 20, CSV header only has 5 slots currently)
                            // "CSV output feature... Outputs Top 5" -> Keep top 5 in CSV.

                            results.slice(0, 5).forEach((r, idx) => {
                                const num = idx + 1;
                                record[`title_${num}`] = r.title;
                                record[`link_${num}`] = `=HYPERLINK("${r.url}", "Link")`;
                                record[`url_${num}`] = r.url;
                            });

                            rivalLessKeywords.push(record);
                            await csvWriter.writeRecords([record]);

                            // Emit Found Result (send all top 5 for modal)
                            socket.emit('result', record);
                            socket.emit('log', `Found Rival-less (${results.length} hits): ${keyword}`);
                        } else {
                            // socket.emit('log', `Skipping: ${keyword} (${results.length} hits > ${threshold})`);
                        }

                        await sleep(2000); // Normal interval
                        break; // Success, exit retry loop and move to next keyword

                    } catch (e: any) {
                        if (e.message && e.message.includes('Blocked/Captcha')) {
                            const minutes = 3;
                            socket.emit('log', `⚠️ Block detected! Cooling down for ${minutes} minutes... (Will retry "${keyword}")`);
                            // Wait for cooldown
                            await sleep(minutes * 60 * 1000);
                            socket.emit('log', `♻️ Resuming analysis for "${keyword}"...`);
                            // Loop continues automatically to retry
                        } else {
                            console.error(e);
                            socket.emit('log', `Error processing ${keyword}: ${e.message}`);
                            break; // Unknown error, skip to next keyword
                        }
                    }
                }
            }

        } catch (err) {
            console.error(err);
            socket.emit('error', `Fatal error: ${err}`);
        } finally {
            this.isRunning = false;
            await this.scraper.close();
            socket.emit('status', { state: 'idle', message: 'Done', downloadUrl: `/download/${path.basename(filename)}` });
            socket.emit('log', `Done. Saved ${rivalLessKeywords.length} keywords.`);
        }
    }
}
