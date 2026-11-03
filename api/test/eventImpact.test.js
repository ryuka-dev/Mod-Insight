// ============================================================
// eventImpact.test.js
//
// eventImpact.js(ゲーム更新ごとの mod の対応状況)のテスト。
// 確かめたいこと:
//   - 本番の数字(SULFUR_Together の Thunderstore 版)で、1.0 と 1.0.2 の更新に対する
//     「更新後に最初に出した版・日数・旧版のダウンロード」が手で数えた値と一致すること
//   - 新しい版を出していない mod も行に出て、旧版のダウンロードは記録の最後の日まで数えること
//   - 前日の記録が無い日は旧版のダウンロードに足さず、日数にも数えないこと
//   - 更新日に初めて現れた版は 0 日で出したことになること
//   - 新しい版の割合が 90% に届かなければ days_to_90pct が null になること
//   - 対象外の出来事・記録を始める前の更新・非推奨の mod を外すこと
//   - platform で絞ってから合計(summary)を出すこと
// ============================================================

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { buildEventImpacts, selectEventImpacts, eventDayKey } = require("../src/eventImpact");

// 1 回の取得分の行を作る(毎日 15:00 UTC = 日本時間 0:00 の定時取得)。counts は { バージョン: ダウンロード数 }
function capture(date, counts) {
  return Object.entries(counts).map(([version, count]) => ({
    version_number: version,
    release_date: null,
    captured_at: `${date}T15:00:00.000Z`,
    download_count: count,
  }));
}

// ---- 本番の数字 ----
// GET /api/mods/1/version-snapshots(SULFUR_Together、Thunderstore)の 10/27〜11/02 の定時取得の値。
// バージョンの並びは API と同じ公開日順。1.5.0 は 11/01 の取得から現れる
const SULFUR_TOGETHER_COUNTS = {
  "2026-10-27": { "1.0.0": 216, "1.0.1": 203, "1.1.0": 246, "1.1.1": 198, "1.2.0": 140, "1.2.1": 299, "1.2.3": 619, "1.2.2": 90, "1.2.4": 168, "1.3.0": 111, "1.3.1": 642, "1.4.0": 874, "1.4.1": 1556 },
  "2026-10-28": { "1.0.0": 218, "1.0.1": 205, "1.1.0": 248, "1.1.1": 200, "1.2.0": 142, "1.2.1": 301, "1.2.3": 622, "1.2.2": 91, "1.2.4": 170, "1.3.0": 113, "1.3.1": 644, "1.4.0": 876, "1.4.1": 1583 },
  "2026-10-29": { "1.0.0": 220, "1.0.1": 209, "1.1.0": 249, "1.1.1": 201, "1.2.0": 144, "1.2.1": 303, "1.2.3": 624, "1.2.2": 94, "1.2.4": 172, "1.3.0": 115, "1.3.1": 646, "1.4.0": 878, "1.4.1": 1621 },
  "2026-10-30": { "1.0.0": 220, "1.0.1": 209, "1.1.0": 250, "1.1.1": 201, "1.2.0": 144, "1.2.1": 304, "1.2.3": 627, "1.2.2": 94, "1.2.4": 172, "1.3.0": 115, "1.3.1": 647, "1.4.0": 878, "1.4.1": 1658 },
  "2026-10-31": { "1.0.0": 224, "1.0.1": 209, "1.1.0": 250, "1.1.1": 201, "1.2.0": 145, "1.2.1": 304, "1.2.3": 629, "1.2.2": 94, "1.2.4": 172, "1.3.0": 115, "1.3.1": 648, "1.4.0": 879, "1.4.1": 1716 },
  "2026-11-01": { "1.0.0": 224, "1.0.1": 210, "1.1.0": 251, "1.1.1": 202, "1.2.0": 146, "1.2.1": 304, "1.2.3": 629, "1.2.2": 94, "1.2.4": 172, "1.3.0": 115, "1.3.1": 649, "1.4.0": 879, "1.4.1": 1766, "1.5.0": 7 },
  "2026-11-02": { "1.0.0": 224, "1.0.1": 210, "1.1.0": 252, "1.1.1": 203, "1.2.0": 147, "1.2.1": 305, "1.2.3": 630, "1.2.2": 95, "1.2.4": 172, "1.3.0": 115, "1.3.1": 650, "1.4.0": 879, "1.4.1": 1767, "1.5.0": 172 },
};

function sulfurTogetherRows() {
  return Object.entries(SULFUR_TOGETHER_COUNTS).flatMap(([date, counts]) => capture(date, counts));
}

