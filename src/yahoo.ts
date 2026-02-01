import { chromium, Browser, Page } from 'playwright';

export class YahooScraper {
    private browser: Browser | null = null;
    private page: Page | null = null;

    async init(headless: boolean = true) {
        this.browser = await chromium.launch({ headless });
        this.page = await this.browser.newPage();
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }

    async getSuggestions(baseKeyword: string, hiragana: string): Promise<string[]> {
        if (!this.page) throw new Error('Scraper not initialized');

        try {
            await this.page.goto('https://www.yahoo.co.jp/');

            const inputSelector = 'input[aria-label="検索したいキーワードを入力してください"]';
            await this.page.waitForSelector(inputSelector);
            await this.page.fill(inputSelector, `${baseKeyword} ${hiragana}`);

            const suggestListSelector = 'ul[aria-label="キーワード入力補助"]';
            // Wait for suggestions logic
            await this.page.waitForSelector(suggestListSelector, { timeout: 3000 });

            const suggestions = await this.page.$$eval(`${suggestListSelector} li a`, (els) => {
                return els.map(el => el.textContent?.trim() || '').filter(t => t.length > 0);
            });

            return suggestions;
        } catch (e) {
            return [];
        }
    }

    async getSearchResults(keyword: string): Promise<{ title: string; url: string }[]> {
        if (!this.page) throw new Error('Scraper not initialized');

        try {
            await this.page.goto(`https://search.yahoo.co.jp/search?p=${encodeURIComponent(keyword)}`);

            // Using #sw-Contents verified by browser agent (and allowing timeout adjustment)
            // await this.page.waitForSelector('#sw-Contents', { state: 'attached', timeout: 10000 });
            // Timeout occurring, changing to wait for load state or body
            await this.page.waitForLoadState('domcontentloaded');

            // Wait for results container specifically if possible, otherwise rely on extraction
            try {
                await this.page.waitForSelector('.sw-Card__titleMain', { timeout: 5000 });
            } catch (e) {
                // Ignore timeout here as extraction might handle partials or 0 results
            }

            // Extract Title and URL
            const results = await this.page.$$eval('.sw-Card__title', (cards) => {
                return cards.slice(0, 5).map(card => {
                    const anchor = card.querySelector('a');
                    const titleEl = card.querySelector('.sw-Card__titleMain');
                    return {
                        title: titleEl?.textContent?.trim() || anchor?.textContent?.trim() || '',
                        url: anchor?.href || ''
                    };
                });
            });

            return results;
        } catch (e) {
            console.error(`Error searching for ${keyword}:`, e);
            throw e; // Throw so we can handle it in index.ts
        }
    }
}
