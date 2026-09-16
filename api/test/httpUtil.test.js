// ============================================================
// httpUtil.test.js
//
// httpUtil.js の関数のテスト。DB にもネットワークにもつながない。
// 実行: cd api && npm test(node:test を使う。追加パッケージは不要)
//
// 見ているのは「HTTP のパラメータをどう解釈するか」と「キャッシュの絞り込みが
// SQL の WHERE 句と同じ条件になっているか」。
// ============================================================

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseModId,
  parseDateParam,
  parsePlatformParam,
  filterByCapturedAt,
  dataSourceHeaders,
  errorResponse,
} = require("../src/httpUtil");

// Azure Functions の HttpRequest のうち、parseModId が見る部分だけを真似た入れ物
function requestWithModId(modId) {
  return { params: { modId: modId } };
}

describe("parseModId", () => {
  test("正の整数はそのまま数値になる", () => {
    assert.equal(parseModId(requestWithModId("12")), 12);
    assert.equal(parseModId(requestWithModId("1")), 1);
  });

  test("数字以外・0・小数・負数・INT の上限超えは null", () => {
    assert.equal(parseModId(requestWithModId("abc")), null);
    assert.equal(parseModId(requestWithModId("0")), null);
    assert.equal(parseModId(requestWithModId("1.5")), null);
    assert.equal(parseModId(requestWithModId("-3")), null);
    assert.equal(parseModId(requestWithModId("2147483648")), null);
    assert.equal(parseModId(requestWithModId("")), null);
  });
});

describe("parseDateParam", () => {
  test("未指定(null / undefined / 空文字)は ok で値は null", () => {
    assert.deepEqual(parseDateParam(null), { ok: true, value: null });
    assert.deepEqual(parseDateParam(undefined), { ok: true, value: null });
    assert.deepEqual(parseDateParam(""), { ok: true, value: null });
  });

  test("日付だけの指定は UTC の 0 時になる", () => {
    const result = parseDateParam("2026-09-15");
    assert.equal(result.ok, true);
    assert.equal(result.value.toISOString(), "2026-09-15T00:00:00.000Z");
  });

  test("ISO 形式の日時も受け付ける", () => {
    const result = parseDateParam("2026-09-15T12:34:56Z");
    assert.equal(result.ok, true);
    assert.equal(result.value.toISOString(), "2026-09-15T12:34:56.000Z");
  });

  test("読めない文字列は ok: false", () => {
    assert.deepEqual(parseDateParam("x"), { ok: false });
    assert.deepEqual(parseDateParam("2026-13-99"), { ok: false });
  });
});

describe("parsePlatformParam", () => {
  test("未指定は全プラットフォーム(null)", () => {
    assert.deepEqual(parsePlatformParam(null), { ok: true, value: null });
    assert.deepEqual(parsePlatformParam(""), { ok: true, value: null });
  });

  test("知っている値はそのまま、知らない値は ok: false", () => {
    assert.deepEqual(parsePlatformParam("thunderstore"), { ok: true, value: "thunderstore" });
    assert.deepEqual(parsePlatformParam("nexusmods"), { ok: true, value: "nexusmods" });
    assert.deepEqual(parsePlatformParam("steam"), { ok: false });
    assert.deepEqual(parsePlatformParam("Thunderstore"), { ok: false });
  });
});

describe("filterByCapturedAt", () => {
  // キャッシュに入っている形(captured_at は ISO 文字列)
  const rows = [
    { captured_at: "2026-09-14T03:11:00.810Z", download_count: 1 },
    { captured_at: "2026-09-15T00:34:16.854Z", download_count: 2 },
    { captured_at: "2026-09-15T15:00:00.083Z", download_count: 3 },
    { captured_at: "2026-09-16T01:25:39.102Z", download_count: 4 },
  ];

  test("from / to とも null なら全部返す(順番もそのまま)", () => {
    assert.deepEqual(filterByCapturedAt(rows, null, null), rows);
  });

  test("from は「以上」(境界を含む)", () => {
    const result = filterByCapturedAt(rows, new Date("2026-09-15T00:34:16.854Z"), null);
    assert.deepEqual(result.map((r) => r.download_count), [2, 3, 4]);
  });

  test("to は「以下」(境界を含む)", () => {
    const result = filterByCapturedAt(rows, null, new Date("2026-09-15T15:00:00.083Z"));
    assert.deepEqual(result.map((r) => r.download_count), [1, 2, 3]);
  });

  test("from と to の両方で範囲を切れる", () => {
    const result = filterByCapturedAt(rows, new Date("2026-09-15"), new Date("2026-09-15T23:59:59Z"));
    assert.deepEqual(result.map((r) => r.download_count), [2, 3]);
  });

  test("範囲に何も無ければ空配列。元の配列は変えない", () => {
    const result = filterByCapturedAt(rows, new Date("2027-01-01"), null);
    assert.deepEqual(result, []);
    assert.equal(rows.length, 4);
  });
});

describe("dataSourceHeaders", () => {
  test("cache の時は run_at も付く", () => {
    assert.deepEqual(dataSourceHeaders("cache", "2026-09-16T01:25:39.102Z"), {
      "x-data-source": "cache",
      "x-data-run-at": "2026-09-16T01:25:39.102Z",
    });
  });

  test("db の時は出どころだけ", () => {
    assert.deepEqual(dataSourceHeaders("db"), { "x-data-source": "db" });
  });
});

describe("errorResponse", () => {
  test("status と { error } の形になる", () => {
    assert.deepEqual(errorResponse(404, "指定された mod は存在しません"), {
      status: 404,
      jsonBody: { error: "指定された mod は存在しません" },
    });
  });
});
