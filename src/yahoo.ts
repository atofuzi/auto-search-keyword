import { Browser, Page } from 'playwright';
import { chromium } from 'playwright-extra';
// @ts-ignore - plugin missing types sometimes
import stealth from 'puppeteer-extra-plugin-stealth';
import * as path from 'path';

// Add the stealth plugin
chromium.use(stealth());

export class YahooScraper {
    private browser: Browser | null = null;
    private page: Page | null = null;

    async init(headless: boolean = false) {
        this.browser = await chromium.launch({
            headless: false, // Force headful mode
            channel: 'chrome', // Use real installed Chrome
            args: [
                '--disable-blink-features=AutomationControlled',
                '--start-maximized', // Start maximized for a more realistic fingerprint
                '--disable-infobars'
            ]
        });

        // Pass standard viewport size to look less like a headless bot
        this.page = await this.browser.newPage({
            viewport: null, // Let it use the maximized window size
            javaScriptEnabled: true,
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }

    async clearCookies() {
        if (this.page) {
            await this.page.context().clearCookies();
        }
    }

    async getSuggestions(baseKeyword: string, hiragana: string): Promise<string[]> {
        if (!this.page) throw new Error('Scraper not initialized');

        try {
            // Only navigate to Yahoo top if not already there.
            // Reusing the existing page saves one full page load per hiragana character.
            const currentUrl = this.page.url();
            const navigated = !currentUrl.startsWith('https://www.yahoo.co.jp');
            if (navigated) {
                await this.page.goto('https://www.yahoo.co.jp/');
            }

            const inputSelector = 'input[aria-label="検索したいキーワードを入力してください"]';
            await this.page.waitForSelector(inputSelector);

            // Phase 1 (Suggestions) does not require anti-bot slow typing
            await this.page.fill(inputSelector, `${baseKeyword} ${hiragana}`);

            // After a fresh page navigation the AJAX takes longer to fire than when
            // we are already on the Yahoo homepage and just change the input text.
            await this.page.waitForTimeout(navigated ? 1500 : 500);

            const suggestListSelector = 'ul[aria-label="キーワード入力補助"]';
            // Allow more time after fresh navigation for the dropdown to appear
            await this.page.waitForSelector(suggestListSelector, { timeout: navigated ? 3000 : 1500 });

            const suggestions = await this.page.$$eval(`${suggestListSelector} li a`, (els) => {
                return els.map(el => {
                    // Use innerText instead of textContent to respect styling/layout and avoid merging text without spaces
                    // Also replace newlines with spaces just in case
                    return (el as HTMLElement).innerText?.replace(/\n/g, ' ').trim() || '';
                }).filter(t => t.length > 0);
            });

            return suggestions;
        } catch (e: any) {
            console.error(`[Scraper] Error getting suggestions for "${hiragana}":`, e.message);
            return [];
        }
    }


    async getSearchResults(keyword: string, maxPages: number = 2): Promise<{ title: string; url: string }[]> {
        if (!this.page) throw new Error('Scraper not initialized');

        let allResults: { title: string; url: string }[] = [];

        try {
            for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
                // For page 1, we start from the homepage to look natural
                if (pageNum === 1) {
                    await this.page.goto('https://www.yahoo.co.jp/');
                    await this.page.waitForLoadState('load');
                    await this.page.waitForTimeout(Math.floor(Math.random() * 1000) + 1000); // Wait 1-2s

                    const inputSelector = 'input[aria-label="検索したいキーワードを入力してください"]';
                    await this.page.waitForSelector(inputSelector);
                    await this.page.click(inputSelector);
                    await this.page.fill(inputSelector, '');
                    await this.page.type(inputSelector, keyword, { delay: Math.floor(Math.random() * 100) + 50 });

                    await this.page.waitForTimeout(Math.floor(Math.random() * 500) + 200);
                    await this.page.keyboard.press('Enter');
                    // Use 'load' instead of 'domcontentloaded' so ad scripts finish loading
                    // before we call page.evaluate(), reducing "Execution context was destroyed" errors.
                    await this.page.waitForLoadState('load');
                } else {
                    // For pagination, it's safer to just click the "Next" button if it exists, but URL is okay if we add delay
                    const bParams = (pageNum - 1) * 10 + 1;
                    const searchUrl = `https://search.yahoo.co.jp/search?p=${encodeURIComponent(keyword)}&b=${bParams}`;
                    await this.page.goto(searchUrl);
                    await this.page.waitForLoadState('load');
                }

                // Random scroll down and up to simulate human reading
                // Wrapped in try-catch: ad scripts may trigger a redirect during evaluate()
                await this.page.waitForTimeout(Math.floor(Math.random() * 1000) + 500);
                try {
                    await this.page.evaluate(() => window.scrollBy(0, window.innerHeight * Math.random()));
                    await this.page.waitForTimeout(Math.floor(Math.random() * 800) + 300);
                    await this.page.evaluate(() => window.scrollBy(0, -500 * Math.random()));
                } catch (_) {
                    // Ignore scroll errors – they are cosmetic only
                }

                // Wait for results container (increased timeout to handle slow pages)
                try {
                    await this.page.waitForSelector('.sw-Card__titleMain', { timeout: 5000 });
                } catch (e) {
                    // If element not found, check if it's a valid "No Results" page
                    const bodyText = await this.page.textContent('body');
                    if (bodyText?.includes('一致する情報は見つかりませんでした')) {
                        // Potentially temporary - throw to allow retry
                        throw new Error('Yahoo Search returned no results (Possible temporary issue)');
                    } else if (bodyText?.includes('一時的にアクセスできません') || bodyText?.includes('二段階認証') || bodyText?.includes('現在表示できません')) {
                        // CAPTCHA or Ban detection
                        throw new Error('Yahoo Search Blocked/Captcha detected');
                    } else {
                        // Unknown state (maybe layout changed or slow load), but risking it as 0 results is bad.
                        // Let's create a screenshot for debug if possible, but for now throw error.
                        const screenshotPath = path.resolve(process.cwd(), `error_screenshot_${Date.now()}.png`);
                        await this.page.screenshot({ path: screenshotPath, fullPage: true });
                        console.log(`[Scraper] Unknown page state. Saved screenshot to ${screenshotPath}`);
                        throw new Error('Search results incompatible (Possible block or layout change)');
                    }
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
