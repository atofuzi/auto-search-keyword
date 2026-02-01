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

    async start(baseKeyword: string, customCheckWords: string[], socket: any) {
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

            for (const char of HIRAGANA_LIST) {
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

            // --- Phase 2: Search & Analysis ---
            socket.emit('log', '--- Phase 2: Analyzing Search Results ---');

            let count = 0;
            const keywordsArray = Array.from(uniqueKeywords);

            for (const keyword of keywordsArray) {
                if (!this.isRunning) break;
                count++;

                socket.emit('progress', { phase: 'analysis', current: count, total: keywordsArray.length, keyword });

                try {
                    const results = await this.scraper.getSearchResults(keyword);
                    if (results.length === 0) continue;

                    // Logic Setup
                    const suggestPart = keyword.replace(baseKeyword, '').trim();
                    const suggestWords = suggestPart.split(/[\s|　]+/).filter(s => s.length > 0);

                    let mustWords: string[] = [];
                    let anyWords: string[] = [];

                    if (customCheckWords.length > 0) {
                        mustWords = suggestWords;
                        anyWords = customCheckWords;
                    } else {
                        mustWords = keyword.split(/[\s|　]+/).filter(s => s.length > 0);
                    }

                    const titlesOnly = results.map(r => r.title);

                    if (isRivalLess(titlesOnly, mustWords, anyWords)) {
                        const record: any = { keyword: keyword };
                        results.forEach((r, idx) => {
                            const num = idx + 1;
                            record[`title_${num}`] = r.title;
                            record[`link_${num}`] = `=HYPERLINK("${r.url}", "Link")`;
                        });

                        rivalLessKeywords.push(record);
                        await csvWriter.writeRecords([record]);

                        // Emit Found Result
                        socket.emit('result', record);
                        socket.emit('log', `Found Rival-less: ${keyword}`);
                    }

                    await sleep(2000);

                } catch (e) {
                    console.error(e);
                    socket.emit('log', `Error processing ${keyword}`);
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
