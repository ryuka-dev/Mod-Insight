// ============================================================
// db.js
//
// Azure SQL Database への書き込みをまとめたモジュール。
// mssql パッケージ(内部で tedious ドライバーを使用)を利用する。
//
// 接続情報は環境変数 AZURE_SQL_CONNECTION_STRING から読み込む。
//   - ローカル実行時: api/local.settings.json の Values に書く(Git には含めない)
//   - Azure 上: Function App のアプリケーション設定に登録する
// 接続文字列の形式は mssql に解釈を任せ、このモジュールでは決め打ちしない。
//
// 接続プールは 1 つだけ作り、関数の呼び出しをまたいで使い回す。
// (Azure Functions では同じプロセスが複数回の実行を処理するため、
//  毎回接続し直すより速く、接続数の上限にも当たりにくい)
//
// 提供する関数(書き込み。取得ジョブから使う):
//   upsertMod(mod)              mods テーブルへ MERGE(あれば更新、なければ挿入)し、mod_id を返す
//   upsertModVersion(version)   mod_versions テーブルへ MERGE(同じ mod_id + version_number があれば何もしない)し、version_id を返す
//   insertVersionSnapshot(vs)   version_snapshots テーブルへ 1 行 INSERT する
//   insertSnapshot(snapshot)    snapshots テーブルへ 1 行 INSERT する
//   insertFetchLog(log)         fetch_logs テーブルへ 1 行 INSERT する(プラットフォームごとに 1 行)
//
// 提供する関数(読み取り。HTTP API から使う):
//   listMods()                  追跡中の mod 一覧
//   getModById(modId)           mod 1 件(なければ null)
//   getModSummary(modId)        最新スナップショットと最新バージョンをまとめたもの(なければ null)
//   listSnapshots(modId, from, to)  期間指定つきの時系列データ(古い順)
//   listModVersions(modId)      バージョン履歴(新しい順)
//   listVersionSnapshots(modId, from, to)  バージョンごとの時系列データ(古い順)
//   getOverview(from, platform) 全 mod の最新値と期間開始時点の値、合計の推移(platform で絞り込める)
//   listSnapshotHistory()       全 mod のダウンロード数の履歴(一覧画面のキャッシュ用)
//   listFetchLogs(limit)        取得ジョブの実行記録(新しい順。プラットフォームごとに 1 行)
// ============================================================

const sql = require("mssql");

// 接続プール(の Promise)。最初の呼び出しで作成し、以降は使い回す。
// 接続に失敗した場合は null に戻して、次回の呼び出しで再接続を試みる。
let poolPromise = null;

