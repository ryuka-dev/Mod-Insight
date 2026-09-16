// ============================================================
// platforms.test.js
//
// 配布サイトのアダプター(platforms/thunderstore.js、platforms/nexusmods.js)のテスト。
//
// 本物の API にはつながない。Node.js 標準の fetch を node:test の mock で差し替え、
// 「API がこの JSON を返したら、共通の形はこうなる」を確かめる。
// 固定の JSON は実際の応答から必要な項目だけ抜き出したもの。
//
// 確かめていること:
//   Thunderstore: 作者と非推奨での絞り込み、versions[].downloads の合計、日付の切り出し
//   Nexus Mods:   ページ繰り返し、同じバージョン番号のファイルのまとめ(合計・最古の日付)、
//                 ファイル一覧が取れない mod をバージョン無しで続行すること、GraphQL の errors
// ============================================================

const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const thunderstore = require("../src/platforms/thunderstore");
const nexusmods = require("../src/platforms/nexusmods");

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

afterEach(() => {
  mock.restoreAll();
});

describe("thunderstore.fetchTrackedMods", () => {
  const packages = [
    {
      name: "SULFUR_Together",
      owner: "ryuka_labs",
      is_deprecated: false,
      rating_score: 2,
      versions: [
        { version_number: "1.4.1", downloads: 300, date_created: "2026-09-12T10:00:00.000000Z" },
        { version_number: "1.4.0", downloads: 1200, date_created: "2026-09-01T10:00:00.000000Z" },
      ],
    },
    {
      name: "Old_Upload",
      owner: "ryuka_labs",
      is_deprecated: true,
      rating_score: 0,
      versions: [{ version_number: "1.0.0", downloads: 5, date_created: "2026-01-01T00:00:00.000000Z" }],
    },
    {
      name: "SomeoneElses_Mod",
      owner: "someone_else",
      is_deprecated: false,
      rating_score: 9,
      versions: [{ version_number: "2.0.0", downloads: 99999, date_created: "2026-05-05T00:00:00.000000Z" }],
    },
  ];

  test("作者のパッケージだけを共通の形にし、非推奨と他の作者は除く", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse(packages));

    const mods = await thunderstore.fetchTrackedMods(silentLogger);

    assert.equal(mods.length, 1);
    const mod = mods[0];
    assert.equal(mod.name, "SULFUR_Together");
    assert.equal(mod.author, "ryuka_labs");
    assert.equal(mod.external_id, "ryuka_labs/SULFUR_Together");
    assert.equal(mod.is_deprecated, false);
    assert.equal(mod.download_count, 1500);   // 300 + 1200(API に総数の項目が無いので合計する)
    assert.equal(mod.rating_score, 2);
    assert.deepEqual(mod.versions, [
      { version_number: "1.4.1", release_date: "2026-09-12", download_count: 300 },
      { version_number: "1.4.0", release_date: "2026-09-01", download_count: 1200 },
    ]);
    assert.deepEqual(JSON.parse(mod.raw_json), packages[0]);
  });

  test("API を 1 回だけ呼び、ブラウザの User-Agent を付ける", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => jsonResponse(packages));

    await thunderstore.fetchTrackedMods(silentLogger);

    assert.equal(fetchMock.mock.callCount(), 1);
    const [url, options] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, "https://thunderstore.io/c/sulfur/api/v1/package/");
    assert.match(options.headers["User-Agent"], /Mozilla/);
  });

  test("HTTP エラーは例外になる", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse({}, 503));

    await assert.rejects(() => thunderstore.fetchTrackedMods(silentLogger), /HTTP 503/);
  });
});

