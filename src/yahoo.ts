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

    async getSearchResults(keyword: string): Promise<string[]> {
        if (!this.page) throw new Error('Scraper not initialized');

        try {
            await this.page.goto(`https://search.yahoo.co.jp/search?p=${encodeURIComponent(keyword)}`);

            // Using #sw-Contents verified by browser agent (and allowing timeout adjustment)
            // await this.page.waitForSelector('#sw-Contents', { state: 'attached', timeout: 10000 });
            // Timeout occurring, changing to wait for load state or body
            await this.page.waitForLoadState('domcontentloaded');
            await this.page.waitForSelector('body', { timeout: 10000 });

            const titleSelector = '.sw-Card__titleMain';
            const titles = await this.page.$$eval(titleSelector, (els) => {
                return els.slice(0, 5).map(el => el.textContent?.trim() || '');
            });
            return titles;
        } catch (e) {
            console.error(`Error searching for ${keyword}:`, e);
            throw e; // Throw so we can handle it in index.ts
        }
    }
}