// GET /api/events の本番の値(対象の 3 件と、対象外・記録前の例を 1 件ずつ)
const REAL_EVENTS = [
  { event_id: 7, occurred_at: "2026-09-14T12:00:46.000Z", kind: "game_patch", title: "Patch Notes 0.19.10", url: null, source: "steam", mod_id: null },
  { event_id: 4, occurred_at: "2026-10-20T12:49:21.000Z", kind: "game_news", title: "SULFUR has sold 500,000 copies!", url: null, source: "steam", mod_id: null },
  { event_id: 3, occurred_at: "2026-10-28T13:06:51.000Z", kind: "game_major", title: "SULFUR 1.0 OUT NOW", url: null, source: "steam", mod_id: null },
  { event_id: 2, occurred_at: "2026-10-29T16:47:35.000Z", kind: "game_patch", title: "Patch Notes 1.0.1", url: null, source: "steam", mod_id: null },
  { event_id: 1, occurred_at: "2026-10-31T12:40:51.000Z", kind: "game_patch", title: "Patch Notes 1.0.2", url: null, source: "steam", mod_id: null },
];

const SULFUR_TOGETHER = { mod_id: 1, name: "SULFUR_Together", platform: "thunderstore", is_deprecated: false };

function realImpacts() {
  return buildEventImpacts({
    mods: [SULFUR_TOGETHER],
    versionSnapshotsByMod: new Map([[1, sulfurTogetherRows()]]),
    events: REAL_EVENTS,
  });
}

// fromDate〜toDate の旧版(1.5.0 以外)の 1 日ごとの増加を、表の値から素直に足す(テストの期待値の確かめ用)
function oldDownloadsBetween(fromDate, toDate) {
  const dates = Object.keys(SULFUR_TOGETHER_COUNTS);
  let sum = 0;
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] < fromDate || dates[i] > toDate) {
      continue;
    }
    for (const [version, count] of Object.entries(SULFUR_TOGETHER_COUNTS[dates[i]])) {
      if (version !== "1.5.0") {
        sum += count - SULFUR_TOGETHER_COUNTS[dates[i - 1]][version];
      }
    }
  }
  return sum;
}

describe("buildEventImpacts(本番の数字)", () => {
  test("更新日は日本時間の日付", () => {
    assert.equal(eventDayKey("2026-10-28T13:06:51.000Z"), "2026-10-28");
    assert.equal(eventDayKey("2026-10-29T16:47:35.000Z"), "2026-10-30");  // 日本時間 10/30 1:47
    assert.equal(eventDayKey(new Date("2026-10-31T12:40:51.000Z")), "2026-10-31");
  });

  test("対象はゲームの大型アップデートとパッチだけで、記録を始める前の更新は入らない。新しい更新が先", () => {
    const impacts = realImpacts();
    assert.deepEqual(impacts.map((e) => [e.event_id, e.day]), [[1, "2026-10-31"], [2, "2026-10-30"], [3, "2026-10-28"]]);
  });

  test("1.0(10/28): 1.5.0 まで 4 日、その間の旧版のダウンロード", () => {
    const event = realImpacts().find((e) => e.event_id === 3);
    const [row] = event.mods;
    // 1.4.1 だけなら 27 + 38 + 37 + 58 + 50 = 210。ほかの古い版の少しずつのダウンロードも旧版に入る
    assert.equal(oldDownloadsBetween("2026-10-28", "2026-11-01"), 279);
    assert.deepEqual(row, {
      mod_id: 1,
      name: "SULFUR_Together",
      platform: "thunderstore",
      version_at_event: "1.4.1",
      next_version: "1.5.0",
      next_first_day: "2026-11-01",
      days_to_next: 4,
      old_downloads: 279,
      old_days: 5,
      next_first_2_days: 7 + 165,
      next_days_counted: 2,
      days_to_90pct: 1,  // 11/01 は 7 / 62、11/02 は 165 / 173 = 95%
    });
  });

  test("1.0.2(10/31): 同じ 1.5.0 が 1 日で出たことになる", () => {
    const event = realImpacts().find((e) => e.event_id === 1);
    const [row] = event.mods;
    assert.equal(row.version_at_event, "1.4.1");
    assert.equal(row.next_version, "1.5.0");
    assert.equal(row.days_to_next, 1);
    assert.equal(row.old_days, 2);
    assert.equal(row.old_downloads, oldDownloadsBetween("2026-10-31", "2026-11-01"));
    assert.equal(row.old_downloads, 122);
  });
});

