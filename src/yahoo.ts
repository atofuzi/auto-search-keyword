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
            await this.page.waitForSelector(suggestListSelector, { timeout: 1000 });

            const suggestions = await this.page.$$eval(`${suggestListSelector} li a`, (els) => {
                return els.map(el => el.textContent?.trim() || '').filter(t => t.length > 0);
            });

            return suggestions;
        } catch (e) {
            return [];
        }
    }

    async getSearchResults(keyword: string, maxPages: number = 2): Promise<{ title: string; url: string }[]> {
        if (!this.page) throw new Error('Scraper not initialized');

        let allResults: { title: string; url: string }[] = [];

        try {
            for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
                const bParams = (pageNum - 1) * 10 + 1;
                const searchUrl = `https://search.yahoo.co.jp/search?p=${encodeURIComponent(keyword)}&b=${bParams}`;

                await this.page.goto(searchUrl);
                await this.page.waitForLoadState('domcontentloaded');

                // Wait for results container (short timeout to be responsive)
                try {
                    await this.page.waitForSelector('.sw-Card__titleMain', { timeout: 3000 });
                } catch (e) {
                    // If no results on this page, likely done
                    break;
                }

                // Extract Title and URL from current page
                const pageResults = await this.page.$$eval('.sw-Card__title', (cards) => {
                    return cards.map(card => {
                        const anchor = card.querySelector('a');
                        const titleEl = card.querySelector('.sw-Card__titleMain');
                        return {
                            title: titleEl?.textContent?.trim() || anchor?.textContent?.trim() || '',
                            url: anchor?.href || ''
                        };
                    });
                });

                allResults = [...allResults, ...pageResults];

                // Check for Next Page button to decide if we should continue (if not reached maxPages yet)
                if (pageNum < maxPages) {
                    const nextButton = await this.page.$('.Pagenation__next a');
                    if (!nextButton) {
                        break; // No next page
                    }
                }
            }

            return allResults;
        } catch (e) {
            console.error(`Error searching for ${keyword}:`, e);
            throw e; // Throw so we can handle it in index.ts
        }
    }
}
