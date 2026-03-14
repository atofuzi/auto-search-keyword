import * as https from 'https';

/**
 * Google Suggest API を使ってサジェストを取得するクラス。
 * ブラウザ不要。公開エンドポイントを直接 HTTP リクエストで呼ぶ。
 *
 * エンドポイント:
 *   https://suggestqueries.google.com/complete/search?client=firefox&hl=ja&q={query}
 *
 * レスポンス形式 (JSON配列):
 *   ["クエリ文字列", ["候補1", "候補2", ...], [], [], {...}]
 */
export class GoogleScraper {
    // Playwright 互換のダミーメソッド（scraperService から init/close が呼ばれるため）
    async init(_headless: boolean = false): Promise<void> {
        // HTTP リクエスト方式なのでブラウザ起動不要
    }

    async close(): Promise<void> {
        // 何もしない
    }

    /**
     * 前方検索: {hiragana} {baseKeyword} の順で Google サジェスト API を呼び出す
     */
    async getSuggestions(hiragana: string, baseKeyword: string): Promise<string[]> {
        const query = `${hiragana} ${baseKeyword}`;
        try {
            const results = await this.fetchSuggestions(query);
            return results;
        } catch (e: any) {
            console.error(`[GoogleScraper] Error getting suggestions for "${hiragana}":`, e.message);
            return [];
        }
    }

    private fetchSuggestions(query: string): Promise<string[]> {
        return new Promise((resolve, reject) => {
            const encodedQuery = encodeURIComponent(query);
            const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=ja&q=${encodedQuery}`;

            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                }
            };

            https.get(url, options, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        // レスポンス: ["query", ["候補1","候補2",...], ...]
                        const parsed = JSON.parse(data);
                        if (Array.isArray(parsed) && Array.isArray(parsed[1])) {
                            resolve(parsed[1] as string[]);
                        } else {
                            resolve([]);
                        }
                    } catch (e) {
                        reject(new Error(`JSON parse error: ${data.slice(0, 100)}`));
                    }
                });
            }).on('error', reject);
        });
    }
}
