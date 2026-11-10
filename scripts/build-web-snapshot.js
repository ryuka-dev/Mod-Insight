// ============================================================
// build-web-snapshot.js
//
// ダッシュボードの最初の画面に使う API の応答を、静的な JSON(写し)として web/data/ に書く。
// GitHub Actions(.github/workflows/deploy-web.yml)が、サイトを配置する直前に実行する。
//
// なぜ要るか:
//   Function App はしばらくアクセスが無いと止まり、次のアクセスで起動に数秒かかる。
//   その日はじめて開いた人が最初の数字を待たなくて済むよう、画面はまずこの写しで描き、
//   その裏で今までどおり API を呼んで、届いた値で描き直す(web/app.js の paintFromSnapshot)。
//
// 使い方:
//   node scripts/build-web-snapshot.js
//   API のベース URL は、画面と同じ web/config.js から読む(設定を 2 か所に書かないため)。
//   追加のパッケージは要らない(Node.js 18 以降の fetch を使う)。
//
// 取れなかった時:
//   その応答の写しは作らない(前に作ったファイルが残っていれば消す)。
//   画面は写しが無ければ API の値で描くだけなので、サイトの配置は止めない。終了コードはいつも 0。
//   GitHub Actions の実行結果で気づけるよう、::warning:: の行を出す。
//
// web/data/ は作るたびに中身が変わるので、Git には入れない(.gitignore)。
// ============================================================

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB_DIR = path.join(__dirname, "..", "web");
const DATA_DIR = path.join(WEB_DIR, "data");

// 1 つの応答を待つ上限(ミリ秒)。Function App の起動(数秒)を待てる長さにする
const TIMEOUT_MS = 30 * 1000;

// 写しにする応答。file は web/data/ の中のファイル名、path は API のパス。
// 最初の画面(ヘッダーの 1 行と「ゲーム更新への対応」)に要るものだけにしている。
// 増やす時は web/app.js の paintFromSnapshot も合わせる
const SNAPSHOTS = [
  { file: "event-impacts-thunderstore.json", path: "/event-impacts?platform=thunderstore" },
  { file: "overview.json", path: "/overview" },
  { file: "costs.json", path: "/costs" },
];

// web/config.js から API のベース URL を読む
// config.js はブラウザ用で、window.MOD_INSIGHT_CONFIG に設定を入れる。
// ここでは window の代わりになる空のオブジェクトを用意して、その中で実行する
function readApiBaseUrl() {
  const code = fs.readFileSync(path.join(WEB_DIR, "config.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  const config = sandbox.window.MOD_INSIGHT_CONFIG;
  if (!config || typeof config.apiBaseUrl !== "string" || config.apiBaseUrl === "") {
    throw new Error("web/config.js に apiBaseUrl がありません");
  }
  return config.apiBaseUrl;
}

// 1 つの応答を取って、JSON として読めることを確かめてから文字列で返す
// 入力: url
// 出力: 応答の本文(JSON の文字列)。HTTP エラー・時間切れ・JSON でない時は例外
async function fetchJsonText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  JSON.parse(text);  // 壊れた応答を写しにしないための確認(結果は使わない)
  return text;
}

async function main() {
  const baseUrl = readApiBaseUrl();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let written = 0;
  for (const snapshot of SNAPSHOTS) {
    const target = path.join(DATA_DIR, snapshot.file);
    try {
      const text = await fetchJsonText(baseUrl + snapshot.path);
      fs.writeFileSync(target, text);
      written++;
      console.log(`写しを作りました: ${snapshot.file}(${text.length} 文字)`);
    } catch (err) {
      // 古い写しを残すと、いつのデータか分からないものを出してしまうので消す
      fs.rmSync(target, { force: true });
      console.log(`::warning::写しを作れませんでした: ${snapshot.file}(${err.message})。画面は API の値で描きます`);
    }
  }
  console.log(`写し ${written} / ${SNAPSHOTS.length} 件`);
}

main().catch((err) => {
  // 設定が読めないなど、1 件も試せなかった時。この時もサイトの配置は止めない
  console.log(`::warning::写しを作る処理を始められませんでした(${err.message})。画面は API の値で描きます`);
});
