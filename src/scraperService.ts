import { YahooScraper } from './yahoo';
import { HIRAGANA_LIST, sleep } from './utils';
import { isRivalLess } from './analyzer';
import { createObjectCsvWriter } from 'csv-writer';
import * as path from 'path';
import { Server } from 'socket.io'; // Or just EventEmitter

// Define event types if needed, but for now we interact via Socket directly or callbacks
// Using a class that takes a socket instance to emit events

export class ScraperService {
    private scraper: YahooScraper;
    private isRunning: boolean = false;

    constructor() {
        this.scraper = new YahooScraper();
    }

    async stop() {
        this.isRunning = false;
        await this.scraper.close();
    }

    async start(baseKeyword: string, customCheckWords: string[], socket: any, threshold: number = 3, verificationMode: boolean = false) {
        if (this.isRunning) return;
        this.isRunning = true;

        const timestamp = Date.now();
        const filename = `rival_less_keywords_${baseKeyword}_${timestamp}.csv`;
        const outputPath = path.resolve(process.cwd(), filename);

        // Notify client about start
        socket.emit('status', { state: 'running', message: `Starting analysis for: "${baseKeyword}"` });

        await this.scraper.init(true);

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