// 接続エラーを「何が原因か」が分かる日本語メッセージに変換する
// 入力: mssql / tedious が投げたエラー
// 出力: 原因の分類と元のエラー内容を含む文字列(接続文字列やパスワードは含めない)
function describeConnectionError(err) {
  const code = err.code || "";
  const number = err.number || (err.originalError && err.originalError.info && err.originalError.info.number) || 0;
  const message = err.message || String(err);

  // Azure SQL のファイアウォールで拒否された場合(エラー番号 40615)
  // メッセージに接続元 IP が含まれるので、そのまま Azure Portal で許可すればよい
  if (number === 40615 || /not allowed to access the server/i.test(message)) {
    return `【SQL Server ファイアウォール / ネットワークの問題】接続元 IP がサーバーのファイアウォールで許可されていません。Azure Portal の SQL Server > ネットワーク で IP を許可するか、「Azure サービスからのアクセスを許可」を有効にしてください。詳細: ${message}`;
  }

  // ホスト名が解決できない、TCP 接続できない、タイムアウトなど
  if (["ESOCKET", "ETIMEOUT", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN"].includes(code)) {
    return `【SQL Server ファイアウォール / ネットワークの問題】サーバーに到達できません(code=${code})。サーバー名・ポート(1433)・ファイアウォール設定を確認してください。詳細: ${message}`;
  }

  // ログイン失敗(ユーザー名・パスワード違い、または認証方式の不一致)
  if (code === "ELOGIN" || number === 18456) {
    return `【接続文字列 / 認証の問題】ログインに失敗しました。ユーザー名・パスワード・認証方式(User ID / Password / Authentication=...)を確認してください。詳細: ${message}`;
  }

  // データベースが開けない(名前違い、一時停止中、存在しない)
  if (number === 4060 || number === 40613 || /cannot open database/i.test(message)) {
    return `【データベース本体の問題】データベースを開けません(number=${number})。Database= の名前が正しいか、データベースが一時停止・削除されていないか確認してください。詳細: ${message}`;
  }

  // 接続文字列そのものを解釈できなかった場合(mssql が構文エラーを投げる)
  if (/connection string/i.test(message) || code === "EARGS") {
    return `【接続文字列 / 認証の問題】接続文字列を解釈できませんでした。形式を確認してください。詳細: ${message}`;
  }

  return `【原因不明の接続エラー】code=${code || "なし"}, number=${number || "なし"}。詳細: ${message}`;
}

// 接続プールを取得する(なければ作る)
// 出力: 接続済みの sql.ConnectionPool
// 失敗時: describeConnectionError で分類したメッセージを持つ例外を投げる
function getPool() {
  if (poolPromise) {
    return poolPromise;
  }

  poolPromise = (async () => {
    const connectionString = process.env.AZURE_SQL_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error(
        "【接続文字列 / 認証の問題】環境変数 AZURE_SQL_CONNECTION_STRING が設定されていません。ローカルでは api/local.settings.json の Values に、Azure では Function App のアプリケーション設定に登録してください。"
      );
    }

    try {
      // 接続文字列の解釈は mssql に任せる(形式をここで決め打ちしない)
      const pool = new sql.ConnectionPool(connectionString);
      await pool.connect();
      console.log("Azure SQL Database に接続しました");
      return pool;
    } catch (err) {
      throw new Error(describeConnectionError(err));
    }
  })();

  // 失敗したら次回また接続を試みられるようにキャッシュを捨てる
  poolPromise.catch(() => {
    poolPromise = null;
  });

  return poolPromise;
}

// mods テーブルへ挿入または更新する
// 入力: { name, author, platform, external_id, is_deprecated }
// 出力: mod_id(数値)
// (platform, external_id) が一致する行があれば name / author / is_deprecated を更新し、
// なければ新規挿入する。どちらの場合もその行の mod_id を返す。
async function upsertMod(mod) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("name", sql.NVarChar(200), mod.name)
    .input("author", sql.NVarChar(200), mod.author)
    .input("platform", sql.NVarChar(20), mod.platform)
    .input("external_id", sql.NVarChar(200), mod.external_id)
    .input("is_deprecated", sql.Bit, mod.is_deprecated)
    .query(`
      MERGE mods AS target
      USING (SELECT @platform AS platform, @external_id AS external_id) AS source
        ON target.platform = source.platform AND target.external_id = source.external_id
      WHEN MATCHED THEN
        UPDATE SET name = @name, author = @author, is_deprecated = @is_deprecated
      WHEN NOT MATCHED THEN
        INSERT (name, author, platform, external_id, is_deprecated)
        VALUES (@name, @author, @platform, @external_id, @is_deprecated)
      OUTPUT inserted.mod_id;
    `);

  return result.recordset[0].mod_id;
}

// snapshots テーブルへ 1 行挿入する
// 入力: { mod_id, captured_at(ISO 文字列), download_count, rating_score, raw_json }
// 出力: なし
async function insertSnapshot(snapshot) {
  const pool = await getPool();

  await pool
    .request()
    .input("mod_id", sql.Int, snapshot.mod_id)
    .input("captured_at", sql.DateTime2, new Date(snapshot.captured_at))
    .input("download_count", sql.Int, snapshot.download_count)
    .input("rating_score", sql.Int, snapshot.rating_score)
    .input("raw_json", sql.NVarChar(sql.MAX), snapshot.raw_json)
    .query(`
      INSERT INTO snapshots (mod_id, captured_at, download_count, rating_score, raw_json)
      VALUES (@mod_id, @captured_at, @download_count, @rating_score, @raw_json);
    `);
}

