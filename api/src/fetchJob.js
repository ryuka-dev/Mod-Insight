// ============================================================
// fetchJob.js
//
// 各プラットフォームからデータを取得して DB に保存する処理の本体。
//
// タイマー関数(functions/FetchThunderstoreDataTimer.js)と
// 手動実行 API(functions/RunFetch.js、POST /api/fetch/run)の両方から呼ばれる。
// ローカルでの動作確認(node -e "require('./src/fetchJob').runFetchJob(console)")も同じ関数で行える。
// トリガーの種類に関係なく同じ処理を通すため、トリガーとは別ファイルに分けている。
//
// プラットフォームごとの違いは platforms/ 配下のアダプターに閉じ込めている:
//   platforms/thunderstore.js  Thunderstore の v1 API
//   platforms/nexusmods.js     Nexus Mods の GraphQL v2 API
// どちらも fetchTrackedMods(logger) で同じ「共通の形」の配列を返すので、
// このファイルの保存処理はプラットフォームの API の項目名を知らなくてよい。
//
// 共通の形(1 mod 分):
//   {
//     name, author, external_id, is_deprecated,
//     download_count, rating_score, raw_json,
//     versions: [{ version_number, release_date, download_count }, ...]
//   }
//
// 処理の流れ(プラットフォームごとに繰り返す):
//   1. アダプターから追跡対象 mod の一覧を取得
//   2. 各 mod について
//        - mods テーブルへ UPSERT(platform + external_id で同一判定)
//        - versions[] を mod_versions テーブルへ UPSERT(新しいものだけ増える)
//        - 各バージョンのダウンロード数を version_snapshots テーブルへ INSERT
//        - snapshots テーブルへ 1 行 INSERT
//      ※ 1 件で失敗しても他の mod の処理は続ける
//   3. そのプラットフォームの結果を fetch_logs へ 1 行 INSERT
// 全プラットフォームの snapshots に同じ run_at を入れるので、
// 「同じ回の取得」としてプラットフォーム横断で合計できる。
//
// 入力: logger(context または console。log / error メソッドを持つもの)
// 出力: { run_at, results: [{ platform, status, error_message, records_fetched }, ...] }
//       results の各要素は fetch_logs に書いた内容と同じ
// ============================================================

const db = require("./db");
const thunderstore = require("./platforms/thunderstore");
const nexusmods = require("./platforms/nexusmods");

// 取得する順番。1 つ失敗しても次のプラットフォームへ進む
const PLATFORM_ADAPTERS = [thunderstore, nexusmods];

// 1 mod 分を DB に保存する(mods の UPSERT、mod_versions の UPSERT、version_snapshots と snapshots の INSERT)
// 入力: platform(文字列)、mod(共通の形)、capturedAt(ISO 文字列)
// 出力: なし(失敗時は例外を投げる。呼び出し側で捕捉する)
async function saveMod(platform, mod, capturedAt) {
  const modId = await db.upsertMod({
    name: mod.name,
    author: mod.author,
    platform: platform,
    external_id: mod.external_id,
    is_deprecated: mod.is_deprecated ? 1 : 0,
  });

  for (const version of mod.versions) {
    const versionId = await db.upsertModVersion({
      mod_id: modId,
      version_number: version.version_number,
      release_date: version.release_date,
    });
    await db.insertVersionSnapshot({
      version_id: versionId,
      captured_at: capturedAt,
      download_count: version.download_count,
    });
  }

  await db.insertSnapshot({
    mod_id: modId,
    captured_at: capturedAt,
    download_count: mod.download_count,
    rating_score: mod.rating_score,
    raw_json: mod.raw_json,
  });
}

// fetch_logs への書き込み。ここ自体が失敗してもジョブは落とさない
async function writeFetchLog(result, logger) {
  try {
    await db.insertFetchLog(result);
  } catch (err) {
    logger.error(`[${result.platform}] fetch_logs への書き込みに失敗しました:`, err);
  }
}

// 1 プラットフォーム分の取得と保存
// 入力: adapter(platforms/ のモジュール)、runAt(ISO 文字列)、logger
// 出力: fetch_logs に書いた内容 { run_at, platform, status, error_message, records_fetched }
async function runPlatform(adapter, runAt, logger) {
  const platform = adapter.PLATFORM;
  const startedAt = Date.now();  // 所要時間の計測用(終了ログに出す。Application Insights で推移を追える)

  const result = {
    run_at: runAt,
    platform: platform,
    status: "success",
    error_message: null,
    records_fetched: 0,
  };

  // ---- 1. API から追跡対象 mod の一覧を取得 ----
  let mods;
  try {
    mods = await adapter.fetchTrackedMods(logger);
  } catch (err) {
    // API 自体が取れなければ、このプラットフォームの処理はここで終わり。ログだけ残す
    logger.error(`[${platform}] API 取得に失敗しました:`, err);
    result.status = "failed";
    result.error_message = `API 取得失敗: ${err.message}`;
    await writeFetchLog(result, logger);
    logger.log(`取得ジョブ終了: platform=${platform}, status=${result.status}, 保存件数=0, 所要時間=${Date.now() - startedAt}ms`);
    return result;
  }

  // ---- 2. 1 件ずつ保存(失敗しても次へ進む) ----
  const failedNames = [];
  for (const mod of mods) {
    try {
      await saveMod(platform, mod, runAt);
      result.records_fetched++;
    } catch (err) {
      logger.error(`[${platform}] ${mod.name} の保存に失敗しました:`, err);
      failedNames.push(`${mod.name}: ${err.message}`);
    }
  }

  // 1 件でも失敗があれば status を failed にし、何が失敗したかを残す
  if (failedNames.length > 0) {
    result.status = "failed";
    result.error_message = `${failedNames.length} 件の保存に失敗: ` + failedNames.join(" / ");
  }

  // ---- 3. 実行記録を保存 ----
  await writeFetchLog(result, logger);
  logger.log(`取得ジョブ終了: platform=${platform}, status=${result.status}, 保存件数=${result.records_fetched}, 所要時間=${Date.now() - startedAt}ms`);
  return result;
}

// 取得ジョブ本体: 全プラットフォームを順番に処理する
async function runFetchJob(logger) {
  // この実行の日時。全プラットフォーム・全 mod のスナップショットに同じ値を入れることで
  // 「同じ回の取得」であることが分かるようにする
  const runAt = new Date().toISOString();
  logger.log(`取得ジョブ開始: ${runAt}`);

  const results = [];
  for (const adapter of PLATFORM_ADAPTERS) {
    results.push(await runPlatform(adapter, runAt, logger));
  }

  return { run_at: runAt, results: results };
}

module.exports = { runFetchJob };