describe("nexusmods.fetchTrackedMods", () => {
  // mods 問い合わせと modFiles 問い合わせを、送られてきた GraphQL の本文で見分けて応答する
  function fakeNexusApi({ modsPages, filesByModId, filesError }) {
    let modsCall = 0;
    return async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes("modFiles(")) {
        const modId = body.variables.modId;
        if (filesError && filesError.includes(modId)) {
          return jsonResponse({ errors: [{ message: "file list unavailable" }] });
        }
        return jsonResponse({ data: { modFiles: filesByModId[modId] || [] } });
      }
      const page = modsPages[modsCall] || { nodes: [] };
      modsCall++;
      return jsonResponse({ data: { mods: { totalCount: page.totalCount, nodes: page.nodes } } });
    };
  }

  const modTogether = {
    modId: 94, gameId: 6991, name: "SULFUR Together", version: "1.4.1", status: "published",
    downloads: 2000, endorsements: 30, uploader: { name: "ryukalabs", memberId: 288522512 },
  };
  const modHidden = {
    modId: 95, gameId: 6991, name: "Hidden Mod", version: "1.0.0", status: "hidden",
    downloads: 10, endorsements: 0, uploader: { name: "ryukalabs", memberId: 288522512 },
  };

  test("共通の形に直し、同じバージョン番号のファイルはまとめる", async () => {
    mock.method(globalThis, "fetch", fakeNexusApi({
      modsPages: [{ totalCount: 1, nodes: [modTogether] }],
      filesByModId: {
        "94": [
          // 1.3.0 は ARCHIVED と OLD_VERSION の 2 ファイル → 合計し、公開日は古い方
          { fileId: 1, name: "a", version: "1.3.0", date: 1756684800, category: "OLD_VERSION", totalDownloads: 700, uniqueDownloads: 500 },
          { fileId: 2, name: "b", version: "1.3.0", date: 1756598400, category: "ARCHIVED", totalDownloads: 100, uniqueDownloads: 80 },
          { fileId: 3, name: "c", version: "1.4.1", date: 1757635200, category: "MAIN", totalDownloads: 1200, uniqueDownloads: 900 },
        ],
      },
    }));

    const mods = await nexusmods.fetchTrackedMods(silentLogger);

    assert.equal(mods.length, 1);
    const mod = mods[0];
    assert.equal(mod.name, "SULFUR Together");
    assert.equal(mod.author, "ryukalabs");
    assert.equal(mod.external_id, "sulfur/94");
    assert.equal(mod.is_deprecated, false);
    assert.equal(mod.download_count, 2000);   // Nexus が持つ総数をそのまま使う(ファイルの合計ではない)
    assert.equal(mod.rating_score, 30);
    assert.deepEqual(mod.versions, [
      { version_number: "1.3.0", release_date: "2025-08-31", download_count: 800 },
      { version_number: "1.4.1", release_date: "2025-09-12", download_count: 1200 },
    ]);
    assert.deepEqual(Object.keys(JSON.parse(mod.raw_json)), ["mod", "files"]);
  });

  test("published 以外は非推奨扱いになる", async () => {
    mock.method(globalThis, "fetch", fakeNexusApi({
      modsPages: [{ totalCount: 1, nodes: [modHidden] }],
      filesByModId: {},
    }));

    const mods = await nexusmods.fetchTrackedMods(silentLogger);

    assert.equal(mods[0].is_deprecated, true);
    assert.deepEqual(mods[0].versions, []);
  });

  test("mods はページを繰り返して全件集める", async () => {
    const fetchMock = mock.method(globalThis, "fetch", fakeNexusApi({
      modsPages: [
        { totalCount: 2, nodes: [modTogether] },
        { totalCount: 2, nodes: [modHidden] },
      ],
      filesByModId: {},
    }));

    const mods = await nexusmods.fetchTrackedMods(silentLogger);

    assert.deepEqual(mods.map((m) => m.external_id), ["sulfur/94", "sulfur/95"]);
    // mods 2 ページ + modFiles 2 回
    assert.equal(fetchMock.mock.callCount(), 4);
  });

  test("ファイル一覧が取れない mod はバージョン無しで続け、他の mod は普通に処理する", async () => {
    const errors = [];
    mock.method(globalThis, "fetch", fakeNexusApi({
      modsPages: [{ totalCount: 2, nodes: [modTogether, modHidden] }],
      filesByModId: { "95": [{ fileId: 9, name: "x", version: "1.0.0", date: 1756684800, category: "MAIN", totalDownloads: 10, uniqueDownloads: 10 }] },
      filesError: ["94"],
    }));

    const mods = await nexusmods.fetchTrackedMods({ log() {}, warn() {}, error: (m) => errors.push(m) });

    assert.equal(mods.length, 2);
    assert.deepEqual(mods[0].versions, []);
    assert.equal(mods[1].versions.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /ファイル一覧の取得に失敗/);
  });

  test("mods 問い合わせ自体が GraphQL の errors を返したら例外になる", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse({ errors: [{ message: "rate limited" }] }));

    await assert.rejects(() => nexusmods.fetchTrackedMods(silentLogger), /rate limited/);
  });
});