// fetch_logs テーブルへ 1 行挿入する
// 入力: { run_at(ISO 文字列), platform, status, error_message, records_fetched }
// 出力: なし
// 1 回の取得ジョブでプラットフォームごとに 1 行書く(run_at は同じ値、platform が違う)。
// 失敗時は例外を投げるが、呼び出し側(fetchJob.js の writeFetchLog)が捕捉するため
// ジョブ全体が止まることはない。
async function insertFetchLog(log) {
  const pool = await getPool();

  await pool
    .request()
    .input("run_at", sql.DateTime2, new Date(log.run_at))
    .input("platform", sql.NVarChar(20), log.platform)
    .input("status", sql.NVarChar(20), log.status)
    .input("error_message", sql.NVarChar(sql.MAX), log.error_message)
    .input("records_fetched", sql.Int, log.records_fetched)
    .query(`
      INSERT INTO fetch_logs (run_at, platform, status, error_message, records_fetched)
      VALUES (@run_at, @platform, @status, @error_message, @records_fetched);
    `);
}

// mod_versions テーブルへ挿入する(既にあれば何もしない)
// 入力: { mod_id, version_number, release_date(YYYY-MM-DD 文字列 or null) }
// 出力: version_id(数値)
// バージョンは一度公開されたら変わらないので、(mod_id, version_number) が一致する行が
// 既にあれば更新もせずそのまま残す。取得ジョブは毎日全バージョンをこの関数に通すため、
// 新しく公開されたバージョンだけが自然に追加されていく。
// MERGE のあとに SELECT で version_id を取り直しているのは、
// 「既にあった」場合には MERGE が何も返さないため。
async function upsertModVersion(version) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("mod_id", sql.Int, version.mod_id)
    .input("version_number", sql.NVarChar(50), version.version_number)
    .input("release_date", sql.Date, version.release_date)
    .query(`
      MERGE mod_versions AS target
      USING (SELECT @mod_id AS mod_id, @version_number AS version_number) AS source
        ON target.mod_id = source.mod_id AND target.version_number = source.version_number
      WHEN NOT MATCHED THEN
        INSERT (mod_id, version_number, release_date)
        VALUES (@mod_id, @version_number, @release_date);

      SELECT version_id
      FROM mod_versions
      WHERE mod_id = @mod_id AND version_number = @version_number;
    `);

  return result.recordset[0].version_id;
}

// version_snapshots テーブルへ 1 行挿入する
// 入力: { version_id, captured_at(ISO 文字列), download_count }
// 出力: なし
async function insertVersionSnapshot(versionSnapshot) {
  const pool = await getPool();

  await pool
    .request()
    .input("version_id", sql.Int, versionSnapshot.version_id)
    .input("captured_at", sql.DateTime2, new Date(versionSnapshot.captured_at))
    .input("download_count", sql.Int, versionSnapshot.download_count)
    .query(`
      INSERT INTO version_snapshots (version_id, captured_at, download_count)
      VALUES (@version_id, @captured_at, @download_count);
    `);
}

// ============================================================
// ここから下は HTTP API 用の読み取り関数。
// すべて SELECT だけで、テーブルを変更しない。
// 返す行の列名はテーブルの列名そのまま(フロントエンドもこの名前で受け取る)。
// ============================================================

// 追跡中の mod 一覧を返す
// 出力: [{ mod_id, name, author, platform, external_id, is_deprecated, created_at }, ...]
//       name の五十音・アルファベット順
async function listMods() {
  const pool = await getPool();

  const result = await pool.request().query(`
    SELECT mod_id, name, author, platform, external_id, is_deprecated, created_at
    FROM mods
    ORDER BY name;
  `);

  return result.recordset;
}

// mod を 1 件取得する
// 入力: modId(数値)
// 出力: { mod_id, name, author, platform, external_id, is_deprecated, created_at } または null
async function getModById(modId) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("mod_id", sql.Int, modId)
    .query(`
      SELECT mod_id, name, author, platform, external_id, is_deprecated, created_at
      FROM mods
      WHERE mod_id = @mod_id;
    `);

  return result.recordset.length > 0 ? result.recordset[0] : null;
}

