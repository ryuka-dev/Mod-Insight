// ============================================================
// cache.test.js
//
// cache.js のうち、Blob Storage につながずに確かめられる部分のテスト。
//   - buildOverview: 全期間・全プラットフォームの材料から from / platform で絞る計算が
//     db.getOverview の SQL と同じ結果になること
//   - read / readForMod: 設定(CACHE_STORAGE_CONNECTION_STRING)が無い時は
//     例外を出さずに「キャッシュ無し」を返し、呼び出し側が DB にフォールバックできること
// Blob の読み書きそのものは本物の Storage が要るので、ここでは扱わない。
// ============================================================

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const cache = require("../src/cache");

// ログを捨てる logger(テスト中に出力を汚さない)
const silentLogger = { log() {}, warn() {}, error() {} };

// overview.json の data と同じ形の材料。
// mod 1 と 3 が thunderstore、2 が nexusmods。3 は is_deprecated なので mods には入っていないが
// 履歴には入っている(SQL 版の合計の推移も is_deprecated で絞らないため)。
const material = {
  mods: [
    { mod_id: 1, name: "A", platform: "thunderstore", captured_at: "2026-09-16T00:00:00.000Z", latest_download_count: 120, rating_score: 2, latest_version: "1.1.0", latest_release_date: "2026-09-10" },
    { mod_id: 2, name: "B", platform: "nexusmods", captured_at: "2026-09-16T00:00:00.000Z", latest_download_count: 50, rating_score: 7, latest_version: "1.0.0", latest_release_date: "2026-09-01" },
  ],
  history: [
    { mod_id: 1, platform: "thunderstore", captured_at: "2026-09-14T00:00:00.000Z", download_count: 100 },
    { mod_id: 1, platform: "thunderstore", captured_at: "2026-09-15T00:00:00.000Z", download_count: 110 },
    { mod_id: 1, platform: "thunderstore", captured_at: "2026-09-16T00:00:00.000Z", download_count: 120 },
    { mod_id: 2, platform: "nexusmods", captured_at: "2026-09-15T00:00:00.000Z", download_count: 40 },
    { mod_id: 2, platform: "nexusmods", captured_at: "2026-09-16T00:00:00.000Z", download_count: 50 },
    { mod_id: 3, platform: "thunderstore", captured_at: "2026-09-16T00:00:00.000Z", download_count: 1000 },
  ],
};

describe("buildOverview", () => {
  test("絞り込み無し: 起点は各 mod の最初の値、合計は取得回ごとに全 mod を足す", () => {
    const result = cache.buildOverview(material, null, null);

    assert.deepEqual(result.mods.map((m) => [m.mod_id, m.start_download_count]), [[1, 100], [2, 40]]);
    assert.deepEqual(result.totals, [
      { captured_at: "2026-09-14T00:00:00.000Z", download_count: 100, mod_count: 1 },
      { captured_at: "2026-09-15T00:00:00.000Z", download_count: 150, mod_count: 2 },
      { captured_at: "2026-09-16T00:00:00.000Z", download_count: 1170, mod_count: 3 },
    ]);
  });

  test("from を指定すると起点は期間開始後の最初の値になり、合計もその期間だけになる", () => {
    const result = cache.buildOverview(material, new Date("2026-09-15T00:00:00Z"), null);

    assert.deepEqual(result.mods.map((m) => [m.mod_id, m.start_download_count]), [[1, 110], [2, 40]]);
    assert.deepEqual(result.totals.map((t) => t.captured_at), [
      "2026-09-15T00:00:00.000Z",
      "2026-09-16T00:00:00.000Z",
    ]);
  });

  test("platform を指定すると mods も合計もそのプラットフォームだけになる", () => {
    const result = cache.buildOverview(material, null, "thunderstore");

    assert.deepEqual(result.mods.map((m) => m.mod_id), [1]);
    // 合計は is_deprecated の mod 3 も含む(SQL 版と同じ)
    assert.deepEqual(result.totals[2], { captured_at: "2026-09-16T00:00:00.000Z", download_count: 1120, mod_count: 2 });
  });

  test("期間内にデータが無い mod の起点は null、合計は空", () => {
    const result = cache.buildOverview(material, new Date("2026-10-01T00:00:00Z"), null);

    assert.deepEqual(result.mods.map((m) => m.start_download_count), [null, null]);
    assert.deepEqual(result.totals, []);
  });

  test("mods の並び順(材料の順 = SQL の ORDER BY)を変えない", () => {
    const result = cache.buildOverview(material, null, null);
    assert.deepEqual(result.mods.map((m) => m.name), ["A", "B"]);
  });

  test("元の材料を書き換えない", () => {
    const before = JSON.stringify(material);
    cache.buildOverview(material, new Date("2026-09-15T00:00:00Z"), "thunderstore");
    assert.equal(JSON.stringify(material), before);
  });
});

describe("設定が無い時の read / readForMod", () => {
  beforeEach(() => {
    delete process.env.CACHE_STORAGE_CONNECTION_STRING;
  });

  test("read は null(= DB にフォールバック)", async () => {
    assert.equal(await cache.read("mods.json", silentLogger), null);
  });

  test("readForMod は miss(= DB に問い合わせる。not_found にはしない)", async () => {
    assert.deepEqual(await cache.readForMod(1, "summary", silentLogger), { status: "miss" });
  });

  test("rebuildAll は何もせずに戻る(例外を投げない)", async () => {
    const messages = [];
    await cache.rebuildAll("2026-09-16T00:00:00.000Z", { log: (m) => messages.push(m), warn() {}, error() {} });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /CACHE_STORAGE_CONNECTION_STRING/);
  });
});
