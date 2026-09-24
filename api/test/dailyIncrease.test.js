// ============================================================
// dailyIncrease.test.js
//
// dailyIncrease.js の buildDailyIncrease のテスト。
// 確かめたいこと:
//   - 1 日に何回取得していても、その日の最後の値で 1 日 1 点になること
//   - 途中で追加された mod の既存のダウンロード数が段差として入らないこと
//   - 前日の記録が無い日は差を出さないこと
//   - マイナスの差を補正しないこと
//   - 7 日平均は 7 日そろった日だけ出て、from で絞った後も最初の日に平均が残ること
//   - DB から来る Date 型の captured_at でも同じ結果になること
// ============================================================

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { buildDailyIncrease } = require("../src/dailyIncrease");

// 履歴の 1 行を作る(日付と時刻を分けて書けるようにするだけの道具)
function row(modId, platform, date, time, count) {
  return { mod_id: modId, platform: platform, captured_at: `${date}T${time}Z`, download_count: count };
}

describe("buildDailyIncrease", () => {
  test("同じ日に何回取得していても、その日の最後の値で差を取る", () => {
    const history = [
      row(1, "thunderstore", "2026-09-14", "15:00:00.000", 100),
      row(1, "thunderstore", "2026-09-15", "00:34:00.000", 105),
      row(1, "thunderstore", "2026-09-15", "02:47:00.000", 107),
      row(1, "thunderstore", "2026-09-15", "15:00:00.000", 112),
    ];
    const result = buildDailyIncrease(history, null, null);
    assert.equal(result.length, 1);
    assert.equal(result[0].date, "2026-09-15");
    assert.equal(result[0].increase, 12);
    assert.equal(result[0].mod_count, 1);
  });

  test("途中で追加された mod は、前日の記録ができた翌日から数える(段差が入らない)", () => {
    const history = [
      row(1, "thunderstore", "2026-09-14", "15:00:00.000", 100),
      row(1, "thunderstore", "2026-09-15", "15:00:00.000", 110),
      row(1, "thunderstore", "2026-09-16", "15:00:00.000", 120),
      // 9/15 に追加された mod。既存の 5000 は増加に入らない
      row(2, "nexusmods", "2026-09-15", "15:00:00.000", 5000),
      row(2, "nexusmods", "2026-09-16", "15:00:00.000", 5004),
    ];
    const result = buildDailyIncrease(history, null, null);
    assert.deepEqual(
      result.map((d) => [d.date, d.increase, d.mod_count]),
      [["2026-09-15", 10, 1], ["2026-09-16", 14, 2]]
    );
  });

  test("取得が抜けた日の翌日は差を出さない", () => {
    const history = [
      row(1, "thunderstore", "2026-09-14", "15:00:00.000", 100),
      row(1, "thunderstore", "2026-09-15", "15:00:00.000", 110),
      // 9/16 は取得が無かった
      row(1, "thunderstore", "2026-09-17", "15:00:00.000", 130),
      row(1, "thunderstore", "2026-09-18", "15:00:00.000", 135),
    ];
    const result = buildDailyIncrease(history, null, null);
    assert.deepEqual(result.map((d) => d.date), ["2026-09-15", "2026-09-18"]);
  });

  test("マイナスの差もそのまま足す", () => {
    const history = [
      row(1, "thunderstore", "2026-09-14", "15:00:00.000", 100),
      row(1, "thunderstore", "2026-09-15", "15:00:00.000", 98),
      row(2, "thunderstore", "2026-09-14", "15:00:00.000", 50),
      row(2, "thunderstore", "2026-09-15", "15:00:00.000", 51),
    ];
    const result = buildDailyIncrease(history, null, null);
    assert.equal(result[0].increase, -1);
  });

  test("platform を指定すると、そのプラットフォームの mod だけ足す", () => {
    const history = [
      row(1, "thunderstore", "2026-09-14", "15:00:00.000", 100),
      row(1, "thunderstore", "2026-09-15", "15:00:00.000", 110),
      row(2, "nexusmods", "2026-09-14", "15:00:00.000", 40),
      row(2, "nexusmods", "2026-09-15", "15:00:00.000", 43),
    ];
    assert.equal(buildDailyIncrease(history, null, "thunderstore")[0].increase, 10);
    assert.equal(buildDailyIncrease(history, null, "nexusmods")[0].increase, 3);
    assert.equal(buildDailyIncrease(history, null, null)[0].increase, 13);
  });

  test("7 日平均は 7 日そろった日から出て、from で絞っても最初の日に残る", () => {
    // 9/10 を起点に、9/11〜9/20 の 10 日間、毎日 i * 10 ずつ増える
    const history = [row(1, "thunderstore", "2026-09-10", "15:00:00.000", 0)];
    let count = 0;
    for (let i = 1; i <= 10; i++) {
      count += i * 10;
      const date = `2026-09-${String(10 + i).padStart(2, "0")}`;
      history.push(row(1, "thunderstore", date, "15:00:00.000", count));
    }

    const all = buildDailyIncrease(history, null, null);
    assert.equal(all.length, 10);
    assert.equal(all[5].average_7d, null);            // 9/16 は 6 日分しかない
    assert.equal(all[6].average_7d, 40);              // 9/17: (10+20+...+70) / 7
    assert.equal(all[9].average_7d, 70);              // 9/20: (40+50+...+100) / 7

    const ranged = buildDailyIncrease(history, new Date("2026-09-19T00:00:00Z"), null);
    assert.deepEqual(ranged.map((d) => d.date), ["2026-09-19", "2026-09-20"]);
    assert.equal(ranged[0].average_7d, 60);           // 9/19: 絞る前の 9/13〜9/19 から計算
  });

  test("captured_at が Date 型(DB から直接読んだ場合)でも同じ結果になる", () => {
    const history = [
      row(1, "thunderstore", "2026-09-14", "15:00:00.000", 100),
      row(1, "thunderstore", "2026-09-15", "15:00:00.000", 110),
    ];
    const withDates = history.map((r) => ({ ...r, captured_at: new Date(r.captured_at) }));
    assert.deepEqual(buildDailyIncrease(withDates, null, null), buildDailyIncrease(history, null, null));
  });

  test("履歴が空なら空の配列を返す", () => {
    assert.deepEqual(buildDailyIncrease([], null, null), []);
  });
});
