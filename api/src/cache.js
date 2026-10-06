// ============================================================
// cache.js
//
// GET API が返す JSON を Blob Storage に置いておく「読み取りキャッシュ」。
//
// なぜ必要か:
//   DB(Azure SQL サーバーレス)は使われない時間が続くと自動で一時停止し、
//   次の接続に約 50 秒かかる(docs/ops-log.md 1 章)。データは取得ジョブが
//   1 日 1 回書く時にしか変わらないので、GET API はその時点の結果を
//   Blob から返せば DB を起こさずに済む。
//
// 仕組み:
//   - 取得ジョブ(fetchJob.js)が保存を終えた直後に rebuildAll() を呼び、
//     すべての Blob を作り直す(この時 DB は起きているので追加の待ち時間はない)
//   - GET API は read() / readForMod() で Blob を読み、無ければ従来どおり DB に問い合わせる
//   - Blob の中身は { run_at, generated_at, data } の形。data が API の応答そのもの。
//     run_at は取得ジョブの実行日時で、「どの回のデータか」を表す版の印になる
//
// 保存先:
//   環境変数 CACHE_STORAGE_CONNECTION_STRING の Storage アカウント、コンテナー "api-cache"
//   未設定ならキャッシュは使わない(読みは常に「無し」、書きは何もしない)。
//   AzureWebJobsStorage と同じアカウントを指してよいが、設定名を分けているのは
//   ローカル実行で本物の Storage を使っても、タイマーの状態ファイルを共有しないため。
//
// Blob の名前:
//   mods.json                            GET /api/mods
//   mods/{modId}/summary.json            GET /api/mods/{modId}/summary
//   mods/{modId}/snapshots.json          GET /api/mods/{modId}/snapshots(全期間)
//   mods/{modId}/versions.json           GET /api/mods/{modId}/versions
//   mods/{modId}/version-snapshots.json  GET /api/mods/{modId}/version-snapshots(全期間)
//   overview.json                        GET /api/overview の材料(全期間・全プラットフォーム)
//   fetch-logs.json                      GET /api/fetch/logs(新しい順に最大 200 件)
//   costs.json                           GET /api/costs(costs.js が save() で書く。DB から作らない唯一の Blob)
//   from / to / platform / limit の絞り込みは Blob を分けず、読んだ後に JS で行う。
//
// 方針: このモジュールの関数は例外を外に投げない。
//   読めなければ null(呼び出し側が DB にフォールバックする)、
//   書けなければログを出して終わり(取得ジョブの結果には影響しない)。
// ============================================================

const { BlobServiceClient } = require("@azure/storage-blob");
const db = require("./db");

const CONTAINER_NAME = "api-cache";

// fetch-logs.json に入れる件数(GET /api/fetch/logs の limit の上限と同じ)
const FETCH_LOGS_CACHE_LIMIT = 200;

// mod ごとの Blob の種類(readForMod / rebuildAll で使う)
const MOD_KINDS = ["summary", "snapshots", "versions", "version-snapshots"];

// コンテナーのクライアント。最初の呼び出しで作り、以降は使い回す
let containerClient = null;

// 入力: なし
// 出力: ContainerClient、または設定が無ければ null
function getContainer() {
  const connectionString = process.env.CACHE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    return null;
  }
  if (!containerClient) {
    containerClient = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(CONTAINER_NAME);
  }
  return containerClient;
}

// mod ごとの Blob の名前を作る
function modBlobName(modId, kind) {
  return `mods/${modId}/${kind}.json`;
}

// Blob を 1 つ読む
// 入力: name(Blob の名前)、logger(context または console)
// 出力: { run_at, generated_at, data } または null(未設定 / 無い / 読めない / 形がおかしい)
async function read(name, logger) {
  const container = getContainer();
  if (!container) {
    return null;
  }
  try {
    const buffer = await container.getBlockBlobClient(name).downloadToBuffer();
    const entry = JSON.parse(buffer.toString("utf8"));
    if (!entry || typeof entry !== "object" || !("data" in entry) || typeof entry.run_at !== "string") {
      logger.warn(`キャッシュ ${name} の形が想定と違うため無視します(DB にフォールバックします)`);
      return null;
    }
    return entry;
  } catch (err) {
    if (err.statusCode === 404) {
      // まだ作られていない(取得ジョブが一度も走っていない、または新しい mod)。正常な「無し」
      return null;
    }
    logger.warn(`キャッシュ ${name} の読み取りに失敗しました(DB にフォールバックします): ${err.message}`);
    return null;
  }
}

// mod ごとの Blob を読む。mod が存在しないことをキャッシュだけで判定できる時はそれも返す
// 入力: modId(数値)、kind(MOD_KINDS のいずれか)、logger
// 出力: { status: "hit", entry }   Blob があった
//       { status: "not_found" }    Blob が無く、mods.json にもその mod_id が無い(404 にしてよい)
//       { status: "miss" }         Blob が無く、mods.json も無い(DB に問い合わせる)
// 存在しない mod_id で DB を起こさないために mods.json を見ている。
async function readForMod(modId, kind, logger) {
  const entry = await read(modBlobName(modId, kind), logger);
  if (entry) {
    return { status: "hit", entry: entry };
  }
  const mods = await read("mods.json", logger);
  if (mods && Array.isArray(mods.data) && !mods.data.some((m) => m.mod_id === modId)) {
    return { status: "not_found" };
  }
  return { status: "miss" };
}

