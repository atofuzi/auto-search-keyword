import { YahooScraper } from './yahoo';

async function debug() {
    const scraper = new YahooScraper();
    // Use headless: false to see what's happening if running in a GUI env, 
    // but here we rely on logs.
    await scraper.init(true);

    console.log('Testing Suggestions for "ミラノオリンピック あ"...');
    const suggestions = await scraper.getSuggestions('ミラノオリンピック', 'あ');
    console.log('Suggestions found:', suggestions);

    console.log('Testing Search for "ミラノオリンピック 開催地"...');
    const titles = await scraper.getSearchResults('ミラノオリンピック 開催地');
    console.log('Search Titles found:', titles);

    await scraper.close();
}

debug();
