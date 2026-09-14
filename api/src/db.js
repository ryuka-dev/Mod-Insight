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
// 提供する関数:
//   upsertMod(mod)            mods テーブルへ MERGE(あれば更新、なければ挿入)し、mod_id を返す
//   insertSnapshot(snapshot)  snapshots テーブルへ 1 行 INSERT する
//   insertFetchLog(log)       fetch_logs テーブルへ 1 行 INSERT する
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
// 入力: { run_at(ISO 文字列), status, error_message, records_fetched }
// 出力: なし
// 失敗時は例外を投げるが、呼び出し側(fetchJob.js の writeFetchLog)が捕捉するため
// ジョブ全体が止まることはない。
async function insertFetchLog(log) {
  const pool = await getPool();

  await pool
    .request()
    .input("run_at", sql.DateTime2, new Date(log.run_at))
    .input("status", sql.NVarChar(20), log.status)
    .input("error_message", sql.NVarChar(sql.MAX), log.error_message)
    .input("records_fetched", sql.Int, log.records_fetched)
    .query(`
      INSERT INTO fetch_logs (run_at, status, error_message, records_fetched)
      VALUES (@run_at, @status, @error_message, @records_fetched);
    `);
}

module.exports = { upsertMod, insertSnapshot, insertFetchLog };
