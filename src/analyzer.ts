// signature changed: removed 'keyword' as it wasn't strictly needed for logic, but kept for compatibility if needed? No, removing it is cleaner.
export function isRivalLess(titles: string[], mustWords: string[], anyWords: string[] = []): boolean {

    // 5つのタイトルのうち、条件を満たすタイトルがあるか探す
    // 条件: (mustWordsが全て含まれている) AND (anyWordsがあれば、そのうち少なくとも1つが含まれている)
    for (const title of titles) {
        // 1. 必須ワード（mustWords）が全て含まれているかチェック
        const mustMatch = mustWords.every(w => title.includes(w));
        if (!mustMatch) continue; // 必須ワードが無いなら、このタイトルはライバルではない

        // 2. 任意ワード（anyWords）がある場合、そのうち少なくとも1つが含まれているかチェック
        let anyMatch = true;
        if (anyWords.length > 0) {
            anyMatch = anyWords.some(w => title.includes(w));
        }

        // 両方満たせば、それは「ライバル記事」である
        if (mustMatch && anyMatch) {
            return false; // ライバルあり（＝ライバルレスではない）
        }
    }

    // どのタイトルも条件を満たさなかった場合、ライバルレスと判断
    return true;
}
