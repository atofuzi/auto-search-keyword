import { YahooScraper } from './yahoo';
import { HIRAGANA_LIST, sleep } from './utils';
import { isRivalLess } from './analyzer';
import { createObjectCsvWriter } from 'csv-writer';
import * as path from 'path';

const BASE_KEYWORD = process.argv[2];

if (!BASE_KEYWORD) {
    console.error('Please provide a base keyword. Usage: npm start <keyword>');
    process.exit(1);
}

const OUTPUT_FILE = path.resolve(process.cwd(), `rival_less_keywords_${BASE_KEYWORD}_${Date.now()}.csv`);

async function main() {
    console.log(`Starting analysis for base keyword: "${BASE_KEYWORD}"`);

    const scraper = new YahooScraper();
    // Using headless: true for production speed
    await scraper.init(true);

    const csvWriter = createObjectCsvWriter({
        path: OUTPUT_FILE,
        header: [
            { id: 'keyword', title: 'KEYWORD' },
            { id: 'titles', title: 'TOP_5_TITLES' }
        ]
    });

    const uniqueKeywords = new Set<string>();
    const rivalLessKeywords: { keyword: string; titles: string }[] = [];

    try {
        // 1. Collect Suggestions
        console.log('--- Phase 1: Collecting Suggestions ---');
        for (const char of HIRAGANA_LIST) {
            console.log(`Fetching suggestions for "${BASE_KEYWORD} ${char}"...`);
            const suggestions = await scraper.getSuggestions(BASE_KEYWORD, char);

            console.log(`  -> Found ${suggestions.length} suggestions.`);

            for (const s of suggestions) {
                if (!uniqueKeywords.has(s)) {
                    uniqueKeywords.add(s);
                }
            }

        }

        console.log(`Total unique keywords found: ${uniqueKeywords.size}`);



        // 2. Search and Analyze
        console.log('--- Phase 2: Analyzing Search Results ---');
        let count = 0;
        for (const keyword of uniqueKeywords) {
            count++;
            console.log(`[${count}/${uniqueKeywords.size}] Analyzing "${keyword}"...`);

            try {
                const titles = await scraper.getSearchResults(keyword);

                if (titles.length === 0) {
                    console.log(`  -> Warning: No titles found (possibly 0 results). Skipping.`);
                    continue;
                }

                if (isRivalLess(keyword, titles)) {
                    console.log(`  -> Found Rival-less keyword: ${keyword}`);
                    const record = {
                        keyword: keyword,
                        titles: titles.join('\n')
                    };
                    rivalLessKeywords.push(record);
                    await csvWriter.writeRecords([record]);
                } else {
                    // console.log(`  -> Competitors found.`);
                }

                await sleep(2000);
            } catch (e) {
                console.error(`  -> Error processing ${keyword}. Skipping.`);
            }
        }

    } catch (err) {
        console.error('Fatal error:', err);
    } finally {
        await scraper.close();
        console.log(`Done. Saved ${rivalLessKeywords.length} keywords to ${OUTPUT_FILE}`);
    }
}

main();
