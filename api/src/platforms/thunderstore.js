// ============================================================
// platforms/thunderstore.js
//
// Thunderstore から「追跡対象の mod の今の値」を取ってくるアダプター。
//
// このファイルの役目は「Thunderstore の API の形」を「このプロジェクト共通の形」に直すことだけ。
// DB への保存は fetchJob.js が行い、そちらは Thunderstore の項目名を一切知らない。
// Nexus Mods 用の platforms/nexusmods.js も同じ形を返すので、
// 保存処理は 1 つで済み、プラットフォームが増えても保存処理を書き足さなくてよい。
//
// 共通の形(fetchJob.js の説明も参照):
//   {
//     name:           表示名
//     author:         作者名(そのプラットフォーム上の名前)
//     external_id:    そのプラットフォーム上で mod を一意に指す文字列("ryuka_labs/SULFUR_Together")
//     is_deprecated:  非推奨・非公開なら true
//     download_count: 総ダウンロード数
//     rating_score:   評価(Thunderstore では rating_score)
//     raw_json:       API の応答そのもの(文字列)。あとで項目を足したくなったときのために残す
//     versions: [{ version_number, release_date(YYYY-MM-DD or null), download_count }, ...]
//   }
//
// 使う API:
//   GET https://thunderstore.io/c/sulfur/api/v1/package/
//   sulfur コミュニティの全パッケージ一覧を一度に返す。認証不要。
//   総ダウンロード数の項目がないので versions[].downloads を合計して求める。
// ============================================================

// この取得ジョブが扱うプラットフォーム名(mods.platform に入れる値)
const PLATFORM = "thunderstore";

// Thunderstore sulfur コミュニティの v1 パッケージ一覧 API
const API_URL = "https://thunderstore.io/c/sulfur/api/v1/package/";

// 追跡対象の作者名(Thunderstore 上の owner)
const TARGET_OWNER = "ryuka_labs";

// 一般的なブラウザの User-Agent(UA なしのリクエストを拒否するサイトがあるため)
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Thunderstore API から全パッケージ一覧を取得する
// 出力: パッケージオブジェクトの配列
// HTTP ステータスが 2xx 以外なら例外を投げる
async function fetchAllPackages() {
  const response = await fetch(API_URL, {
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
function sumDownloads(pkg) {
  let total = 0;
  for (const version of pkg.versions) {
    total += version.downloads;
  }
  return total;
}

// Thunderstore の 1 パッケージを共通の形に直す
// date_created は "2025-03-01T12:34:56.789Z" のような ISO 文字列なので、先頭 10 文字 = 日付部分だけ使う
function toCommonShape(pkg) {
  return {
    name: pkg.name,
    author: pkg.owner,
    external_id: `${pkg.owner}/${pkg.name}`,
    is_deprecated: pkg.is_deprecated === true,
    download_count: sumDownloads(pkg),
    rating_score: pkg.rating_score,
    raw_json: JSON.stringify(pkg),
    versions: pkg.versions.map((version) => ({
      version_number: version.version_number,
      release_date: version.date_created ? version.date_created.slice(0, 10) : null,
      download_count: version.downloads,
    })),
  };
}

// 追跡対象の mod を共通の形で返す
// 入力: logger(log メソッドを持つもの)
// 出力: 共通の形の配列(owner が ryuka_labs で、非推奨でないものだけ)
// API に届かない・エラーを返す場合は例外を投げる(呼び出し側で捕捉する)
async function fetchTrackedMods(logger) {
  const allPackages = await fetchAllPackages();
  logger.log(`[${PLATFORM}] API 取得成功: コミュニティ全体で ${allPackages.length} 件`);

  const targetPackages = allPackages.filter(
    (pkg) => pkg.owner === TARGET_OWNER && pkg.is_deprecated === false
  );
  logger.log(`[${PLATFORM}] 対象パッケージ: ${targetPackages.length} 件(owner=${TARGET_OWNER}, 非推奨を除く)`);

  return targetPackages.map(toCommonShape);
}

module.exports = { PLATFORM, fetchTrackedMods };
