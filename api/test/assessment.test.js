// ============================================================
// assessment.test.js
//
// assessment.js(互換性チェックの結果ファイルを、書く行に変える部分)のテスト。
// 確かめたいこと:
//   - 正しいファイルなら、Thunderstore と Nexus Mods の両方の mod の行ができること
//   - needs_fix が true / false 以外、名前の重複、知らない項目などを、全部まとめて問題として返すこと
//   - 知らない mod 名や、events に無い更新を指定すると、行を 1 つも返さないこと
// DB に書く部分(scripts/import-assessment.js の --apply)はここでは確かめられない。
// ============================================================

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { validateAssessmentFile, parseEventGids, resolveAssessments } = require("../src/assessment");

// mods テーブルの行(本番と同じ形。番号は作ったもの)
const MODS = [
  { mod_id: 1, name: "SULFUR_Together", platform: "thunderstore", external_id: "ryuka_labs/SULFUR_Together" },
  { mod_id: 2, name: "GridWise", platform: "thunderstore", external_id: "ryuka_labs/GridWise" },
  { mod_id: 30, name: "SULFUR Together", platform: "nexusmods", external_id: "sulfur/94" },
];

// events テーブルの行(Steam のお知らせ 2 件と、手入力のメモ 1 件)
const EVENTS = [
  { event_id: 3, title: "SULFUR 1.0 OUT NOW", source: "steam", external_id: "1001" },
  { event_id: 1, title: "Patch Notes 1.0.2", source: "steam", external_id: "1003" },
  { event_id: 9, title: "メモ", source: "manual", external_id: "1009" },
];

const GOOD_FILE = {
  sweep: "1.0.2",
  mods: [
    { thunderstore: "SULFUR_Together", nexus: 94, needs_fix: true },
    { thunderstore: "GridWise", needs_fix: false },
  ],
};

describe("validateAssessmentFile", () => {
  test("正しいファイル。nexus の省略は null にそろえる", () => {
    const result = validateAssessmentFile(GOOD_FILE);
    assert.deepEqual(result.problems, []);
    assert.equal(result.sweep, "1.0.2");
    assert.deepEqual(result.entries, [
      { thunderstore: "SULFUR_Together", nexus: 94, needs_fix: true },
      { thunderstore: "GridWise", nexus: null, needs_fix: false },
    ]);
  });

  test("問題は 1 つ目で止めず、全部並べる", () => {
    const result = validateAssessmentFile({
      mods: [
        { thunderstore: "A", nexus: 1, needs_fix: "true" },    // 文字列の "true"
        { thunderstore: "A", nexus: 1, needs_fix: 1 },         // 名前と番号の重複、1 は boolean ではない
        { thunderstore: "", nexus: -3, needs_fix: false },     // 空の名前、負の番号
        { thunderstore: "B", nexsu: 5, needs_fix: false },     // 打ち間違えた項目
        "C",
      ],
    });
    assert.deepEqual(result.problems, [
      "mods[0] の needs_fix は true か false で書いてください",
      "mods[1] の thunderstore \"A\" が 2 回以上出てきます",
      "mods[1] の nexus 1 が 2 回以上出てきます",
      "mods[1] の needs_fix は true か false で書いてください",
      "mods[2] の thunderstore が空か、文字列ではありません",
      "mods[2] の nexus は正の整数か null で書いてください",
      "mods[3] に知らない項目 \"nexsu\" があります",
      "mods[4] がオブジェクトではありません",
    ]);
  });

  test("形が違うファイル", () => {
    assert.deepEqual(validateAssessmentFile([]).problems, ["ファイルの中身が JSON のオブジェクトではありません"]);
    assert.deepEqual(validateAssessmentFile(null).problems, ["ファイルの中身が JSON のオブジェクトではありません"]);
    assert.deepEqual(validateAssessmentFile({ sweep: 1, mods: [] }).problems, [
      "sweep は文字列で書いてください",
      "mods が無いか、空の配列です",
    ]);
  });
});

describe("parseEventGids", () => {
  test("カンマ区切りの番号。前後の空白は無視する", () => {
    assert.deepEqual(parseEventGids("1001, 1003"), { problems: [], gids: ["1001", "1003"] });
  });

  test("数字以外、重複、指定なし", () => {
    assert.deepEqual(parseEventGids("1001,abc,1001").problems, [
      "--events の \"abc\" は数字だけの番号ではありません",
      "--events の 1001 が 2 回以上出てきます",
    ]);
    assert.equal(parseEventGids(undefined).problems.length, 1);
    assert.equal(parseEventGids("").problems.length, 1);
  });
});

describe("resolveAssessments", () => {
  function resolve(file, gids) {
    return resolveAssessments({
      entries: validateAssessmentFile(file).entries,
      gids: gids,
      mods: MODS,
      events: EVENTS,
    });
  }

  test("更新ごとに、Thunderstore と Nexus Mods の両方の行を作る", () => {
    const result = resolve(GOOD_FILE, ["1001", "1003"]);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.rows.map((r) => [r.event_id, r.mod_id, r.platform, r.needs_fix]), [
      [3, 1, "thunderstore", true],
      [3, 30, "nexusmods", true],
      [3, 2, "thunderstore", false],
      [1, 1, "thunderstore", true],
      [1, 30, "nexusmods", true],
      [1, 2, "thunderstore", false],
    ]);
    assert.equal(result.rows[0].event_title, "SULFUR 1.0 OUT NOW");
    assert.equal(result.rows[1].mod_name, "SULFUR Together");
  });

  test("知らない mod と存在しない更新は、全部並べて行を返さない", () => {
    const result = resolve({
      mods: [
        { thunderstore: "SULFUR_Together", nexus: 95, needs_fix: true },  // Nexus の番号違い
        { thunderstore: "Unknown", needs_fix: false },
      ],
    }, ["1001", "2000", "1009"]);  // 2000 は無い、1009 は Steam のお知らせではない
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.problems, [
      "Nexus Mods の mod 95(SULFUR_Together)が mods にありません(external_id: sulfur/95)",
      "Thunderstore の mod \"Unknown\" が mods にありません(external_id: ryuka_labs/Unknown)",
      "Steam のお知らせ 2000 が events にありません",
      "Steam のお知らせ 1009 が events にありません",
    ]);
  });
});
