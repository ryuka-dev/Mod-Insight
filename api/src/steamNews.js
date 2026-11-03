// ============================================================
// steamNews.js
//
// Steam から「ゲーム本体のお知らせ」(パッチノート、正式リリースの告知など)を取ってくるアダプター。
// 取得ジョブ(fetchJob.js)がこれを events テーブルに保存し、
// ダッシュボードでダウンロード数のグラフに出来事として重ねる(sql/004_create_events.sql)。
//
// このファイルの役目は「Steam の API の形」を「出来事の共通の形」に直すことだけ。
// DB への保存は fetchJob.js と db.js が行い、そちらは Steam の項目名を知らない。
//
// 出来事の共通の形(1 件分):
//   {
//     occurred_at: 出来事の日時(ISO 文字列、UTC)
//     kind:        'game_patch'(パッチノート)または 'game_news'(それ以外のお知らせ)
//     title:       見出し(最大 300 文字)
//     url:         詳細のページ(500 文字以内。無い、または長すぎれば null)
//     source:      'steam'
//     external_id: Steam でのお知らせの ID(gid、数字だけの文字列)
//   }
//
// 使う API:
//   GET https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=2124120&count=50&maxlength=1&format=json
//   認証不要(2026-11-03 に実測して確認)。応答は { appnews: { appid, newsitems: [...], count } }。
//   newsitems の 1 件: { gid, title, url, author, contents, feedlabel, date(UNIX 秒), feedname, tags(無いこともある), ... }
//
// 取り込むもの・取り込まないもの:
//   - feedname が "steam_community_announcements" のものだけ取り込む。
//     それ以外は外部のニュースサイトの記事(例: PlayGround.ru)で、開発元の発表ではないため
//   - tags に "patchnotes" があれば 'game_patch'、無ければ 'game_news'。
//     'game_major'(正式リリースなどの大型アップデート)はお知らせの内容からは判定できないので、
//     ここでは付けず、手で付け替える(sql/004 の「使い方」)。見出しの文字で推測することもしない
//
// 日時についての注意:
//   date はお知らせを投稿した日時で、ゲームの更新が実際に配信された日時と同じとは限らない
//   (パッチの配信より少し前や後に投稿されることがある)。グラフの印としては日付が分かれば足りる。
//
// 応答は外から来るデータなので、そのまま信じない:
//   gid が数字だけでない、date が数値でない、見出しが空、のどれかに当たるお知らせは捨てる。
//   見出しは DB の列の長さに合わせて切り詰める。URL は途中で切ると開けないリンクになるので、長すぎれば null にする。
// ============================================================

// この出来事の取得元(events.source に入れる値)
const SOURCE = "steam";

// SULFUR の Steam アプリ ID(ストアページ store.steampowered.com/app/2124120 の番号)
const STEAM_APP_ID = 2124120;

// 1 回に取るお知らせの件数。毎日「最新の 50 件」を取り直すので、
// ある日の取得に失敗しても次の日に取り戻せ、初回の実行で過去の分もまとめて入る
// (SULFUR のお知らせは月に 5〜8 件ほどで、2026-11-03 時点の 50 件は 2026-01 までさかのぼる。
//  ダウンロード数の記録を始めた 2026-09 より前まで届くので、初回の実行で記録期間の分はそろう)
const NEWS_COUNT = 50;

// maxlength=1 は本文(contents)を 1 文字に切り詰めてもらう指定。本文は使わないので、応答を小さくする
const API_URL =
  `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${STEAM_APP_ID}&count=${NEWS_COUNT}&maxlength=1&format=json`;

// 開発元の公式のお知らせの feedname(これ以外は外部サイトの記事)
const OFFICIAL_FEED_NAME = "steam_community_announcements";

// パッチノートに付くタグ
const PATCH_NOTES_TAG = "patchnotes";

