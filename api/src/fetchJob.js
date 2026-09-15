// ============================================================
// fetchJob.js
//
// Thunderstore からデータを取得して DB に保存する処理の本体。
//
// タイマー関数(functions/FetchThunderstoreDataTimer.js)と
// 手動実行 API(functions/RunFetch.js、POST /api/fetch/run)の両方から呼ばれる。
// ローカルでの動作確認(node -e "require('./src/fetchJob').runFetchJob(console)")も同じ関数で行える。
// トリガーの種類に関係なく同じ処理を通すため、トリガーとは別ファイルに分けている。
//
// 処理の流れ:
//   1. Thunderstore の v1 コミュニティ API から全パッケージ一覧を取得
//   2. owner が ryuka_labs で、かつ is_deprecated が false のものだけ残す
//   3. 各パッケージについて
//        - versions[].downloads を合計して総ダウンロード数を計算
//        - mods テーブルへ UPSERT(platform='thunderstore', external_id='ryuka_labs/{mod名}')
//        - versions[] の各バージョンを mod_versions テーブルへ UPSERT(新しいものだけ増える)
//        - snapshots テーブルへ 1 行 INSERT
//      ※ 1 件で失敗しても他のパッケージの処理は続ける
//   4. 最後に fetch_logs へ実行結果を 1 行 INSERT
//
// 入力: logger(context または console。log / error メソッドを持つもの)
// 出力: { run_at, status, error_message, records_fetched } ※ fetch_logs に書いた内容と同じ
// ============================================================

const db = require("./db");

// Thunderstore sulfur コミュニティの v1 パッケージ一覧 API
const THUNDERSTORE_API_URL = "https://thunderstore.io/c/sulfur/api/v1/package/";

// 追跡対象の作者名
const TARGET_OWNER = "ryuka_labs";

// この取得ジョブが扱うプラットフォーム名(mods.platform に入れる値)
const PLATFORM = "thunderstore";

// 一般的なブラウザの User-Agent(UA なしのリクエストを拒否するサイトがあるため)
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Thunderstore API から全パッケージ一覧を取得する
// 出力: パッケージオブジェクトの配列
// HTTP ステータスが 2xx 以外なら例外を投げる
async function fetchAllPackages() {
  const response = await fetch(THUNDERSTORE_API_URL, {
    method: "GET",
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Thunderstore API がエラーを返しました: HTTP ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

// 1 パッケージの総ダウンロード数を計算する
// API には「総ダウンロード数」の項目がないため、全バージョンの downloads を合計する
// 入力: パッケージオブジェクト(versions 配列を持つ)
// 出力: 合計ダウンロード数(整数)
function sumDownloads(pkg) {
  let total = 0;
  for (const version of pkg.versions) {
    total += version.downloads;
  }
  return total;
}

// 1 パッケージ分を DB に保存する(mods の UPSERT、mod_versions の UPSERT、snapshots の INSERT)
// 入力: パッケージオブジェクト、取得日時(ISO 文字列)
// 出力: なし(失敗時は例外を投げる。呼び出し側で捕捉する)
async function savePackage(pkg, capturedAt) {
  // mods テーブル用のデータ
  const modRecord = {
    name: pkg.name,
    author: pkg.owner,
    platform: PLATFORM,
    external_id: `${pkg.owner}/${pkg.name}`,
    is_deprecated: pkg.is_deprecated ? 1 : 0,
  };
  const modId = await db.upsertMod(modRecord);

  // mod_versions テーブル用のデータ(バージョンごとに 1 行)
  // date_created は "2025-03-01T12:34:56.789Z" のような ISO 文字列なので、先頭 10 文字 = 日付部分だけ使う
  for (const version of pkg.versions) {
    await db.upsertModVersion({
      mod_id: modId,
      version_number: version.version_number,
      release_date: version.date_created ? version.date_created.slice(0, 10) : null,
    });
  }

  // snapshots テーブル用のデータ
  const snapshotRecord = {
    mod_id: modId,
    captured_at: capturedAt,
    download_count: sumDownloads(pkg),
    rating_score: pkg.rating_score,
    raw_json: JSON.stringify(pkg),
  };
  await db.insertSnapshot(snapshotRecord);
}

// fetch_logs への書き込み。ここ自体が失敗してもジョブは落とさない
async function writeFetchLog(result, logger) {
  try {
    await db.insertFetchLog(result);
  } catch (err) {
    logger.error("fetch_logs への書き込みに失敗しました:", err);
  }
}

// 取得ジョブ本体
async function runFetchJob(logger) {
  // この実行の日時。全 mod のスナップショットに同じ値を入れることで
  // 「同じ回の取得」であることが分かるようにする
  const runAt = new Date().toISOString();
  logger.log(`取得ジョブ開始: ${runAt}`);

  // fetch_logs に書く結果。処理の途中で更新していく
  const result = {
    run_at: runAt,
    status: "success",
    error_message: null,
    records_fetched: 0,
  };

  // ---- 1. API からパッケージ一覧を取得 ----
  let allPackages;
  try {
    allPackages = await fetchAllPackages();
    logger.log(`API 取得成功: コミュニティ全体で ${allPackages.length} 件`);
  } catch (err) {
    // API 自体が取れなければ、この回の処理はここで終わり。ただしジョブは落とさずログだけ残す
    logger.error("API 取得に失敗しました:", err);
    result.status = "failed";
    result.error_message = `API 取得失敗: ${err.message}`;
    await writeFetchLog(result, logger);
    return result;
  }

  // ---- 2. 対象パッケージだけに絞り込む ----
  const targetPackages = allPackages.filter(
    (pkg) => pkg.owner === TARGET_OWNER && pkg.is_deprecated === false
  );
  logger.log(`対象パッケージ: ${targetPackages.length} 件(owner=${TARGET_OWNER}, 非推奨を除く)`);

  // ---- 3. 1 件ずつ保存(失敗しても次へ進む) ----
  const failedNames = [];
  for (const pkg of targetPackages) {
    try {
      await savePackage(pkg, runAt);
      result.records_fetched++;
    } catch (err) {
      logger.error(`パッケージ ${pkg.name} の保存に失敗しました:`, err);
      failedNames.push(`${pkg.name}: ${err.message}`);
    }
  }

  // 1 件でも失敗があれば status を failed にし、何が失敗したかを残す
  if (failedNames.length > 0) {
    result.status = "failed";
    result.error_message = `${failedNames.length} 件の保存に失敗: ` + failedNames.join(" / ");
  }

  // ---- 4. 実行記録を保存 ----
  await writeFetchLog(result, logger);
  logger.log(`取得ジョブ終了: status=${result.status}, 保存件数=${result.records_fetched}`);
  return result;
}

module.exports = { runFetchJob };
