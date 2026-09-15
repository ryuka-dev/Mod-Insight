// ============================================================
// backfill-version-snapshots.js
//
// 既存の snapshots.raw_json から、バージョンごとのダウンロード数を
// version_snapshots テーブルへ埋め戻す一回限りのスクリプト。
//
// 背景:
//   version_snapshots テーブル(sql/002)を追加する前の取得回にも、
//   raw_json の中には versions[].downloads がそのまま保存されていた。
//   このスクリプトはそれを読み出して、取得ジョブが最初からこのテーブルに
//   書いていたのと同じ状態を作る。
//
// 使い方(リポジトリのルートで):
//   node scripts/backfill-version-snapshots.js
//   接続文字列は api/local.settings.json の AZURE_SQL_CONNECTION_STRING を使う。
//
// 何度実行しても安全:
//   既に version_snapshots にある (version_id, captured_at) の組は飛ばす。
// ============================================================

const fs = require("fs");
const path = require("path");
const sql = require("../api/node_modules/mssql");

// api/local.settings.json から接続文字列を読む(BOM が付いていても読めるように先頭を除去)
function loadConnectionString() {
  const file = path.join(__dirname, "..", "api", "local.settings.json");
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const settings = JSON.parse(text);
  const cs = settings.Values && settings.Values.AZURE_SQL_CONNECTION_STRING;
  if (!cs) {
    throw new Error("api/local.settings.json に AZURE_SQL_CONNECTION_STRING がありません");
  }
  return cs;
}

async function main() {
  const pool = await sql.connect(loadConnectionString());
  console.log("接続しました");

  // 1. mod_versions を全部読んで、「mod_id + version_number → version_id」の対応表を作る
  const versionRows = (await pool.request().query("SELECT version_id, mod_id, version_number FROM mod_versions")).recordset;
  const versionIdByKey = new Map();
  for (const row of versionRows) {
    versionIdByKey.set(`${row.mod_id}/${row.version_number}`, row.version_id);
  }
  console.log(`mod_versions: ${versionRows.length} 件`);

  // 2. 既にある version_snapshots の (version_id, captured_at) を集めておく(二重挿入を防ぐ)
  const existingRows = (await pool.request().query("SELECT version_id, captured_at FROM version_snapshots")).recordset;
  const existing = new Set();
  for (const row of existingRows) {
    existing.add(`${row.version_id}@${new Date(row.captured_at).toISOString()}`);
  }
  console.log(`version_snapshots(実行前): ${existingRows.length} 件`);

  // 3. snapshots を古い順に読み、raw_json の versions[] を 1 行ずつ挿入する
  const snapshots = (await pool.request().query(
    "SELECT snapshot_id, mod_id, captured_at, raw_json FROM snapshots ORDER BY captured_at ASC, snapshot_id ASC"
  )).recordset;
  console.log(`snapshots: ${snapshots.length} 件`);

  let inserted = 0;
  let skipped = 0;
  let missingVersion = 0;

  for (const snapshot of snapshots) {
    if (!snapshot.raw_json) {
      continue;
    }
    const pkg = JSON.parse(snapshot.raw_json);
    const capturedAtIso = new Date(snapshot.captured_at).toISOString();

    for (const version of pkg.versions || []) {
      const versionId = versionIdByKey.get(`${snapshot.mod_id}/${version.version_number}`);
      if (versionId === undefined) {
        // mod_versions にまだ無いバージョン(通常は起こらない。取得ジョブが先に登録しているはず)
        missingVersion++;
        continue;
      }
      const key = `${versionId}@${capturedAtIso}`;
      if (existing.has(key)) {
        skipped++;
        continue;
      }

      await pool
        .request()
        .input("version_id", sql.Int, versionId)
        .input("captured_at", sql.DateTime2, new Date(snapshot.captured_at))
        .input("download_count", sql.Int, version.downloads)
        .query("INSERT INTO version_snapshots (version_id, captured_at, download_count) VALUES (@version_id, @captured_at, @download_count)");
      existing.add(key);
      inserted++;
    }
  }

  console.log(`完了: 挿入 ${inserted} 件 / 既存のため飛ばした ${skipped} 件 / mod_versions に無く飛ばした ${missingVersion} 件`);
  await pool.close();
}

main().catch((err) => {
  console.error("失敗:", err.message);
  process.exit(1);
});