// mod の「今の状態」をまとめて返す(サマリー表示用)
// 入力: modId(数値)
// 出力: {
//   mod:            getModById と同じ内容
//   latest_snapshot: { captured_at, download_count, rating_score } または null(まだ 1 回も取得していない場合)
//   latest_version:  { version_number, release_date } または null
//   version_count:   登録済みバージョン数
// } または null(mod 自体が存在しない場合)
// 3 回に分けて SELECT している。1 本の SQL にまとめることもできるが、
// 読みやすさを優先して「何を取っているか」が分かる形にしている。
async function getModSummary(modId) {
  const mod = await getModById(modId);
  if (!mod) {
    return null;
  }

  const pool = await getPool();

  // 最新のスナップショット(captured_at が一番新しい 1 行)
  const snapshotResult = await pool
    .request()
    .input("mod_id", sql.Int, modId)
    .query(`
      SELECT TOP 1 captured_at, download_count, rating_score
      FROM snapshots
      WHERE mod_id = @mod_id
      ORDER BY captured_at DESC;
    `);

  // 最新バージョン(release_date が一番新しい 1 行)とバージョン数
  const versionResult = await pool
    .request()
    .input("mod_id", sql.Int, modId)
    .query(`
      SELECT TOP 1 version_number, release_date
      FROM mod_versions
      WHERE mod_id = @mod_id
      ORDER BY release_date DESC, version_id DESC;

      SELECT COUNT(*) AS version_count
      FROM mod_versions
      WHERE mod_id = @mod_id;
    `);

  return {
    mod: mod,
    latest_snapshot: snapshotResult.recordset.length > 0 ? snapshotResult.recordset[0] : null,
    latest_version: versionResult.recordsets[0].length > 0 ? versionResult.recordsets[0][0] : null,
    version_count: versionResult.recordsets[1][0].version_count,
  };
}

// 時系列データ(グラフ用)を古い順に返す
// 入力: modId(数値)、from / to(Date または null。null なら期間の下限・上限なし)
// 出力: [{ captured_at, download_count, rating_score }, ...]
// raw_json は大きいので返さない。
async function listSnapshots(modId, from, to) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("mod_id", sql.Int, modId)
    .input("from", sql.DateTime2, from)
    .input("to", sql.DateTime2, to)
    .query(`
      SELECT captured_at, download_count, rating_score
      FROM snapshots
      WHERE mod_id = @mod_id
        AND (@from IS NULL OR captured_at >= @from)
        AND (@to IS NULL OR captured_at <= @to)
      ORDER BY captured_at ASC;
    `);

  return result.recordset;
}

// バージョン履歴を新しい順に返す
// 入力: modId(数値)
// 出力: [{ version_id, version_number, release_date, changelog }, ...]
async function listModVersions(modId) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("mod_id", sql.Int, modId)
    .query(`
      SELECT version_id, version_number, release_date, changelog
      FROM mod_versions
      WHERE mod_id = @mod_id
      ORDER BY release_date DESC, version_id DESC;
    `);

  return result.recordset;
}

// バージョンごとの時系列データを古い順に返す(バージョン別グラフ用)
// 入力: modId(数値)、from / to(Date または null)
// 出力: [{ version_number, release_date, captured_at, download_count }, ...]
//       同じ captured_at の中ではバージョンの公開日順
async function listVersionSnapshots(modId, from, to) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("mod_id", sql.Int, modId)
    .input("from", sql.DateTime2, from)
    .input("to", sql.DateTime2, to)
    .query(`
      SELECT v.version_number, v.release_date, vs.captured_at, vs.download_count
      FROM version_snapshots vs
      INNER JOIN mod_versions v ON v.version_id = vs.version_id
      WHERE v.mod_id = @mod_id
        AND (@from IS NULL OR vs.captured_at >= @from)
        AND (@to IS NULL OR vs.captured_at <= @to)
      ORDER BY vs.captured_at ASC, v.release_date ASC, v.version_id ASC;
    `);

  return result.recordset;
}

