// ============================================================
// db.js
//
// データベースへの書き込みをまとめたモジュール。
//
// 【現段階はモック】
// まだ Azure SQL Database に接続していないため、
// 各関数は「本来ならこの内容を INSERT / UPDATE する」という情報を
// console.log で表示するだけで、実際の書き込みは行わない。
// DB 接続を実装するときは、この 3 つの関数の中身だけを差し替えればよく、
// 呼び出し側(fetchJob.js)は変更しなくて済む。
//
// 提供する関数:
//   upsertMod(mod)            mods テーブルへ挿入または更新し、mod_id を返す
//   insertSnapshot(snapshot)  snapshots テーブルへ 1 行挿入する
//   insertFetchLog(log)       fetch_logs テーブルへ 1 行挿入する
// ============================================================

// モックで返す仮の mod_id。実際の DB では IDENTITY 列が自動採番する。
let fakeModIdCounter = 1;

// mods テーブルへ挿入または更新する
// 入力: { name, author, platform, external_id, is_deprecated }
// 出力: mod_id(数値)
// 実装予定: (platform, external_id) が一致する行があれば name / author / is_deprecated を更新、
//           なければ新規挿入し、その行の mod_id を返す(SQL の MERGE 文を使う予定)
async function upsertMod(mod) {
  const modId = fakeModIdCounter++;
  console.log("[DB モック] mods へ UPSERT:", JSON.stringify({ mod_id: modId, ...mod }));
  return modId;
}

// snapshots テーブルへ 1 行挿入する
// 入力: { mod_id, captured_at, download_count, rating_score, raw_json }
// 出力: なし
async function insertSnapshot(snapshot) {
  // raw_json は長いので、表示時は文字数だけ出す
  const forDisplay = { ...snapshot, raw_json: `(${snapshot.raw_json.length} 文字の JSON)` };
  console.log("[DB モック] snapshots へ INSERT:", JSON.stringify(forDisplay));
}

// fetch_logs テーブルへ 1 行挿入する
// 入力: { run_at, status, error_message, records_fetched }
// 出力: なし
async function insertFetchLog(log) {
  console.log("[DB モック] fetch_logs へ INSERT:", JSON.stringify(log));
}

module.exports = { upsertMod, insertSnapshot, insertFetchLog };
