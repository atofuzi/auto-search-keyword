export function isRivalLess(keyword: string, titles: string[]): boolean {
    // キーワードを空白で分割
    const parts = keyword.split(/[\s|　]+/).filter(p => p.length > 0);

    // 5つのタイトルのうち、すべてのキーワード（parts）が含まれているタイトルを探す
    for (const title of titles) {
        let allIncluded = true;
        for (const part of parts) {
            if (!title.includes(part)) {
                allIncluded = false;
                break;
            }
        }
        // もし全てのキーワードが含まれているタイトルが1つでもあれば、それは「ライバルあり」とみなす
        // つまり、ライバルレスではない
        if (allIncluded) {
            return false;
        }
    }

    // どのタイトルにもキーワードが完全には含まれていない場合、ライバルレスと判断
    return true;
}