// 全 mod の一覧画面用のデータをまとめて返す
// 入力: from(Date または null。期間の開始。null なら「最初の取得」から)
//       platform(文字列または null。'thunderstore' / 'nexusmods' で絞り込む。null なら全プラットフォーム)
// 出力: {
//   mods:   [{ mod_id, name, platform, captured_at, latest_download_count, rating_score,
//              start_download_count, latest_version, latest_release_date }, ...]  ※ 最新ダウンロード数の多い順
//   totals: [{ captured_at, download_count, mod_count }, ...]  ※ 取得回ごとの全 mod 合計(古い順)
// }
// 1 mod につき「最新のスナップショット」「期間開始後で最初のスナップショット」「最新バージョン」を
// 1 行ずつ選ぶために ROW_NUMBER() を使っている。
// ROW_NUMBER() OVER (PARTITION BY mod_id ORDER BY captured_at DESC) は
// 「mod ごとに captured_at の新しい順で 1, 2, 3... と番号を振る」という意味で、
// 番号が 1 の行だけ残せば「mod ごとに一番新しい 1 行」になる。
// 合計の推移(2 つ目の SELECT)も platform で絞るため mods と JOIN している。
// 取得ジョブは全プラットフォームに同じ captured_at を入れるので、絞らない場合は
// 両方のプラットフォームを足した合計になる。
async function getOverview(from, platform) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("from", sql.DateTime2, from)
    .input("platform", sql.NVarChar(20), platform)
    .query(`
      WITH latest AS (
        SELECT mod_id, captured_at, download_count, rating_score,
               ROW_NUMBER() OVER (PARTITION BY mod_id ORDER BY captured_at DESC) AS rn
        FROM snapshots
      ),
      start_point AS (
        SELECT mod_id, download_count,
               ROW_NUMBER() OVER (PARTITION BY mod_id ORDER BY captured_at ASC) AS rn
        FROM snapshots
        WHERE (@from IS NULL OR captured_at >= @from)
      ),
      latest_version AS (
        SELECT mod_id, version_number, release_date,
               ROW_NUMBER() OVER (PARTITION BY mod_id ORDER BY release_date DESC, version_id DESC) AS rn
        FROM mod_versions
      )
      SELECT m.mod_id, m.name, m.platform,
             l.captured_at, l.download_count AS latest_download_count, l.rating_score,
             sp.download_count AS start_download_count,
             lv.version_number AS latest_version, lv.release_date AS latest_release_date
      FROM mods m
      LEFT JOIN latest l ON l.mod_id = m.mod_id AND l.rn = 1
      LEFT JOIN start_point sp ON sp.mod_id = m.mod_id AND sp.rn = 1
      LEFT JOIN latest_version lv ON lv.mod_id = m.mod_id AND lv.rn = 1
      WHERE m.is_deprecated = 0
        AND (@platform IS NULL OR m.platform = @platform)
      ORDER BY l.download_count DESC, m.name ASC;

      SELECT s.captured_at, SUM(s.download_count) AS download_count, COUNT(*) AS mod_count
      FROM snapshots s
      INNER JOIN mods m ON m.mod_id = s.mod_id
      WHERE (@from IS NULL OR s.captured_at >= @from)
        AND (@platform IS NULL OR m.platform = @platform)
      GROUP BY s.captured_at
      ORDER BY s.captured_at ASC;
    `);

  return {
    mods: result.recordsets[0],
    totals: result.recordsets[1],
  };
}

// 全 mod のダウンロード数の履歴を返す(一覧画面のキャッシュを作るため)
// 出力: [{ mod_id, platform, captured_at, download_count }, ...]  ※ mod_id 順、同じ mod の中は古い順
// getOverview は from / platform を SQL の中で絞り込むが、キャッシュ(cache.js)は
// 「全期間・全プラットフォーム」の履歴を 1 つ置いておき、絞り込みは読む側の JS で行う。
// そのための材料を取る関数。getOverview の合計の推移と同じく is_deprecated では絞らない
// (絞り込みは読む側で getOverview と同じ条件で行う)。
async function listSnapshotHistory() {
  const pool = await getPool();

  const result = await pool.request().query(`
    SELECT s.mod_id, m.platform, s.captured_at, s.download_count
    FROM snapshots s
    INNER JOIN mods m ON m.mod_id = s.mod_id
    ORDER BY s.mod_id ASC, s.captured_at ASC;
  `);

  return result.recordset;
}

// 取得ジョブの実行記録を新しい順に返す
// 入力: limit(返す最大件数)
// 出力: [{ log_id, run_at, platform, status, error_message, records_fetched }, ...]
async function listFetchLogs(limit) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("limit", sql.Int, limit)
    .query(`
      SELECT TOP (@limit) log_id, run_at, platform, status, error_message, records_fetched
      FROM fetch_logs
      ORDER BY run_at DESC, platform ASC;
    `);

  return result.recordset;
}

module.exports = {
  upsertMod,
  upsertModVersion,
  insertVersionSnapshot,
  insertSnapshot,
  insertFetchLog,
  listMods,
  getModById,
  getModSummary,
  listSnapshots,
  listModVersions,
  listVersionSnapshots,
  getOverview,
  listSnapshotHistory,
  listFetchLogs,
};