// Blob を 1 つ書く(上書き)。失敗時は例外を投げる(rebuildAll がまとめて捕捉する)
// 入力: container、name、runAt(ISO 文字列)、data(JSON にできるもの)
async function write(container, name, runAt, data) {
  const body = JSON.stringify({
    run_at: runAt,
    generated_at: new Date().toISOString(),
    data: data,
  });
  await container.getBlockBlobClient(name).upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" },
  });
}

// DB 以外から作る Blob を 1 つ書く(上書き)。今は costs.json だけ
// 入力: name(Blob の名前)、runAt(取得ジョブの実行日時、ISO 文字列)、data、logger
// 出力: 書けたら true、未設定か失敗なら false。例外は投げない
async function save(name, runAt, data, logger) {
  const container = getContainer();
  if (!container) {
    logger.log(`CACHE_STORAGE_CONNECTION_STRING が未設定のため、${name} は書きません`);
    return false;
  }
  try {
    await container.createIfNotExists();
    await write(container, name, runAt, data);
    return true;
  } catch (err) {
    // 文言はアラート(docs/alerts/alert-fetch-job-health.json)が探している「キャッシュの更新に失敗」に合わせる
    logger.error(`キャッシュの更新に失敗しました(${name}):`, err);
    return false;
  }
}

// すべての Blob を DB の内容から作り直す。取得ジョブの最後に呼ぶ
// 入力: runAt(取得ジョブの実行日時、ISO 文字列)、logger
// 出力: なし。失敗してもここでログを出すだけで、例外は投げない
// 順番: mods.json → mod ごとの 4 種類 → overview.json → fetch-logs.json
async function rebuildAll(runAt, logger) {
  const container = getContainer();
  if (!container) {
    logger.log("CACHE_STORAGE_CONNECTION_STRING が未設定のため、キャッシュは作りません");
    return;
  }

  const startedAt = Date.now();
  let written = 0;
  try {
    await container.createIfNotExists();

    const mods = await db.listMods();
    await write(container, "mods.json", runAt, mods);
    written++;

    for (const mod of mods) {
      const id = mod.mod_id;
      await write(container, modBlobName(id, "summary"), runAt, await db.getModSummary(id));
      await write(container, modBlobName(id, "snapshots"), runAt, await db.listSnapshots(id, null, null));
      await write(container, modBlobName(id, "versions"), runAt, await db.listModVersions(id));
      await write(container, modBlobName(id, "version-snapshots"), runAt, await db.listVersionSnapshots(id, null, null));
      written += MOD_KINDS.length;
    }

    // 一覧画面の材料: 各 mod の最新値(絞り込み無しの getOverview から)と、全 mod の履歴
    const overview = await db.getOverview(null, null);
    const history = await db.listSnapshotHistory();
    await write(container, "overview.json", runAt, {
      mods: overview.mods.map((m) => ({
        mod_id: m.mod_id,
        name: m.name,
        platform: m.platform,
        captured_at: m.captured_at,
        latest_download_count: m.latest_download_count,
        rating_score: m.rating_score,
        latest_version: m.latest_version,
        latest_release_date: m.latest_release_date,
      })),
      history: history,
    });
    written++;

    await write(container, "fetch-logs.json", runAt, await db.listFetchLogs(FETCH_LOGS_CACHE_LIMIT));
    written++;

    logger.log(`キャッシュ更新完了: run_at=${runAt}, Blob 数=${written}, 所要時間=${Date.now() - startedAt}ms`);
  } catch (err) {
    logger.error(`キャッシュの更新に失敗しました(${written} 件書いた後。API は DB にフォールバックします):`, err);
  }
}

// overview.json の材料から、db.getOverview(from, platform) と同じ形を作る
// 入力: data(overview.json の data)、from(Date または null)、platform(文字列または null)
// 出力: { mods: [...], totals: [...] }(db.getOverview と同じ)
// SQL 版との対応:
//   mods                  is_deprecated = 0 の mod を platform で絞る(順番は SQL のまま)
//   start_download_count  その mod の履歴のうち captured_at >= from で最初の行の値(無ければ null)
//   totals                platform で絞った全 mod(is_deprecated を問わない)の履歴を captured_at ごとに合計
function buildOverview(data, from, platform) {
  const fromMs = from ? from.getTime() : null;

  const mods = data.mods.filter((m) => platform === null || m.platform === platform);

  const startByMod = new Map();   // mod_id → 期間開始後で最初のダウンロード数
  const totalsByTime = new Map(); // captured_at → { captured_at, download_count, mod_count }
  for (const row of data.history) {
    if (platform !== null && row.platform !== platform) {
      continue;
    }
    if (fromMs !== null && new Date(row.captured_at).getTime() < fromMs) {
      continue;
    }
    // 履歴は mod ごとに古い順なので、最初に見つかった行が期間開始後の最初の値
    if (!startByMod.has(row.mod_id)) {
      startByMod.set(row.mod_id, row.download_count);
    }
    let total = totalsByTime.get(row.captured_at);
    if (!total) {
      total = { captured_at: row.captured_at, download_count: 0, mod_count: 0 };
      totalsByTime.set(row.captured_at, total);
    }
    total.download_count += row.download_count;
    total.mod_count += 1;
  }

  const totals = Array.from(totalsByTime.values());
  totals.sort((a, b) => (a.captured_at < b.captured_at ? -1 : a.captured_at > b.captured_at ? 1 : 0));

  return {
    mods: mods.map((m) => ({
      ...m,
      start_download_count: startByMod.has(m.mod_id) ? startByMod.get(m.mod_id) : null,
    })),
    totals: totals,
  };
}

module.exports = { read, readForMod, save, rebuildAll, buildOverview, FETCH_LOGS_CACHE_LIMIT };
