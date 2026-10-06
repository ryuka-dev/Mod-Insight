// ============================================================
// costs.test.js
//
// costs.js の queryPeriod と toDailyCosts のテスト(Azure には接続しない)。
// 確かめたいこと:
//   - 取得期間が「取得ジョブの日付の 2 日前」で終わり、90 日分になること
//   - Query API の行(UsageDate は 20260924 のような数値)が日付ごと・サービスごとにまとまること
//   - 列の順番が変わっても列名で読めること
//   - 期間外の行(集計中の日)は捨てること
//   - 0 円のサービスも残し、行の無い日は作らないこと
//   - 合計は丸める前の値から出すこと
// ============================================================

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { queryPeriod, toDailyCosts } = require("../src/costs");

// 実際の応答と同じ列の並び
const COLUMNS = [{ name: "Cost" }, { name: "UsageDate" }, { name: "ServiceName" }, { name: "Currency" }];

describe("queryPeriod", () => {
  test("取得ジョブの日付の 2 日前までの 90 日間になる", () => {
    assert.deepEqual(queryPeriod("2026-10-07T15:00:00.085Z"), { from: "2026-07-08", to: "2026-10-05" });
  });

  test("月をまたいでも日付で数える", () => {
    assert.deepEqual(queryPeriod("2026-10-01T15:00:00.000Z").to, "2026-09-29");
  });
});

describe("toDailyCosts", () => {
  const period = { from: "2026-09-24", to: "2026-09-26" };

  test("日付ごと・サービスごとにまとめ、古い順に並べる", () => {
    const rows = [
      [2.46, 20260925, "Azure Monitor", "JPY"],
      [0.61, 20260925, "Storage", "JPY"],
      [3.22, 20260924, "Azure Monitor", "JPY"],
      [0.76, 20260924, "Storage", "JPY"],
    ];
    const result = toDailyCosts(COLUMNS, rows, period);
    assert.equal(result.currency, "JPY");
    assert.deepEqual(result.days.map((d) => d.date), ["2026-09-24", "2026-09-25"]);
    assert.deepEqual(result.days[0].services, { "Azure Monitor": 3.22, "Storage": 0.76 });
    assert.equal(result.days[0].total, 3.98);
  });

  test("列の順番が違っても列名で読む", () => {
    const columns = [{ name: "UsageDate" }, { name: "ServiceName" }, { name: "Currency" }, { name: "Cost" }];
    const result = toDailyCosts(columns, [[20260924, "Storage", "JPY", 0.5]], period);
    assert.deepEqual(result.days, [{ date: "2026-09-24", total: 0.5, services: { "Storage": 0.5 } }]);
  });

  test("期間外の行(集計中の日)は捨てる", () => {
    const rows = [
      [2.5, 20260926, "Azure Monitor", "JPY"],
      [0.95, 20261006, "Azure Monitor", "JPY"],
    ];
    const result = toDailyCosts(COLUMNS, rows, period);
    assert.deepEqual(result.days.map((d) => d.date), ["2026-09-26"]);
  });

  test("0 円のサービスも残し、サービスは期間合計の多い順に並べる", () => {
    const rows = [
      [0, 20260924, "SQL Database", "JPY"],
      [0.6, 20260924, "Storage", "JPY"],
      [2.5, 20260924, "Azure Monitor", "JPY"],
    ];
    const result = toDailyCosts(COLUMNS, rows, period);
    assert.deepEqual(result.services, ["Azure Monitor", "Storage", "SQL Database"]);
    assert.equal(result.days[0].services["SQL Database"], 0);
  });

  test("行の無い日は 0 円で埋めない", () => {
    const rows = [
      [1, 20260924, "Storage", "JPY"],
      [1, 20260926, "Storage", "JPY"],
    ];
    const result = toDailyCosts(COLUMNS, rows, period);
    assert.deepEqual(result.days.map((d) => d.date), ["2026-09-24", "2026-09-26"]);
  });

  test("合計は丸める前の値から出す", () => {
    const rows = [
      [0.004, 20260924, "A", "JPY"],
      [0.004, 20260924, "B", "JPY"],
    ];
    const result = toDailyCosts(COLUMNS, rows, period);
    // 丸めた後を足すと 0 + 0 = 0 になるが、元の値の合計 0.008 は 0.01
    assert.deepEqual(result.days[0].services, { A: 0, B: 0 });
    assert.equal(result.days[0].total, 0.01);
  });

  test("必要な列が無ければ例外を投げる", () => {
    assert.throws(() => toDailyCosts([{ name: "Cost" }], [], period), /UsageDate/);
  });
});
