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
                    await this.page.waitForTimeout(Math.floor(Math.random() * 500) + 500); // 0.5-1s

                    const inputSelector = 'input[aria-label="検索したいキーワードを入力してください"]';
                    await this.page.waitForSelector(inputSelector);
                    await this.page.click(inputSelector);
                    // fill() is instant and Yahoo doesn't detect typing speed — saves ~2s vs type()
                    await this.page.fill(inputSelector, keyword);

                    await this.page.waitForTimeout(200); // brief pause before submitting
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

                // Scroll simulation removed — no blocks have occurred and it saves ~1-2s per keyword

                // Wait for results container (increased timeout to handle slow pages)
                try {
                    await this.page.waitForSelector('.sw-Card__titleMain', { timeout: 5000 });
                } catch (e) {
                    // If element not found, first check for definitive block/error pages
                    const bodyText = await this.page.textContent('body');
                    if (
                        bodyText?.includes('現在表示できません') ||    // ブロック画面の固有テキスト
                        bodyText?.includes('一時的にアクセスできません') ||
                        bodyText?.includes('二段階認証')
                    ) {
                        // Definitive block / CAPTCHA screen detected
                        const screenshotPath = path.resolve(process.cwd(), `error_screenshot_${Date.now()}.png`);
                        await this.page.screenshot({ path: screenshotPath, fullPage: true });
                        console.log(`[Scraper] Block screen detected. Saved screenshot to ${screenshotPath}`);
                        throw new Error('Yahoo Search Blocked/Captcha detected');
                    } else {
                        // Not a block screen — treat as 0 organic results (e.g. AI-only answer page)
                        console.log(`[Scraper] No organic results found for page ${pageNum} (possibly AI-only answer). Treating as 0 results.`);
                        break;
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
