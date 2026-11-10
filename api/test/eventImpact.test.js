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
//   - ただし公開日時が更新の時刻より前の版は、更新日に現れても旧版として扱うこと
//     (本番の数字: ArmsRace 1.0.4 とパッチ 1.0.6。公開日時が分からない版は今までどおり)
//   - 新しい版の割合が 90% に届かなければ days_to_90pct が null になること
//   - 対象外の出来事・記録を始める前の更新・非推奨の mod を外すこと
//   - platform で絞ってから合計(summary)を出すこと
//   - 修正が必要だったかの記録がある更新では、合計を修正が必要だった mod だけで出し、
//     その mod を先に並べること。記録が無い更新・一部だけ記録がある更新・片方のプラットフォームにだけ
//     記録がある更新のそれぞれで、合計の対象(basis)が正しく決まること
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
      needs_fix: null,
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

// ---- 更新と同じ日に現れた版(公開日時で前後を決める) ----
// GET /api/mods/17/version-snapshots(ArmsRace、Thunderstore)の 11/07〜11/09 の定時取得の値。
// 1.0.4 の公開は 2026-11-09T01:17Z(日本時間 10:17)、パッチ 1.0.6 のお知らせは同じ日の 10:52Z(日本時間 19:52)。
// どちらも日本時間 11/09 なので、記録に現れた日だけでは前後が決まらない
const ARMS_RACE = { mod_id: 17, name: "ArmsRace", platform: "thunderstore", is_deprecated: false };
const ARMS_RACE_ROWS = [
  ...capture("2026-11-07", { "1.0.0": 91, "1.0.1": 85, "1.0.2": 485, "1.0.3": 61 }),
  ...capture("2026-11-08", { "1.0.0": 91, "1.0.1": 85, "1.0.2": 485, "1.0.3": 70 }),
  ...capture("2026-11-09", { "1.0.0": 91, "1.0.1": 86, "1.0.2": 486, "1.0.3": 72, "1.0.4": 6 }),
];
// db.listModVersions と同じ並び(新しい順)。公開日時は Thunderstore の値
const ARMS_RACE_VERSIONS = [
  { version_number: "1.0.4", released_at: "2026-11-09T01:17:53.299Z" },
  { version_number: "1.0.3", released_at: "2026-11-02T14:56:44.400Z" },
];
const PATCH_1_0_6 = { event_id: 53, occurred_at: "2026-11-09T10:52:08.000Z", kind: "game_patch", title: "Patch Notes 1.0.6", url: null, source: "steam", mod_id: null };

// mod 12(更新日の 9/03 に 1.0 が現れる。更新は 9/03T01:00Z)に、1.0 の公開日時を付けて計算する
function sameDayRow(releasedAt) {
  const input = syntheticInput();
  input.versionsByMod = new Map([[12, [{ version_number: "1.0", released_at: releasedAt }]]]);
  const [event] = buildEventImpacts(input);
  return event.mods.find((r) => r.mod_id === 12);
}