// ---- 作った数字での境目の確認 ----
// mod 10: 9/01〜9/06 毎日記録。1.1 が 9/04 に現れる(割合は毎日 50%)
// mod 11: 新しい版を出していない。9/04 の記録が抜けている
// mod 12: 更新日の 9/03 に 1.1 が現れる
function syntheticInput() {
  const rows10 = [
    ...capture("2026-09-01", { "1.0": 100 }),
    ...capture("2026-09-02", { "1.0": 110 }),
    ...capture("2026-09-03", { "1.0": 120 }),
    ...capture("2026-09-04", { "1.0": 130, "1.1": 10 }),
    ...capture("2026-09-05", { "1.0": 140, "1.1": 20 }),
    ...capture("2026-09-06", { "1.0": 150, "1.1": 30 }),
  ];
  const rows11 = [
    ...capture("2026-09-01", { "2.0": 500 }),
    ...capture("2026-09-02", { "2.0": 505 }),
    ...capture("2026-09-03", { "2.0": 510 }),
    // 9/04 は取得が抜けた
    ...capture("2026-09-05", { "2.0": 530 }),
    ...capture("2026-09-06", { "2.0": 536 }),
  ];
  const rows12 = [
    ...capture("2026-09-01", { "0.9": 40 }),
    ...capture("2026-09-02", { "0.9": 44 }),
    ...capture("2026-09-03", { "0.9": 46, "1.0": 20 }),
    ...capture("2026-09-04", { "0.9": 47, "1.0": 40 }),
  ];
  return {
    mods: [
      { mod_id: 10, name: "Half", platform: "thunderstore", is_deprecated: false },
      { mod_id: 11, name: "NoNext", platform: "nexusmods", is_deprecated: false },
      { mod_id: 12, name: "SameDay", platform: "thunderstore", is_deprecated: false },
      { mod_id: 13, name: "Deprecated", platform: "thunderstore", is_deprecated: true },
    ],
    versionSnapshotsByMod: new Map([[10, rows10], [11, rows11], [12, rows12], [13, rows10]]),
    events: [
      // 日本時間 9/03 10:00 の更新
      { event_id: 100, occurred_at: "2026-09-03T01:00:00.000Z", kind: "game_patch", title: "Patch", url: null, source: "steam", mod_id: null },
    ],
  };
}

function syntheticRows() {
  const [event] = buildEventImpacts(syntheticInput());
  return event.mods;
}

describe("buildEventImpacts(境目)", () => {
  test("新しい版がある mod が先(日数の小さい順)、無い mod は後。非推奨の mod は入らない", () => {
    assert.deepEqual(syntheticRows().map((r) => r.mod_id), [12, 10, 11]);
  });

  test("新しい版を出していない mod: 旧版のダウンロードは記録の最後の日まで。前日の記録が無い日は数えない", () => {
    const row = syntheticRows().find((r) => r.mod_id === 11);
    // 9/03 +5、9/04 記録なし、9/05 前日の記録なし、9/06 +6
    assert.deepEqual(
      [row.version_at_event, row.next_version, row.next_first_day, row.days_to_next, row.old_downloads, row.old_days],
      ["2.0", null, null, null, 11, 2],
    );
    assert.equal(row.next_first_2_days, null);
    assert.equal(row.next_days_counted, null);
    assert.equal(row.days_to_90pct, null);
  });

  test("更新日に現れた版は 0 日。旧版のダウンロードは更新日の 1 日分", () => {
    const row = syntheticRows().find((r) => r.mod_id === 12);
    assert.equal(row.version_at_event, "0.9");
    assert.equal(row.next_version, "1.0");
    assert.equal(row.days_to_next, 0);
    assert.equal(row.old_downloads, 2);  // 9/03 の 0.9 の増加
    assert.equal(row.old_days, 1);
    assert.equal(row.next_first_2_days, 20 + 20);
    assert.equal(row.days_to_90pct, 0);  // 9/03 は 20 / 22 = 90.9%
  });

  test("新しい版の割合が 90% に届かなければ null", () => {
    const row = syntheticRows().find((r) => r.mod_id === 10);
    assert.equal(row.next_version, "1.1");
    assert.equal(row.days_to_next, 1);
    assert.equal(row.old_downloads, 20);  // 9/03 と 9/04 の 1.0 の増加
    assert.equal(row.next_first_2_days, 20);
    assert.equal(row.next_days_counted, 2);
    assert.equal(row.days_to_90pct, null);  // 毎日 50%
  });

  test("翌日の記録がまだ無ければ、最初の 2 日は 1 日分だけ足して日数を 1 にする", () => {
    const input = syntheticInput();
    input.versionSnapshotsByMod.set(10, input.versionSnapshotsByMod.get(10).filter((r) => r.captured_at < "2026-09-05"));
    const [event] = buildEventImpacts(input);
    const row = event.mods.find((r) => r.mod_id === 10);
    assert.equal(row.next_first_2_days, 10);
    assert.equal(row.next_days_counted, 1);
  });

  test("更新日の前日に記録のある mod が無い更新は入らない", () => {
    const input = syntheticInput();
    input.events = [{ event_id: 101, occurred_at: "2026-08-31T03:00:00.000Z", kind: "game_major", title: "Old", url: null, source: "steam", mod_id: null }];
    assert.deepEqual(buildEventImpacts(input), []);
  });

  test("DB から来る Date 型の captured_at / occurred_at でも同じ結果になる", () => {
    const input = syntheticInput();
    const dated = {
      mods: input.mods,
      versionSnapshotsByMod: new Map(Array.from(input.versionSnapshotsByMod, ([id, rows]) => [
        id,
        rows.map((r) => ({ ...r, captured_at: new Date(r.captured_at) })),
      ])),
      events: input.events.map((e) => ({ ...e, occurred_at: new Date(e.occurred_at) })),
    };
    const expected = buildEventImpacts(input);
    const actual = buildEventImpacts(dated);
    assert.deepEqual(actual[0].mods, expected[0].mods);
    assert.equal(actual[0].day, expected[0].day);
  });
});

