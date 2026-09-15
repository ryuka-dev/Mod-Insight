// ============================================================
// platforms/nexusmods.js
//
// Nexus Mods から「追跡対象の mod の今の値」を取ってくるアダプター。
// platforms/thunderstore.js と同じ「共通の形」を返す(形の説明はそちらを参照)。
//
// 使う API: Nexus Mods の GraphQL v2
//   POST https://api.nexusmods.com/v2/graphql
//   - 公開情報の読み取りは API キーなしで呼べる(2026-09-15 に実測して確認)
//   - REST の v1 API(/v1/games/{game}/mods/{id}.json)は個人 API キーが必要で、
//     しかも「作者名で mod 一覧を引く」手段がないため使わない
//
// 2 種類の問い合わせをする:
//   1. mods(filter: { gameDomainName: "sulfur", uploaderId: <会員番号> })
//        → 作者がアップロードした mod の一覧。downloads(総DL数)、endorsements(評価)、version、status
//   2. modFiles(modId, gameId)
//        → その mod にアップロードされたファイルの一覧。version、date(UNIX 秒)、totalDownloads
//        mod ごとに 1 回呼ぶので、mod が 24 個なら合計 25 回のリクエストになる
//
// バージョンについての注意:
//   Nexus Mods は「バージョン」ではなく「ファイル」の単位でダウンロード数を数える。
//   同じバージョン番号のファイルが複数あることがある(古いファイルを ARCHIVED にして
//   同じ番号で上げ直した場合など)ので、バージョン番号ごとに totalDownloads を合計して
//   1 バージョン 1 行にそろえる。公開日はそのバージョンで一番古いファイルの日付にする。
//   総ダウンロード数は mods の downloads をそのまま使う(ファイル合計と 1〜2 件ずれることがあるが、
//   Nexus Mods 自身が表示している数字を優先する)。
// ============================================================

// この取得ジョブが扱うプラットフォーム名(mods.platform に入れる値)
const PLATFORM = "nexusmods";

// Nexus Mods の GraphQL v2 エンドポイント
const API_URL = "https://api.nexusmods.com/v2/graphql";

// 追跡対象のゲーム(URL に出てくるドメイン名)と作者(Nexus Mods の会員番号)
// 会員番号で絞るのは、表示名は変更できるが会員番号は変わらないため
const GAME_DOMAIN = "sulfur";
const UPLOADER_ID = "288522512";  // ryukalabs

// 1 回の mods 問い合わせで受け取る最大件数(API 側の上限は 50 前後なので、それより小さくして安全側に)
const PAGE_SIZE = 50;

// 一般的なブラウザの User-Agent(UA なしのリクエストを拒否するサイトがあるため)
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// GraphQL の問い合わせを 1 回送る
// 入力: query(GraphQL 文字列)、variables(変数オブジェクト)
// 出力: 応答の data 部分
// HTTP エラー、または応答に errors が含まれる場合は例外を投げる
async function graphql(query, variables) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": BROWSER_USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Nexus Mods API がエラーを返しました: HTTP ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  if (body.errors && body.errors.length > 0) {
    // GraphQL は HTTP 200 でも errors 配列で失敗を伝えてくることがある
    throw new Error(`Nexus Mods API がエラーを返しました: ${body.errors.map((e) => e.message).join(" / ")}`);
  }
  return body.data;
}

// 作者の mod 一覧を取得する(ページを繰り返して全件集める)
// 出力: mod オブジェクトの配列
async function fetchAllMods() {
  const query = `
    query ($filter: ModsFilter, $count: Int, $offset: Int) {
      mods(filter: $filter, count: $count, offset: $offset, sort: [{ downloads: { direction: DESC } }]) {
        totalCount
        nodes {
          modId gameId name version status
          downloads endorsements
          createdAt updatedAt
          author
          uploader { name memberId }
        }
      }
    }
  `;
  const filter = {
    gameDomainName: [{ value: GAME_DOMAIN, op: "EQUALS" }],
    uploaderId: [{ value: UPLOADER_ID, op: "EQUALS" }],
  };

  const mods = [];
  let offset = 0;
  while (true) {
    const data = await graphql(query, { filter, count: PAGE_SIZE, offset });
    const page = data.mods.nodes;
    mods.push(...page);
    offset += page.length;
    // 全件そろったか、これ以上ページがなければ終わり
    if (page.length === 0 || offset >= data.mods.totalCount) {
      break;
    }
  }
  return mods;
}

// 1 つの mod のファイル一覧を取得する
// 出力: ファイルオブジェクトの配列
async function fetchModFiles(mod) {
  const query = `
    query ($modId: ID!, $gameId: ID!) {
      modFiles(modId: $modId, gameId: $gameId) {
        fileId name version date category totalDownloads uniqueDownloads
      }
    }
  `;
  const data = await graphql(query, { modId: String(mod.modId), gameId: String(mod.gameId) });
  return data.modFiles;
}

// ファイル一覧をバージョン番号ごとにまとめる
// 入力: ファイルオブジェクトの配列
// 出力: [{ version_number, release_date, download_count }, ...]
//       同じバージョン番号のファイルはダウンロード数を合計し、公開日は一番古いものにする
function groupFilesByVersion(files) {
  const byVersion = new Map();  // version_number → { version_number, release_date, download_count }
  for (const file of files) {
    // date は UNIX 秒なのでミリ秒に直してから日付部分(YYYY-MM-DD)を取る
    const releaseDate = file.date ? new Date(file.date * 1000).toISOString().slice(0, 10) : null;
    const existing = byVersion.get(file.version);
    if (existing) {
      existing.download_count += file.totalDownloads;
      if (releaseDate && (existing.release_date === null || releaseDate < existing.release_date)) {
        existing.release_date = releaseDate;
      }
    } else {
      byVersion.set(file.version, {
        version_number: file.version,
        release_date: releaseDate,
        download_count: file.totalDownloads,
      });
    }
  }
  return [...byVersion.values()];
}

// Nexus Mods の 1 mod(+ファイル一覧)を共通の形に直す
function toCommonShape(mod, files) {
  return {
    name: mod.name,
    author: mod.uploader.name,
    external_id: `${GAME_DOMAIN}/${mod.modId}`,   // 例: "sulfur/94"(mod ページの URL と同じ番号)
    is_deprecated: mod.status !== "published",   // 非公開・削除済みなどは非推奨扱い
    download_count: mod.downloads,
    rating_score: mod.endorsements,
    raw_json: JSON.stringify({ mod, files }),
    versions: groupFilesByVersion(files),
  };
}

// 追跡対象の mod を共通の形で返す
// 入力: logger(log メソッドを持つもの)
// 出力: 共通の形の配列
// mod 一覧が取れない場合は例外を投げる。ファイル一覧が取れない mod は
// バージョンなし(versions: [])のまま返し、他の mod の処理は続ける
async function fetchTrackedMods(logger) {
  const mods = await fetchAllMods();
  logger.log(`[${PLATFORM}] API 取得成功: ${mods.length} 件(game=${GAME_DOMAIN}, uploaderId=${UPLOADER_ID})`);

  const result = [];
  for (const mod of mods) {
    let files = [];
    try {
      files = await fetchModFiles(mod);
    } catch (err) {
      logger.error(`[${PLATFORM}] ${mod.name} のファイル一覧の取得に失敗しました(バージョン情報なしで続行):`, err);
    }
    result.push(toCommonShape(mod, files));
  }
  return result;
}

module.exports = { PLATFORM, fetchTrackedMods };
