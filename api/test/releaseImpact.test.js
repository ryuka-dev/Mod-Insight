// ============================================================
// releaseImpact.test.js
//
// releaseImpact.js の buildReleaseImpact のテスト。
// 確かめたいこと:
//   - 公開 1 日目は release_date ではなく、初めて記録に現れた日になること
//   - 新しい版は前日の値を 0 として増加を数えること
//   - 公開前後の 1 日あたりの平均と差、新しい版の割合が出ること
//   - 記録を始める前に公開された版は比べないこと
//   - 次の版が出たら、その前日で区切ること
//   - 同じ日に何回か取得していれば、その日の最後の値を使うこと
//   - その日の増加が 0 以下なら割合を null にすること
// ============================================================

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { buildReleaseImpact } = require("../src/releaseImpact");

// 1 回の取得分の行を作る。counts は { バージョン: ダウンロード数 }
function capture(date, time, counts, releaseDates) {
  return Object.entries(counts).map(([version, count]) => ({
    version_number: version,
    release_date: releaseDates[version],
    captured_at: `${date}T${time}Z`,
    download_count: count,
  }));
}

const RELEASES = { "1.0": "2026-09-01", "1.1": "2026-09-03", "1.2": "2026-09-06" };

// 9/01〜9/05 の毎日 15:00 の取得。1.1 は 9/03 の取得から現れる
function sampleRows() {
  return [
    ...capture("2026-09-01", "15:00:00.000", { "1.0": 100 }, RELEASES),
    ...capture("2026-09-02", "15:00:00.000", { "1.0": 110 }, RELEASES),
    ...capture("2026-09-03", "15:00:00.000", { "1.0": 112, "1.1": 18 }, RELEASES),
    ...capture("2026-09-04", "15:00:00.000", { "1.0": 113, "1.1": 27 }, RELEASES),
    ...capture("2026-09-05", "15:00:00.000", { "1.0": 113, "1.1": 37 }, RELEASES),
  ];
}

describe("buildReleaseImpact", () => {
  test("公開 1 日目は初めて記録に現れた日で、新しい版は前日 0 から数える", () => {
    const rows = sampleRows().map((r) => (r.version_number === "1.1" ? { ...r, release_date: "2026-09-02" } : r));
    const [release] = buildReleaseImpact(rows);
    assert.equal(release.version_number, "1.1");
    assert.equal(release.release_date, "2026-09-02");
    assert.equal(release.first_day, "2026-09-03");
    assert.deepEqual(release.share[0], { date: "2026-09-03", day: 1, new_version: 18, total: 20, share: 90 });
  });

  test("公開前後の 1 日あたりの平均と差、割合の推移を出す", () => {
    const [release] = buildReleaseImpact(sampleRows());
    // 前: 9/02 の 10 だけ(9/01 は前日の記録が無いので増加を出せない)
    assert.deepEqual(release.before, { days: 1, average: 10 });
    // 後: 9/03 20、9/04 10、9/05 10
    assert.deepEqual(release.after, { days: 3, average: 13.3 });
    assert.equal(release.change, 3.3);
    assert.deepEqual(release.share.map((s) => [s.day, s.share]), [[1, 90], [2, 90], [3, 100]]);
  });

  test("記録を始める前に公開された版は比べない", () => {
    const result = buildReleaseImpact(sampleRows());
    assert.deepEqual(result.map((r) => r.version_number), ["1.1"]);
  });

  test("次の版が出たら、その前日で区切り、新しい公開を先に返す", () => {
    const rows = [
      ...sampleRows(),
      ...capture("2026-09-06", "15:00:00.000", { "1.0": 113, "1.1": 40, "1.2": 30 }, RELEASES),
    ];
    const result = buildReleaseImpact(rows);
    assert.deepEqual(result.map((r) => r.version_number), ["1.2", "1.1"]);
    const v11 = result[1];
    assert.deepEqual(v11.share.map((s) => s.date), ["2026-09-03", "2026-09-04", "2026-09-05"]);
    assert.equal(v11.after.days, 3);
    const v12 = result[0];
    assert.deepEqual(v12.before, { days: 4, average: 12.5 });  // 9/02 10、9/03 20、9/04 10、9/05 10
    assert.deepEqual(v12.share[0], { date: "2026-09-06", day: 1, new_version: 30, total: 33, share: 90.9 });
  });

  test("同じ日に何回か取得していれば、その日の最後の値を使う", () => {
    const rows = [
      ...capture("2026-09-01", "15:00:00.000", { "1.0": 100 }, RELEASES),
      ...capture("2026-09-02", "01:00:00.000", { "1.0": 101, "1.1": 1 }, RELEASES),
      ...capture("2026-09-02", "15:00:00.000", { "1.0": 102, "1.1": 8 }, RELEASES),
    ];
    const [release] = buildReleaseImpact(rows);
    assert.deepEqual(release.share, [{ date: "2026-09-02", day: 1, new_version: 8, total: 10, share: 80 }]);
  });

  test("その日の増加が 0 以下なら割合は null", () => {
    const rows = [
      ...capture("2026-09-01", "15:00:00.000", { "1.0": 100 }, RELEASES),
      ...capture("2026-09-02", "15:00:00.000", { "1.0": 98, "1.1": 0 }, RELEASES),
    ];
    const [release] = buildReleaseImpact(rows);
    assert.equal(release.share[0].total, -2);
    assert.equal(release.share[0].share, null);
  });

  test("比べられる公開が無ければ空の配列", () => {
    const rows = capture("2026-09-01", "15:00:00.000", { "1.0": 100 }, RELEASES);
    assert.deepEqual(buildReleaseImpact(rows), []);
  });

  test("DB から来る Date 型の captured_at / release_date でも同じ結果になる", () => {
    const rows = sampleRows().map((r) => ({
      ...r,
      captured_at: new Date(r.captured_at),
      release_date: new Date(`${r.release_date}T00:00:00Z`),
    }));
    assert.deepEqual(buildReleaseImpact(rows), buildReleaseImpact(sampleRows()));
  });
});