describe("buildEventImpacts(続けて次の版を出した場合)", () => {
  test("90% を超えるまでは、next_version だけでなく更新後に出した版すべての割合で測る", () => {
    // 9/04 に 1.1、翌日に 1.2 を出し、ダウンロードが 1.2 に移った mod
    const rows = [
      ...capture("2026-09-02", { "1.0": 100 }),
      ...capture("2026-09-03", { "1.0": 101 }),
      ...capture("2026-09-04", { "1.0": 110, "1.1": 10 }),
      ...capture("2026-09-05", { "1.0": 111, "1.1": 11, "1.2": 20 }),
    ];
    const [event] = buildEventImpacts({
      mods: [{ mod_id: 20, name: "TwoReleases", platform: "thunderstore", is_deprecated: false }],
      versionSnapshotsByMod: new Map([[20, rows]]),
      events: [{ event_id: 200, occurred_at: "2026-09-03T01:00:00.000Z", kind: "game_patch", title: "Patch", url: null, source: "steam", mod_id: null }],
    });
    const [row] = event.mods;
    assert.equal(row.next_version, "1.1");
    // 9/04 は旧版以外が 10 / 19 = 53%、9/05 は (1 + 20) / 22 = 95%。
    // 1.1 だけで測ると 9/05 は 1 / 22 で、旧版から離れたのに「届かない」になってしまう
    assert.equal(row.days_to_90pct, 1);
  });
});

describe("selectEventImpacts", () => {
  test("platform で絞ってから合計を出す", () => {
    const impacts = buildEventImpacts(syntheticInput());

    const [thunderstore] = selectEventImpacts(impacts, "thunderstore");
    assert.deepEqual(thunderstore.mods.map((r) => r.mod_id), [12, 10]);
    assert.deepEqual(thunderstore.summary, { mod_count: 2, next_count: 2, median_days_to_next: 0.5, old_downloads_total: 22 });

    const [nexus] = selectEventImpacts(impacts, "nexusmods");
    assert.deepEqual(nexus.summary, { mod_count: 1, next_count: 0, median_days_to_next: null, old_downloads_total: 11 });

    const [all] = selectEventImpacts(impacts, null);
    assert.deepEqual(all.summary, { mod_count: 3, next_count: 2, median_days_to_next: 0.5, old_downloads_total: 33 });
    assert.deepEqual(Object.keys(all), ["event_id", "occurred_at", "kind", "title", "url", "day", "summary", "mods"]);
  });

  test("絞った結果 mod が無い更新は入れない", () => {
    const impacts = buildEventImpacts({
      mods: [SULFUR_TOGETHER],
      versionSnapshotsByMod: new Map([[1, sulfurTogetherRows()]]),
      events: REAL_EVENTS,
    });
    assert.deepEqual(selectEventImpacts(impacts, "nexusmods"), []);
    assert.equal(selectEventImpacts(impacts, "thunderstore").length, 3);
  });
});
