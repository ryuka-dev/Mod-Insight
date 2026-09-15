// ============================================================
// test-nexusmods-api.js
//
// 用途: Azure Functions プロジェクトとは独立した、接続確認 + データ探索用スクリプト。
// 「この PC から Nexus Mods の GraphQL v2 API に API キーなしでアクセスできるか」と
// 「DB に保存したい値(総ダウンロード数、評価、バージョンごとのダウンロード数)が取れるか」を確認する。
//
// 実行方法:
//   node scripts/test-nexusmods-api.js
//
// 処理内容:
//   1. mods クエリで、ゲーム sulfur かつ uploaderId が作者の会員番号の mod 一覧を取得する
//   2. mod ごとに modFiles クエリでファイル一覧を取得し、totalDownloads を合計する
//   3. mod 名・総ダウンロード数(mods の downloads)・ファイル合計・評価・ファイル数を表形式で表示する
//      (downloads とファイル合計は 1〜2 件ずれることがある。Nexus Mods 側の数え方の違いで、バグではない)
//
// 入力: なし(URL・ゲーム・会員番号は下の定数で固定)
// 出力: 件数と表
// ============================================================

const API_URL = "https://api.nexusmods.com/v2/graphql";
const GAME_DOMAIN = "sulfur";
const UPLOADER_ID = "288522512";  // ryukalabs

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// GraphQL の問い合わせを 1 回送り、data 部分を返す
async function graphql(query, variables) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": BROWSER_USER_AGENT },
    body: JSON.stringify({ query, variables }),
  });
  console.log("HTTP ステータス:", response.status, response.statusText);
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  const body = await response.json();
  if (body.errors) {
    console.error("GraphQL エラー:", JSON.stringify(body.errors, null, 2));
    process.exit(1);
  }
  return body.data;
}

async function main() {
  console.log("リクエスト先:", API_URL);
  console.log("ゲーム:", GAME_DOMAIN, "/ uploaderId:", UPLOADER_ID);
  console.log("");

  // 1. mod 一覧
  const listData = await graphql(`
    query ($filter: ModsFilter) {
      mods(filter: $filter, count: 50, sort: [{ downloads: { direction: DESC } }]) {
        totalCount
        nodes { modId gameId name version status downloads endorsements updatedAt uploader { name memberId } }
      }
    }
  `, {
    filter: {
      gameDomainName: [{ value: GAME_DOMAIN, op: "EQUALS" }],
      uploaderId: [{ value: UPLOADER_ID, op: "EQUALS" }],
    },
  });
  const mods = listData.mods.nodes;
  console.log("作者の mod 数:", listData.mods.totalCount);
  console.log("");

  // 2. mod ごとにファイル一覧
  const rows = [];
  for (const mod of mods) {
    const fileData = await graphql(`
      query ($modId: ID!, $gameId: ID!) {
        modFiles(modId: $modId, gameId: $gameId) { fileId name version date category totalDownloads }
      }
    `, { modId: String(mod.modId), gameId: String(mod.gameId) });
    const files = fileData.modFiles;
    rows.push({
      "modId": mod.modId,
      "mod名": mod.name,
      "総DL数": mod.downloads,
      "ファイル合計": files.reduce((sum, f) => sum + f.totalDownloads, 0),
      "評価": mod.endorsements,
      "ファイル数": files.length,
      "最新版": mod.version,
      "状態": mod.status,
    });
  }

  console.table(rows);
  console.log("全 mod の総ダウンロード数合計:", rows.reduce((sum, r) => sum + r["総DL数"], 0));
}

main().catch((err) => {
  console.error("スクリプト実行エラー:", err);
  process.exit(1);
});
