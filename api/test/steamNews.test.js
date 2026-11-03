// ============================================================
// steamNews.test.js
//
// Steam のお知らせのアダプター(steamNews.js)のテスト。
//
// 本物の API にはつながない。toEvents には固定の JSON を渡し、
// fetchGameEvents は Node.js 標準の fetch を node:test の mock で差し替えて確かめる。
// 固定の JSON は 2026-11-03 の実際の応答から必要な項目だけ抜き出したもの。
//
// 確かめていること:
//   - 公式のお知らせ(feedname = steam_community_announcements)だけを取り込むこと
//   - tags に patchnotes があれば game_patch、無ければ(tags が無い時も)game_news になること
//   - 形のおかしいお知らせ(gid が数字でない、date が数値でない、見出しが空)は捨てること
//   - 見出しと URL を列の長さで切り詰め、http / https 以外の URL は null にすること
//   - API を 1 回だけ、User-Agent と待つ上限を付けて呼ぶこと
//   - HTTP エラーと、応答に newsitems が無い時は例外になること
// ============================================================

const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const steamNews = require("../src/steamNews");

const silentLogger = { log() {}, warn() {}, error() {} };

// fetch の応答を真似た最小限のオブジェクト
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  };
}

// newsitems の 1 件を作る(指定しなかった項目は実際の応答と同じ形の値)
function newsItem(overrides) {
  return {
    gid: "1847920302242010",
    title: "Patch Notes 1.0.2",
    url: "https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1847920302242010",
    is_external_url: true,
    author: "Perfect Random",
    contents: "P",
    feedlabel: "Community Announcements",
    date: 1793450451,   // 2026-10-31T12:40:51Z
    feedname: "steam_community_announcements",
    feed_type: 1,
    appid: 2124120,
    tags: ["patchnotes"],
    ...overrides,
  };
}

// API の応答全体の形にする
function newsResponse(items) {
  return { appnews: { appid: 2124120, newsitems: items, count: items.length } };
}

afterEach(() => {
  mock.restoreAll();
});

describe("steamNews.toEvents", () => {
  test("公式のお知らせを出来事の共通の形にする", () => {
    const events = steamNews.toEvents(newsResponse([newsItem({})]));

    assert.deepEqual(events, [{
      occurred_at: "2026-10-31T12:40:51.000Z",
      kind: "game_patch",
      title: "Patch Notes 1.0.2",
      url: "https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1847920302242010",
      source: "steam",
      external_id: "1847920302242010",
    }]);
  });

  test("外部サイトの記事(公式以外の feedname)は取り込まない", () => {
    const events = steamNews.toEvents(newsResponse([
      newsItem({ gid: "1", feedname: "PlayGround.ru - официальная группа", tags: undefined }),
      newsItem({ gid: "2" }),
    ]));

    assert.deepEqual(events.map((e) => e.external_id), ["2"]);
  });

  test("tags に patchnotes が無ければ game_news(tags が無い時も同じ)", () => {
    const events = steamNews.toEvents(newsResponse([
      // 実際の「SULFUR 1.0 OUT NOW」は patchnotes 以外のタグだけが付いていた
      newsItem({ gid: "1", title: "SULFUR 1.0 OUT NOW", tags: ["mod_reviewed", "mod_require_rereview"] }),
      newsItem({ gid: "2", title: "SULFUR has sold 500,000 copies!", tags: undefined }),
      newsItem({ gid: "3", title: "Patch Notes 1.0.1", tags: ["patchnotes"] }),
    ]));

    assert.deepEqual(events.map((e) => [e.external_id, e.kind]), [
      ["1", "game_news"],
      ["2", "game_news"],
      ["3", "game_patch"],
    ]);
  });

  test("見出しに 1.0 と書いてあっても game_major にはしない(手で付け替える)", () => {
    const events = steamNews.toEvents(newsResponse([newsItem({ title: "SULFUR 1.0 OUT NOW", tags: [] })]));

    assert.equal(events[0].kind, "game_news");
  });

  test("gid が数字だけでない、date が数値でない、見出しが空のお知らせは捨てる", () => {
    const events = steamNews.toEvents(newsResponse([
      newsItem({ gid: "abc" }),
      newsItem({ gid: 1847920302242010 }),          // 数値で来た(文字列でない)
      newsItem({ gid: "" }),
      newsItem({ gid: "10", date: "1793450451" }),  // 文字列で来た
      newsItem({ gid: "11", date: Infinity }),
      newsItem({ gid: "12", date: 1e20 }),           // 数値だが日時にできない
      newsItem({ gid: "13", title: "   " }),
      newsItem({ gid: "14", title: null }),
      null,
      newsItem({ gid: "99" }),
    ]));

    assert.deepEqual(events.map((e) => e.external_id), ["99"]);
  });

  test("見出しは 300 文字で切り詰めて前後の空白を除き、500 文字を超える URL は null にする", () => {
    const longTitle = "あ".repeat(400);
    const longUrl = "https://example.com/" + "a".repeat(600);
    const events = steamNews.toEvents(newsResponse([newsItem({ title: `  ${longTitle}  `, url: longUrl })]));

    assert.equal(events[0].title, "あ".repeat(300));
    assert.equal(events[0].url, null);
  });

  test("URL が文字列でない、または http / https でなければ null", () => {
    const events = steamNews.toEvents(newsResponse([
      newsItem({ gid: "1", url: undefined }),
      newsItem({ gid: "2", url: 123 }),
      newsItem({ gid: "3", url: "javascript:alert(1)" }),
      newsItem({ gid: "4", url: "http://example.com/news" }),
    ]));

    assert.deepEqual(events.map((e) => e.url), [null, null, null, "http://example.com/news"]);
  });

  test("応答に newsitems の配列が無ければ例外を投げる", () => {
    assert.throws(() => steamNews.toEvents({}), /newsitems/);
    assert.throws(() => steamNews.toEvents({ appnews: { newsitems: "x" } }), /newsitems/);
    assert.throws(() => steamNews.toEvents(null), /newsitems/);
  });
});

describe("steamNews.fetchGameEvents", () => {
  test("API を 1 回だけ呼び、User-Agent と待つ上限を付ける", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => jsonResponse(newsResponse([newsItem({})])));

    const events = await steamNews.fetchGameEvents(silentLogger);

    assert.equal(events.length, 1);
    assert.equal(fetchMock.mock.callCount(), 1);
    const [url, options] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=2124120&count=50&maxlength=1&format=json");
    assert.match(options.headers["User-Agent"], /Mozilla/);
    assert.ok(options.signal instanceof AbortSignal);
  });

  test("HTTP エラーは例外になる", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse({}, 503));

    await assert.rejects(() => steamNews.fetchGameEvents(silentLogger), /HTTP 503/);
  });

  test("時間内に応答が無ければ、秒数の分かるメッセージの例外になる", async () => {
    mock.method(globalThis, "fetch", async () => {
      // AbortSignal.timeout が時間切れになった時に fetch が投げるのと同じ名前のエラー
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    await assert.rejects(() => steamNews.fetchGameEvents(silentLogger), /30 秒以内に応答しませんでした/);
  });
});