// DB の列の長さ(sql/004 の events.title NVARCHAR(300)、events.url NVARCHAR(500))
// NVARCHAR の長さは JavaScript の文字列の length と同じ数え方(UTF-16 の単位)なので、slice で合わせられる
const TITLE_MAX_LENGTH = 300;
const URL_MAX_LENGTH = 500;

// API の呼び出しを何秒まで待つか。普段は 1 秒もかからない。
// 取得ジョブの後ろの段階が返ってこないままログが途切れた日があったため(Issue #33)、待ち続けずに失敗として扱う
const REQUEST_TIMEOUT_MS = 30 * 1000;

// 一般的なブラウザの User-Agent(UA なしのリクエストを拒否するサイトがあるため。platforms/ と同じ)
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Steam のお知らせ 1 件を出来事の共通の形に直す
// 入力: item(newsitems の 1 件)
// 出力: 出来事の共通の形、または取り込まないものなら null
function toEvent(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  // 公式のお知らせだけ
  if (item.feedname !== OFFICIAL_FEED_NAME) {
    return null;
  }
  // gid は数字だけの文字列(events.external_id NVARCHAR(100) に入る長さまで)
  if (typeof item.gid !== "string" || !/^[0-9]{1,100}$/.test(item.gid)) {
    return null;
  }
  // date は UNIX 秒の数値。日時にできないものは捨てる
  if (typeof item.date !== "number" || !Number.isFinite(item.date)) {
    return null;
  }
  const occurredAt = new Date(item.date * 1000);
  if (Number.isNaN(occurredAt.getTime())) {
    return null;
  }
  // 見出しが無いと、グラフに出しても何の印か分からないので捨てる
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (title === "") {
    return null;
  }
  // URL はダッシュボードでリンクにするので、http / https のものだけ残す(それ以外は null)。
  // 列に入らない長さのものも null にする(途中で切ると開けないリンクになるため)
  let url = null;
  if (typeof item.url === "string" && /^https?:\/\//.test(item.url) && item.url.length <= URL_MAX_LENGTH) {
    url = item.url;
  }
  // tags は付いていないお知らせもある
  const isPatchNotes = Array.isArray(item.tags) && item.tags.includes(PATCH_NOTES_TAG);

  return {
    occurred_at: occurredAt.toISOString(),
    kind: isPatchNotes ? "game_patch" : "game_news",
    title: title.slice(0, TITLE_MAX_LENGTH),
    url: url,
    source: SOURCE,
    external_id: item.gid,
  };
}

// API の応答全体を出来事の配列に直す
// 入力: json(API の応答をそのまま JSON として読んだもの)
// 出力: 出来事の共通の形の配列(順番は応答のまま。取り込まないものは除く)
// 応答に appnews.newsitems の配列が無ければ例外を投げる(API の形が変わった可能性がある)
function toEvents(json) {
  if (!json || !json.appnews || !Array.isArray(json.appnews.newsitems)) {
    throw new Error("Steam News API の応答に appnews.newsitems の配列がありません");
  }
  const events = [];
  for (const item of json.appnews.newsitems) {
    const event = toEvent(item);
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}

// Steam のお知らせを取得し、出来事の共通の形で返す
// 入力: logger(log メソッドを持つもの)
// 出力: 出来事の共通の形の配列
// API に届かない・エラーを返す・時間内に返らない・形が違う場合は例外を投げる(呼び出し側で捕捉する)
async function fetchGameEvents(logger) {
  let response;
  try {
    response = await fetch(API_URL, {
      method: "GET",
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`Steam News API が ${REQUEST_TIMEOUT_MS / 1000} 秒以内に応答しませんでした`);
    }
    throw err;
  }

  if (!response.ok) {
    throw new Error(`Steam News API がエラーを返しました: HTTP ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const events = toEvents(json);
  logger.log(`[${SOURCE}] お知らせ取得成功: ${json.appnews.newsitems.length} 件中、取り込み対象 ${events.length} 件`);
  return events;
}

module.exports = { SOURCE, fetchGameEvents, toEvents };
