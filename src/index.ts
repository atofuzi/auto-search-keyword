import { YahooScraper } from './yahoo';
import { HIRAGANA_LIST, sleep } from './utils';
import { isRivalLess } from './analyzer';
import { createObjectCsvWriter } from 'csv-writer';
import * as path from 'path';

const MAIN_ARGS = process.argv.slice(2);
const BASE_KEYWORD = MAIN_ARGS[0];
// If distinct words provided, use them. E.g. "ミラノ オリンピック"
const CHECK_WORDS_ARG = MAIN_ARGS[1];
const BASE_CHECK_WORDS = CHECK_WORDS_ARG ? CHECK_WORDS_ARG.split(/[\s|　]+/) : [];

if (!BASE_KEYWORD) {
    console.error('Usage: npm start <BASE_KEYWORD> [CHECK_WORDS_SPACE_SEPARATED]');
    process.exit(1);
}

const OUTPUT_FILE = path.resolve(process.cwd(), `rival_less_keywords_${BASE_KEYWORD}_${Date.now()}.csv`);

async function main() {
    console.log(`Starting analysis for: "${BASE_KEYWORD}"`);
    if (BASE_CHECK_WORDS.length > 0) {
        console.log(`Custom check words: ${JSON.stringify(BASE_CHECK_WORDS)}`);
    }

    const scraper = new YahooScraper();
    await scraper.init(true);

    // CSV Config
    const header = [
        { id: 'keyword', title: 'KEYWORD' }
    ];
    // Add columns for Top 5
    for (let i = 1; i <= 5; i++) {
        header.push({ id: `title_${i}`, title: `Title_${i}` });
        header.push({ id: `link_${i}`, title: `Link_${i}` });
    }

    const csvWriter = createObjectCsvWriter({
        path: OUTPUT_FILE,
        header: header
    });

    const uniqueKeywords = new Set<string>();
    const rivalLessKeywords: any[] = [];

    try {
        // 1. Suggestions
        console.log('--- Phase 1: Collecting Suggestions ---');
        for (const char of HIRAGANA_LIST) {
            // console.log(`Fetching suggestions for "${BASE_KEYWORD} ${char}"...`);
            const suggestions = await scraper.getSuggestions(BASE_KEYWORD, char);

            process.stdout.write('.'); // Progress indicator

            for (const s of suggestions) {
                if (!uniqueKeywords.has(s)) {
                    uniqueKeywords.add(s);
                }
            }
        }
        console.log(`\nTotal unique keywords found: ${uniqueKeywords.size}`);

        // 2. Search & Analyze
        console.log('--- Phase 2: Analyzing Search Results ---');
        let count = 0;
        for (const keyword of uniqueKeywords) {
            count++;
            console.log(`[${count}/${uniqueKeywords.size}] Analyzing "${keyword}"...`);

            try {
                const results = await scraper.getSearchResults(keyword);

                if (results.length === 0) {
                    continue;
                }

                // Determine Check Words
                // User Expectation: 
                // Suggest Part -> MUST be in title
                // Base Custom Words -> AT LEAST ONE must be in title

                // 1. Extract Suggest Part
                // "ミラノオリンピック アナウンサー" - BASE_KEYWORD("ミラノオリンピック") = " アナウンサー"
                // This replace is simplistic but works if keyword starts with BASE_KEYWORD.
                // It's safer to just remove the BASE_KEYWORD string.
                const suggestPart = keyword.replace(BASE_KEYWORD, '').trim();
                const suggestWords = suggestPart.split(/[\s|　]+/).filter(s => s.length > 0);

                let mustWords: string[] = [];
                let anyWords: string[] = [];

                if (BASE_CHECK_WORDS.length > 0) {
                    // Custom Mode
                    mustWords = suggestWords;
                    anyWords = BASE_CHECK_WORDS;

                    // Note: If keyword is just "ミラノオリンピック" (no suggest words), suggestWords is empty.
                    // In that case, we probably just want to find ANY of the base check words?
                    // Or is "BaseKeyword only" excluded from this loop?
                    // The scraper collects "Base + Char", so it usually has suggestions.
                    // If suggest words is empty, effectively we are just checking if any base word exists?
                    // Let's assume suggestWords is the MUST constraint. 

                    // Corner case: Suggestion is "ミラノオリンピック" itself (if yahoo suggested it?) -> suggestWords empty.
                    // Then mustWords is empty. every() on empty returns true.
                    // So it matches if ANY base word is present.
                } else {
                    // Default Mode: All parts are MUST
                    mustWords = keyword.split(/[\s|　]+/).filter(s => s.length > 0);
                }

                const titlesOnly = results.map(r => r.title);

                // Call new logic: isRivalLess(titles, mustWords, anyWords)
                if (isRivalLess(titlesOnly, mustWords, anyWords)) {
                    console.log(`  -> Found Rival-less: ${keyword}`);

                    const record: any = { keyword: keyword };
                    results.forEach((r, idx) => {
                        const num = idx + 1;
                        record[`title_${num}`] = r.title;
                        record[`link_${num}`] = `=HYPERLINK("${r.url}", "Link")`;
                    });

                    rivalLessKeywords.push(record);
                    await csvWriter.writeRecords([record]);
                }

                await sleep(2000);
            } catch (e) {
                console.error(`Error: ${e}`);
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
