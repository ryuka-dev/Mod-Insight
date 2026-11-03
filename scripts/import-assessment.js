// ============================================================
// import-assessment.js
//
// 互換性チェックの結果ファイル(JSON)を読み、ゲームの更新ごとに
// 「mod ごとに修正が必要だったか」を event_mod_assessments テーブル(sql/005)に書く。
//
// 使い方(リポジトリのルートで):
//   node scripts/import-assessment.js <結果ファイル.json> --events <Steam のお知らせの番号>[,<番号>...]
//       書き込まずに、書く予定の行を表示するだけ(既定)
//   node scripts/import-assessment.js <結果ファイル.json> --events <番号>[,<番号>...] --apply
//       実際に書く
//   接続文字列は api/local.settings.json の AZURE_SQL_CONNECTION_STRING を使う。
//   mod と更新を探すために、表示だけの時も DB に接続する(一時停止中なら再開を待つ)。
//
// 結果ファイルの形と、mod・更新の見つけ方は api/src/assessment.js の先頭に書いてある。
// 1 つのチェックの結果を複数の更新に書けるのは、続けて出たパッチ(1.0 → 1.0.1 → 1.0.2)を
// 最後のビルドでまとめて確かめることがあるため。
//
// 安全のための決まり:
//   - ファイルの中身は外から来たものとして扱う。needs_fix が true / false でない、名前が重複している、
//     mods に無い mod や events に無い更新がある、のどれか 1 つでもあれば、問題を全部表示して
//     何も書かずに終わる(終了コード 1)
//   - --apply の時は全部の行を 1 つのトランザクションで書く。途中で失敗したら全部取り消す
//   - 同じ更新 × mod の行があれば needs_fix と updated_at を書き換え、無ければ足す(MERGE)。
//     行を消すことはしない(ファイルに無い mod の行はそのまま残る)
// ============================================================

const fs = require("fs");
const path = require("path");
const sql = require("../api/node_modules/mssql");
const { buildPoolConfig } = require("../api/src/db");
const { validateAssessmentFile, parseEventGids, resolveAssessments } = require("../api/src/assessment");

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

// コマンドラインの引数を読む
// 入力: process.argv の 3 つ目以降
// 出力: { problems: [文字列, ...], file, eventsText, apply }
function parseArgs(args) {
  const problems = [];
  let file = null;
  let eventsText;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--events") {
      eventsText = args[i + 1];
      i++;
    } else if (arg.startsWith("--")) {
      problems.push(`知らないオプション ${arg} があります`);
    } else if (file === null) {
      file = arg;
    } else {
      problems.push(`結果ファイルは 1 つだけ指定してください(${arg})`);
    }
  }
  if (file === null) {
    problems.push("結果ファイルを指定してください");
  }
  return { problems: problems, file: file, eventsText: eventsText, apply: apply };
}

// 問題を全部表示し、終了コードを 1 にする(呼び出し側はそのまま return する。何も書いていない)
// process.exit() をすぐ呼ばないのは、表示が出きる前や接続を閉じる前に終わらないようにするため
function failWith(problems) {
  console.error("問題があるため、何も書かずに終わります:");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exitCode = 1;
}

// 書く予定の行を、更新ごとにまとめて表示する
function printRows(rows) {
  let lastEventId = null;
  for (const row of rows) {
    if (row.event_id !== lastEventId) {
      console.log(`\n[${row.event_title}](event_id=${row.event_id})`);
      lastEventId = row.event_id;
    }
    const label = row.needs_fix ? "修正が必要" : "修正は不要";
    console.log(`  ${label}  ${row.mod_name}(${row.platform}, mod_id=${row.mod_id})`);
  }
  console.log("");
}

// 全部の行を 1 つのトランザクションで書く。途中で失敗したら全部取り消して例外を投げる
// 出力: { inserted, updated }(足した行の数、書き換えた行の数)
async function writeRows(pool, rows) {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  let inserted = 0;
  let updated = 0;
  try {
    for (const row of rows) {
      const result = await new sql.Request(transaction)
        .input("event_id", sql.Int, row.event_id)
        .input("mod_id", sql.Int, row.mod_id)
        .input("needs_fix", sql.Bit, row.needs_fix)
        .query(`
          MERGE event_mod_assessments AS target
          USING (SELECT @event_id AS event_id, @mod_id AS mod_id) AS incoming
            ON target.event_id = incoming.event_id AND target.mod_id = incoming.mod_id
          WHEN MATCHED THEN
            UPDATE SET needs_fix = @needs_fix, updated_at = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN
            INSERT (event_id, mod_id, needs_fix)
            VALUES (@event_id, @mod_id, @needs_fix)
          OUTPUT $action AS action;
        `);
      if (result.recordset[0].action === "INSERT") {
        inserted++;
      } else {
        updated++;
      }
    }
    await transaction.commit();
  } catch (err) {
    // 取り消し自体が失敗しても(接続が切れた時など)、元の失敗の理由を表示する
    try {
      await transaction.rollback();
    } catch (rollbackErr) {
      console.error("取り消しにも失敗しました:", rollbackErr.message);
    }
    throw err;
  }
  return { inserted: inserted, updated: updated };
}

async function main() {
  // 1. 引数とファイルの中身を確かめる(ここまでは DB に接続しない)
  const args = parseArgs(process.argv.slice(2));
  const gids = parseEventGids(args.eventsText);
  const argProblems = args.problems.concat(gids.problems);
  if (argProblems.length > 0) {
    return failWith(argProblems);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(args.file, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    return failWith([`結果ファイルを JSON として読めません: ${err.message}`]);
  }
  const file = validateAssessmentFile(data);
  if (file.problems.length > 0) {
    return failWith(file.problems);
  }

  // 2. DB の mod と更新に結びつける
  const pool = new sql.ConnectionPool(buildPoolConfig(loadConnectionString()));
  await pool.connect();
  try {
    const mods = (await pool.request().query("SELECT mod_id, name, platform, external_id FROM mods")).recordset;
    const events = (await pool.request().query(
      "SELECT event_id, title, source, external_id FROM events WHERE source = 'steam'"
    )).recordset;
    const resolved = resolveAssessments({ entries: file.entries, gids: gids.gids, mods: mods, events: events });
    if (resolved.problems.length > 0) {
      return failWith(resolved.problems);
    }

    console.log(`互換性チェック: ${file.sweep || "(sweep の記載なし)"}、mod ${file.entries.length} 件、更新 ${gids.gids.length} 件`);
    printRows(resolved.rows);

    // 3. --apply の時だけ書く
    if (!args.apply) {
      console.log(`書く予定の行: ${resolved.rows.length} 件(まだ書いていません。書く時は --apply を付けてください)`);
      return;
    }
    const counts = await writeRows(pool, resolved.rows);
    console.log(`完了: 足した行 ${counts.inserted} 件 / 書き換えた行 ${counts.updated} 件`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error("失敗:", err.message);
  process.exitCode = 1;
});