describe("buildEventImpacts(更新と同じ日に現れた版)", () => {
  test("本番の数字: 更新の 9 時間半前に公開した ArmsRace 1.0.4 は旧版で、更新後に出した版は無い", () => {
    const [event] = buildEventImpacts({
      mods: [ARMS_RACE],
      versionSnapshotsByMod: new Map([[17, ARMS_RACE_ROWS]]),
      events: [PATCH_1_0_6],
      versionsByMod: new Map([[17, ARMS_RACE_VERSIONS]]),
    });
    const [row] = event.mods;
    assert.equal(event.day, "2026-11-09");
    assert.equal(row.version_at_event, "1.0.4");
    assert.equal(row.next_version, null);
    assert.equal(row.days_to_next, null);
    // 11/09 の増加: 1.0.1 +1、1.0.2 +1、1.0.3 +2、1.0.4 +6(前日に無いので 0 から)
    assert.equal(row.old_downloads, 10);
    assert.equal(row.old_days, 1);
  });

  test("本番の数字: 公開日時を渡さなければ、同じ 1.0.4 が 0 日で出た版になる(記録だけでは前後が決まらない)", () => {
    const [event] = buildEventImpacts({
      mods: [ARMS_RACE],
      versionSnapshotsByMod: new Map([[17, ARMS_RACE_ROWS]]),
      events: [PATCH_1_0_6],
    });
    const [row] = event.mods;
    assert.deepEqual(
      [row.version_at_event, row.next_version, row.days_to_next, row.old_downloads],
      ["1.0.3", "1.0.4", 0, 4],
    );
  });

  test("更新の時刻より前に公開した版は旧版。旧版のダウンロードは記録の最後の日まで数える", () => {
    const row = sameDayRow("2026-09-02T20:00:00.000Z");  // 日本時間 9/03 5:00(更新は 10:00)
    assert.equal(row.version_at_event, "1.0");
    assert.equal(row.next_version, null);
    assert.equal(row.next_first_day, null);
    assert.equal(row.days_to_next, null);
    // 9/03 は 0.9 +2 と 1.0 +20、9/04 は 0.9 +1 と 1.0 +20
    assert.equal(row.old_downloads, 43);
    assert.equal(row.old_days, 2);
  });

  test("更新の時刻より後に公開した版は、今までどおり 0 日で出した版", () => {
    const row = sameDayRow("2026-09-03T05:00:00.000Z");  // 日本時間 9/03 14:00
    assert.deepEqual(
      [row.version_at_event, row.next_version, row.days_to_next, row.old_downloads],
      ["0.9", "1.0", 0, 2],
    );
  });

  test("更新と同じ時刻に公開した版は更新後に数える", () => {
    const row = sameDayRow("2026-09-03T01:00:00.000Z");
    assert.equal(row.next_version, "1.0");
  });

  test("公開日時が分からない版(null)は、記録に現れた日だけで決める", () => {
    const row = sameDayRow(null);
    assert.deepEqual(
      [row.version_at_event, row.next_version, row.days_to_next, row.old_downloads],
      ["0.9", "1.0", 0, 2],
    );
  });

  test("DB から来る Date 型の released_at でも同じ結果になる", () => {
    assert.deepEqual(sameDayRow(new Date("2026-09-02T20:00:00.000Z")), sameDayRow("2026-09-02T20:00:00.000Z"));
  });

  test("同じ日に、更新の前に出した版と後に出した版が両方現れた時は、前の版が旧版、後の版が次の版", () => {
    const rows = [
      ...capture("2026-09-01", { "1.0": 100 }),
      ...capture("2026-09-02", { "1.0": 105 }),
      ...capture("2026-09-03", { "1.0": 106, "1.1": 8, "1.2": 30 }),
      ...capture("2026-09-04", { "1.0": 106, "1.1": 9, "1.2": 70 }),
    ];
    const [event] = buildEventImpacts({
      mods: [{ mod_id: 30, name: "TwoSameDay", platform: "thunderstore", is_deprecated: false }],
      versionSnapshotsByMod: new Map([[30, rows]]),
      events: [{ event_id: 300, occurred_at: "2026-09-03T01:00:00.000Z", kind: "game_patch", title: "Patch", url: null, source: "steam", mod_id: null }],
      versionsByMod: new Map([[30, [
        { version_number: "1.2", released_at: "2026-09-03T06:00:00.000Z" },
        { version_number: "1.1", released_at: "2026-09-02T18:00:00.000Z" },
        { version_number: "1.0", released_at: null },
      ]]]),
    });
    const [row] = event.mods;
    assert.equal(row.version_at_event, "1.1");
    assert.equal(row.next_version, "1.2");
    assert.equal(row.days_to_next, 0);
    assert.equal(row.old_downloads, 1 + 8);  // 9/03 の 1.0 と 1.1
    assert.equal(row.next_first_2_days, 30 + 40);
    assert.equal(row.days_to_90pct, 1);  // 9/03 は 30 / 39 = 77%、9/04 は 40 / 41 = 98%
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
    assert.deepEqual(thunderstore.summary, {
      mod_count: 2, next_count: 2, median_days_to_next: 0.5, old_downloads_total: 22,
      basis: "all", checked_count: 0, needs_fix_count: 0,
    });

    const [nexus] = selectEventImpacts(impacts, "nexusmods");
    assert.deepEqual(nexus.summary, {
      mod_count: 1, next_count: 0, median_days_to_next: null, old_downloads_total: 11,
      basis: "all", checked_count: 0, needs_fix_count: 0,
    });

    const [all] = selectEventImpacts(impacts, null);
    assert.deepEqual(all.summary, {
      mod_count: 3, next_count: 2, median_days_to_next: 0.5, old_downloads_total: 33,
      basis: "all", checked_count: 0, needs_fix_count: 0,
    });
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

// ---- 修正が必要だったかの記録 ----
// syntheticInput の 3 つの mod(更新 100 に対して):
//   10 Half     thunderstore  1 日で新しい版、旧版 20
//   11 NoNext   nexusmods     新しい版なし、旧版 11
//   12 SameDay  thunderstore  0 日で新しい版、旧版 2
// 記録が無い時の並びは [12, 10, 11]
function selectWithAssessments(assessments, platform) {
  const input = syntheticInput();
  const impacts = buildEventImpacts({ ...input, assessments: assessments });
  return selectEventImpacts(impacts, platform);
}

describe("修正が必要だったかの記録", () => {
  test("記録が無ければ needs_fix は null で、合計も並びも今までどおり。ほかの更新の記録は混ざらない", () => {
    const [event] = selectWithAssessments([{ event_id: 999, mod_id: 10, needs_fix: true }], null);
    assert.deepEqual(event.mods.map((r) => [r.mod_id, r.needs_fix]), [[12, null], [10, null], [11, null]]);
    assert.equal(event.summary.basis, "all");
    assert.equal(event.summary.mod_count, 3);
  });

  test("全部に記録がある: 修正が必要だった mod だけで合計し、必要 → 不要の順に並べる", () => {
    const [event] = selectWithAssessments([
      { event_id: 100, mod_id: 10, needs_fix: true },
      { event_id: 100, mod_id: 11, needs_fix: true },
      { event_id: 100, mod_id: 12, needs_fix: false },
    ], null);
    // 必要な 10 と 11 は元の並び(10 が先)のまま、不要な 12 は後
    assert.deepEqual(event.mods.map((r) => [r.mod_id, r.needs_fix]), [[10, true], [11, true], [12, false]]);
    assert.deepEqual(event.summary, {
      mod_count: 2, next_count: 1, median_days_to_next: 1, old_downloads_total: 20 + 11,
      basis: "needs_fix", checked_count: 3, needs_fix_count: 2,
    });
  });

  test("一部だけ記録がある: 記録が 1 つでもあれば修正が必要だった mod だけで合計し、未確認は最後", () => {
    const [event] = selectWithAssessments([
      { event_id: 100, mod_id: 10, needs_fix: true },
      { event_id: 100, mod_id: 11, needs_fix: false },
    ], null);
    assert.deepEqual(event.mods.map((r) => [r.mod_id, r.needs_fix]), [[10, true], [11, false], [12, null]]);
    assert.deepEqual(event.summary, {
      mod_count: 1, next_count: 1, median_days_to_next: 1, old_downloads_total: 20,
      basis: "needs_fix", checked_count: 2, needs_fix_count: 1,
    });
  });

  test("確認した mod がどれも修正不要なら、合計は 0 本", () => {
    const [event] = selectWithAssessments([{ event_id: 100, mod_id: 12, needs_fix: false }], "thunderstore");
    assert.deepEqual(event.summary, {
      mod_count: 0, next_count: 0, median_days_to_next: null, old_downloads_total: 0,
      basis: "needs_fix", checked_count: 1, needs_fix_count: 0,
    });
  });

  test("片方のプラットフォームにだけ記録がある: 合計の対象は絞った後の行で決める", () => {
    const assessments = [{ event_id: 100, mod_id: 11, needs_fix: true }];  // Nexus Mods の mod だけ

    const [thunderstore] = selectWithAssessments(assessments, "thunderstore");
    assert.equal(thunderstore.summary.basis, "all");
    assert.deepEqual(thunderstore.mods.map((r) => r.mod_id), [12, 10]);
    assert.equal(thunderstore.summary.mod_count, 2);

    const [nexus] = selectWithAssessments(assessments, "nexusmods");
    assert.deepEqual(nexus.summary, {
      mod_count: 1, next_count: 0, median_days_to_next: null, old_downloads_total: 11,
      basis: "needs_fix", checked_count: 1, needs_fix_count: 1,
    });

    // 絞らない時は記録が 1 つあるので、Thunderstore の 2 つ(未確認)は合計に入らない
    const [all] = selectWithAssessments(assessments, null);
    assert.deepEqual(all.mods.map((r) => r.mod_id), [11, 12, 10]);
    assert.equal(all.summary.basis, "needs_fix");
    assert.equal(all.summary.mod_count, 1);
  });

  test("needs_fix の無い行(記録を付ける前のキャッシュ)は未確認として扱う", () => {
    const impacts = buildEventImpacts(syntheticInput());
    for (const row of impacts[0].mods) {
      delete row.needs_fix;
    }
    const [event] = selectEventImpacts(impacts, null);
    assert.deepEqual(event.mods.map((r) => r.needs_fix), [null, null, null]);
    assert.equal(event.summary.basis, "all");
  });
});
