// ============================================================
// test-thunderstore-api.js
//
// 用途: Azure Functions プロジェクトとは独立した、接続確認 + データ探索用スクリプト。
// 「この PC から Thunderstore の v1 コミュニティ API にアクセスできるか」と
// 「DB に保存したい値を返ってきたデータから計算できるか」を確認する。
//
// 実行方法:
//   node scripts/test-thunderstore-api.js
//
// 処理内容:
//   1. Thunderstore sulfur コミュニティの v1 パッケージ一覧 API に GET リクエストを送る
//      (このコミュニティの全 mod を一度に返す。認証不要)
//   2. リクエストヘッダーに一般的なブラウザの User-Agent を付ける
//   3. 返ってきた一覧から owner が ryuka_labs のものだけを抽出する
//   4. 各 mod について versions[].downloads を合計し、総ダウンロード数を算出する
//      (API 自体には「総ダウンロード数」の項目がなく、バージョンごとの値しかない)
//   5. mod 名・総ダウンロード数・評価・バージョン数を表形式で表示する
//
// 入力: なし(URL と owner は下の定数で固定)
// 出力: HTTP ステータス、コミュニティ全体の件数、抽出後の表
// ============================================================

// sulfur コミュニティの v1 パッケージ一覧 API
const API_URL = "https://thunderstore.io/c/sulfur/api/v1/package/";

// この作者の mod だけを対象にする
const TARGET_OWNER = "ryuka_labs";

// 一般的な Chrome の User-Agent(UA なしのリクエストを拒否するサイトがあるため)
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// 1 パッケージの総ダウンロード数を計算する: 全バージョンの downloads を合計
// 入力: API が返す 1 パッケージ分のオブジェクト(versions 配列を持つ)
// 出力: 合計ダウンロード数(整数)
function sumDownloads(pkg) {
  let total = 0;
  for (const version of pkg.versions) {
    total += version.downloads;
  }
  return total;
}

// メイン処理: リクエスト → 抽出 → 計算 → 表示
async function main() {
  console.log("リクエスト先:", API_URL);
  console.log("抽出する owner:", TARGET_OWNER);
  console.log("");

  // Node.js 18 以降は fetch が標準搭載なので、axios などの追加ライブラリは不要
  const response = await fetch(API_URL, {
    method: "GET",
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      "Accept": "application/json",
    },
  });

  console.log("HTTP ステータス:", response.status, response.statusText);

  // 2xx 以外なら生のレスポンス本文を表示して終了(原因調査のため)
  if (!response.ok) {
    const text = await response.text();
    console.error("リクエスト失敗。レスポンス本文:");
    console.error(text);
    process.exit(1);
  }

  // レスポンスは配列で、各要素が 1 パッケージ
  const allPackages = await response.json();
  console.log("コミュニティ内のパッケージ数:", allPackages.length);

  // owner が ryuka_labs のものだけ残す
  const myPackages = allPackages.filter((pkg) => pkg.owner === TARGET_OWNER);
  console.log(`そのうち owner が ${TARGET_OWNER} のパッケージ数:`, myPackages.length);
  console.log("");

  // 表示用の形に整え、総ダウンロード数の多い順に並べる
  const rows = myPackages.map((pkg) => ({
    "mod名": pkg.name,
    "総DL数": sumDownloads(pkg),
    "評価": pkg.rating_score,
    "バージョン数": pkg.versions.length,
    "最新版": pkg.versions[0].version_number,
    "非推奨": pkg.is_deprecated,
  }));
  rows.sort((a, b) => b["総DL数"] - a["総DL数"]);

  // console.table は配列を渡すだけで整列した表を描いてくれる
  console.table(rows);

  // 全 mod の合計も表示して規模感をつかめるようにする
  const grandTotal = rows.reduce((sum, r) => sum + r["総DL数"], 0);
  console.log("全 mod の総ダウンロード数合計:", grandTotal);
}

// 未処理の例外(DNS 失敗、ネットワーク不通など)を捕捉して表示し、0 以外の終了コードで終わる
main().catch((err) => {
  console.error("スクリプト実行エラー:", err);
  process.exit(1);
});
