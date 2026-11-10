// ============================================================
// eventImpact.js
//
// ゲーム本体の更新(events の kind が 'game_major' / 'game_patch' のもの)ごとに、
// mod ごとの対応状況を計算する。GET /api/event-impacts に使う。
//
// 知りたいこと:
//   - ゲームの更新から、mod の新しい版を出すまでに何日かかったか
//   - その間に、更新前の版が何回ダウンロードされたか
//     (その mod が壊れていた場合に、影響を受けた可能性のある人数の目安)
//   - 新しい版が出た後、どれくらいの速さでダウンロードが旧版から離れたか
//
// 測れないこと:
//   - その mod が実際に壊れていたかどうか。ダウンロード数からは分からないので、
//     「修正版」ではなく「更新後に最初に出した版」と呼ぶ
//     (壊れていたかどうかは、下の「修正が必要だったか」の記録があればそれを使う)
//   - 何人が実際にその版を使っているか(分かるのはダウンロード数だけ)
//
// 修正が必要だったか(needs_fix):
//   互換性チェック(ゲームの新しいビルドで各 mod を確かめる作業)の結論。event_mod_assessments(sql/005)から来る。
//   true = その更新の時点で修正が必要な状態だった(前の更新で必要になり、まだ直した版を出していない場合を含む)、
//   false = 確認して、必要な状態ではなかった、null = 未確認(記録が無い)
//
// 言葉の決まり:
//   更新日 D       出来事の日時(occurred_at)を日本時間にした日付
//                  (例: 2026-10-28T13:06:51Z は日本時間 10/28 22:06 なので D = 10/28)
//   「日」の区切り  dailyIncrease.js と同じ。captured_at の UTC の日付 = 日本時間で何日の分か
//   日ごとの増加    releaseImpact.js の buildVersionDays と同じ数え方
//                  (1 日 1 点、前日にその mod の記録が無い日は数えない、新しい版は前日 0 から)
//   初めて現れた日  その版が初めて記録に現れた日(release_date ではない。理由は releaseImpact.js)
//   旧版           更新の時点であった版。次のどちらかに当てはまる版
//                    - 初めて現れた日が D より前
//                    - 公開日時(mod_versions.released_at)が、更新の時刻(occurred_at)より前
//                  2 つ目を見るのは、記録が 1 日 1 回で、D の日に現れた版が更新の前に出たのか後に出たのかを
//                  記録だけでは決められないため。公開が取得の直前だと、前日に出した版が D の日に現れることもある
//                  (例: ArmsRace 1.0.4 の公開は日本時間 11/09 10:17、パッチ 1.0.6 は同じ日の 19:52。
//                   記録だけで決めると、更新の 9 時間半前に出した版が「0 日で対応した版」になってしまう)
//                  公開日時が分からない版は 1 つ目だけで決める
//                  更新の時刻は Steam のお知らせが投稿された時刻で、ゲームが配信された時刻そのものではない
//
// 対象:
//   D の前日(D-1)に記録がある、非推奨でない mod。
//   D-1 に記録のある mod が 1 つも無い更新(記録を始める前の更新)は結果に入れない。
//
// mod ごとに出すもの:
//   version_at_event   旧版のうち、一番新しいもの(初めて現れた日が一番遅いもの。
//                      同じ日に現れた版どうしは記録の並び順 = 公開日順で後のもの)
//   next_version       旧版でない版のうち、最初に現れたもの(更新後に最初に出した版)。無ければ null
//                      分かっている限界: 公開日時が分からない版が D の日に現れると、
//                      更新より前に出していても「更新後」に数えてしまう
//   next_first_day     next_version が初めて現れた日 "YYYY-MM-DD"
//   days_to_next       next_first_day − D の日数(同じ日なら 0)
//   old_downloads      旧版すべての、D から next_first_day までのダウンロードの合計。
//                      next_version が無ければ D から記録の最後の日まで。
//                      記録は 1 日単位なので両端の日をどちらも含める。そのため多めの見積もり(上限の目安)
//   old_days           old_downloads に実際に足した日数(前日の記録が無く増加を出せない日は数えない)
//   next_first_2_days  next_version の、初めて現れた日とその翌日のダウンロードの合計
//                      (mod マネージャーで更新した人の数の下限の目安。Thunderstore でだけ意味がある)
//   next_days_counted  next_first_2_days に足した日数(翌日の記録がまだ無ければ 1)
//   days_to_90pct      更新後に出した版(旧版以外のすべての版)がその日の全ダウンロードの 90% 以上になった最初の日が、
//                      next_version が初めて現れた日から何日後か(0 = 初めて現れた日)。14 日以内に届かなければ null。
//                      その日の全ダウンロードが 0 以下の日は飛ばす。
//                      next_version だけで測らないのは、続けて次の版を出すと(例: 1.5.0 の翌日に 1.6.0)
//                      ダウンロードがさらに新しい版へ移り、旧版から離れたのに「届かない」と出てしまうため
//   next_version が無い時は next_ で始まる項目と days_to_next / days_to_90pct はすべて null。
//
// 並び順: next_version がある mod を先に(days_to_next の小さい順、同じなら old_downloads の多い順)、
//         無い mod はその後に old_downloads の多い順。どちらも最後は名前順。
//         合計を「修正が必要だった mod」で出す更新では、その並びのまま、
//         修正が必要だった mod → 不要だった mod → 未確認の mod の順にまとめる(selectEventImpacts)。
//
// 合計(summary)の対象(selectEventImpacts。platform で絞った後の行で決める):
//   basis "needs_fix"  修正が必要だったかの記録が 1 つでもある更新。修正が必要だった mod(needs_fix が true)だけで合計する。
//                      修正が要らなかった mod は新しい版を出す必要が無いので、混ぜると日数や旧版のダウンロードの意味が薄れるため
//   basis "all"        記録が 1 つも無い更新。すべての mod で合計する(記録を付ける前と同じ)
// ============================================================

const { buildVersionDays, addDays } = require("./releaseImpact");

const DAY_MS = 24 * 60 * 60 * 1000;

// 日本時間と UTC の差(ミリ秒)
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 対応状況を計算するゲームの出来事の種類(お知らせやメモは対象外)
const ANCHOR_KINDS = ["game_major", "game_patch"];

// 新しい版の割合が 90% を超えるまでを探す日数
const SHARE_DAYS = 14;

// 新しい版に移ったとみなす割合
const SHARE_THRESHOLD = 0.9;

// 出来事の日時(ISO 文字列または Date)→ 日本時間の日付 "YYYY-MM-DD"
// web/app.js の jstDateKey と同じ計算
function eventDayKey(occurredAt) {
  return new Date(new Date(occurredAt).getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

// "YYYY-MM-DD" どうしの日数の差(later − earlier)
function daysBetween(earlier, later) {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS);
}

// バージョン → 公開日時(ミリ秒)の対応を作る
// 入力: versions(db.listModVersions の結果 = [{ version_number, released_at, ... }, ...]。無ければ undefined)
//       released_at は DB からは Date、キャッシュからは ISO 文字列で来る。分からない版は null
// 出力: Map(バージョン → ミリ秒)。公開日時が分からない版は入れない
function buildReleasedTimes(versions) {
  const releasedTimes = new Map();
  for (const version of versions || []) {
    if (version.released_at === null || version.released_at === undefined) {
      continue;
    }
    const time = new Date(version.released_at).getTime();
    if (!Number.isNaN(time)) {
      releasedTimes.set(version.version_number, time);
    }
  }
  return releasedTimes;
}

// 1 つの mod の、1 つの更新に対する対応状況を計算する
// 入力: versionDays(buildVersionDays の結果)、lastDay(その mod の記録の最後の日 "YYYY-MM-DD")、
//       eventDay(更新日 D "YYYY-MM-DD")、eventTime(更新の時刻、ミリ秒)、
//       releasedTimes(buildReleasedTimes の結果)
// 出力: { version_at_event, next_version, next_first_day, days_to_next, old_downloads, old_days,
//         next_first_2_days, next_days_counted, days_to_90pct }
//       D-1 にこの mod の記録が無ければ null(この更新については何も言えない)
function buildModImpact(versionDays, lastDay, eventDay, eventTime, releasedTimes) {
  const { byDay, daily, firstDays } = versionDays;
  const dayBefore = addDays(eventDay, -1);
  if (!byDay.has(dayBefore)) {
    return null;
  }

  // 旧版(更新の時点であった版)と、更新後に最初に出した版を決める
  // firstDays は初めて現れた日の古い順に並んでいるので、
  //   旧版のうち最後に見つかったもの     = 一番新しい旧版、
  //   旧版でないもので最初に見つかったもの = 更新後に最初に出した版
  const oldVersions = new Set();
  let versionAtEvent = null;
  let nextVersion = null;
  let nextFirstDay = null;
  for (const [version, firstDay] of firstDays) {
    // 更新日より前に記録に現れたか、公開日時が更新の時刻より前なら旧版(上の「言葉の決まり」)
    const releasedTime = releasedTimes.get(version);
    const releasedBeforeEvent = releasedTime !== undefined && releasedTime < eventTime;
    if (firstDay < eventDay || releasedBeforeEvent) {
      oldVersions.add(version);
      versionAtEvent = version;
    } else if (nextVersion === null) {
      nextVersion = version;
      nextFirstDay = firstDay;
    }
  }

  // 旧版のダウンロード: D から(次の版が初めて現れた日 または 記録の最後の日)まで、両端を含む
  const endDay = nextFirstDay !== null ? nextFirstDay : lastDay;
  let oldDownloads = 0;
  let oldDays = 0;
  for (let key = eventDay; key <= endDay; key = addDays(key, 1)) {
    const day = daily.get(key);
    if (!day) {
      continue;  // 前日の記録が無く、増加を出せない日
    }
    for (const [version, increase] of day.byVersion) {
      if (oldVersions.has(version)) {
        oldDownloads += increase;
      }
    }
    oldDays++;
  }

  const result = {
    version_at_event: versionAtEvent,
    next_version: nextVersion,
    next_first_day: nextFirstDay,
    days_to_next: null,
    old_downloads: oldDownloads,
    old_days: oldDays,
    next_first_2_days: null,
    next_days_counted: null,
    days_to_90pct: null,
  };
  if (nextVersion === null) {
    return result;
  }

  result.days_to_next = daysBetween(eventDay, nextFirstDay);

  // 次の版の最初の 2 日(初めて現れた日と翌日)のダウンロード
  let firstTwo = 0;
  let counted = 0;
  for (const key of [nextFirstDay, addDays(nextFirstDay, 1)]) {
    const day = daily.get(key);
    if (day) {
      firstTwo += day.byVersion.get(nextVersion) || 0;
      counted++;
    }
  }
  result.next_first_2_days = counted > 0 ? firstTwo : null;
  result.next_days_counted = counted;

  // 旧版以外(更新後に出した版すべて)がその日のダウンロードの 90% 以上になった最初の日
  // (next_version が初めて現れた日を 0 日後とする)
  for (let k = 0; k < SHARE_DAYS; k++) {
    const day = daily.get(addDays(nextFirstDay, k));
    if (!day || day.total <= 0) {
      continue;
    }
    let oldIncrease = 0;
    for (const [version, increase] of day.byVersion) {
      if (oldVersions.has(version)) {
        oldIncrease += increase;
      }
    }
    if ((day.total - oldIncrease) / day.total >= SHARE_THRESHOLD) {
      result.days_to_90pct = k;
      break;
    }
  }

  return result;
}

// mod ごとの行を並べ替える(上の「並び順」)
// 入力: rows(buildEventImpacts の mods の要素の配列)
// 出力: なし(rows をその場で並べ替える)
function sortImpactRows(rows) {
  rows.sort((a, b) => {
    const aHasNext = a.next_version !== null;
    const bHasNext = b.next_version !== null;
    if (aHasNext !== bHasNext) {
      return aHasNext ? -1 : 1;
    }
    if (aHasNext && a.days_to_next !== b.days_to_next) {
      return a.days_to_next - b.days_to_next;
    }
    if (a.old_downloads !== b.old_downloads) {
      return b.old_downloads - a.old_downloads;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// ゲームの更新ごとの対応状況を計算する
// 入力: {
//   mods:                   db.listMods() の結果([{ mod_id, name, platform, is_deprecated, ... }, ...])
//   versionSnapshotsByMod:  Map(mod_id → db.listVersionSnapshots(mod_id, null, null) の結果)
//   events:                 db.listEvents() の結果([{ event_id, occurred_at, kind, title, url, ... }, ...])
//   assessments:            db.listEventModAssessments() の結果([{ event_id, mod_id, needs_fix }, ...])。省略時は記録なし
//   versionsByMod:          Map(mod_id → db.listModVersions(mod_id) の結果)。版の公開日時(released_at)を見るために使う。
//                           省略した時と、released_at が null の版は、記録に現れた日だけで旧版かどうかを決める
// }
// 出力: [{ event_id, occurred_at, kind, title, url, day,
//          mods: [{ mod_id, name, platform, needs_fix, version_at_event, next_version, next_first_day, days_to_next,
//                   old_downloads, old_days, next_first_2_days, next_days_counted, days_to_90pct }, ...] }, ...]
//       ※ 新しい更新が先。day は更新日 D。合計(summary)はここでは付けない(selectEventImpacts で付ける)
function buildEventImpacts({ mods, versionSnapshotsByMod, events, assessments, versionsByMod }) {
  // "event_id/mod_id" → needs_fix(true / false)。無い組み合わせは未確認
  const needsFixByKey = new Map();
  for (const assessment of assessments || []) {
    needsFixByKey.set(`${assessment.event_id}/${assessment.mod_id}`, assessment.needs_fix);
  }

  // mod ごとの「日ごとの増加」は更新ごとに作り直さず、最初に 1 回だけ作る
  const modDays = [];
  for (const mod of mods) {
    if (mod.is_deprecated) {
      continue;
    }
    const rows = versionSnapshotsByMod.get(mod.mod_id) || [];
    const versionDays = buildVersionDays(rows);
    const keys = Array.from(versionDays.byDay.keys()).sort();
    if (keys.length === 0) {
      continue;
    }
    const releasedTimes = buildReleasedTimes(versionsByMod ? versionsByMod.get(mod.mod_id) : undefined);
    modDays.push({ mod: mod, versionDays: versionDays, lastDay: keys[keys.length - 1], releasedTimes: releasedTimes });
  }

  const results = [];
  for (const event of events) {
    if (!ANCHOR_KINDS.includes(event.kind)) {
      continue;
    }
    const eventDay = eventDayKey(event.occurred_at);
    const eventTime = new Date(event.occurred_at).getTime();
    const rows = [];
    for (const { mod, versionDays, lastDay, releasedTimes } of modDays) {
      const impact = buildModImpact(versionDays, lastDay, eventDay, eventTime, releasedTimes);
      if (impact === null) {
        continue;
      }
      const key = `${event.event_id}/${mod.mod_id}`;
      const needsFix = needsFixByKey.has(key) ? needsFixByKey.get(key) : null;
      rows.push({ mod_id: mod.mod_id, name: mod.name, platform: mod.platform, needs_fix: needsFix, ...impact });
    }
    // 前日に記録のある mod が 1 つも無い(記録を始める前の)更新は入れない
    if (rows.length === 0) {
      continue;
    }
    sortImpactRows(rows);
    results.push({
      event_id: event.event_id,
      occurred_at: event.occurred_at,
      kind: event.kind,
      title: event.title,
      url: event.url,
      day: eventDay,
      mods: rows,
    });
  }

  // events は古い順で来るので、新しい更新が先になるよう並べ替える
  results.sort((a, b) => {
    const diff = new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime();
    return diff !== 0 ? diff : b.event_id - a.event_id;
  });
  return results;
}

// mod ごとの行から、1 つの更新についての合計を出す
// 入力: rows(合計する mod の行の配列。どの行を入れるかは selectEventImpacts が決める)
// 出力: { mod_count, next_count, median_days_to_next, old_downloads_total }
//   mod_count            集計した mod の数
//   next_count           更新後に新しい版を出した mod の数
//   median_days_to_next  新しい版までの日数の中央値(偶数個なら真ん中 2 つの平均。出した mod が無ければ null)
//   old_downloads_total  旧版のダウンロードの合計(多めの見積もりの合計)
function summarizeEventImpact(rows) {
  const days = rows
    .filter((row) => row.next_version !== null)
    .map((row) => row.days_to_next)
    .sort((a, b) => a - b);
  let median = null;
  if (days.length > 0) {
    const middle = Math.floor(days.length / 2);
    median = days.length % 2 === 1 ? days[middle] : (days[middle - 1] + days[middle]) / 2;
  }
  return {
    mod_count: rows.length,
    next_count: days.length,
    median_days_to_next: median,
    old_downloads_total: rows.reduce((sum, row) => sum + row.old_downloads, 0),
  };
}

// 修正が必要だったかの並び順(必要 → 不要 → 未確認)
function needsFixRank(row) {
  if (row.needs_fix === true) {
    return 0;
  }
  return row.needs_fix === false ? 1 : 2;
}

// buildEventImpacts の結果を platform で絞り、更新ごとの合計(summary)を付ける
// 入力: impacts(buildEventImpacts の結果)、platform(文字列または null。null なら全プラットフォーム)
// 出力: [{ event_id, occurred_at, kind, title, url, day, summary, mods }, ...]
//       summary = { mod_count, next_count, median_days_to_next, old_downloads_total,
//                   basis, checked_count, needs_fix_count }
//         basis            "needs_fix" または "all"(上の「合計の対象」)。上の 4 つはこの対象の行だけで出す
//         checked_count    修正が必要だったかの記録がある mod の数(needs_fix が null でない行)
//         needs_fix_count  修正が必要だった mod の数
//       絞った結果 mod が 1 つも無い更新は入れない
// 合計は絞った後の行から出す(キャッシュでも DB でも、合計の計算はここだけ)
function selectEventImpacts(impacts, platform) {
  const results = [];
  for (const impact of impacts) {
    // needs_fix が無い行(記録を付ける前に作ったキャッシュ)は未確認(null)にそろえる
    const rows = impact.mods
      .filter((row) => platform === null || row.platform === platform)
      .map((row) => ({ ...row, needs_fix: row.needs_fix === true || row.needs_fix === false ? row.needs_fix : null }));
    if (rows.length === 0) {
      continue;
    }

    const checkedCount = rows.filter((row) => row.needs_fix !== null).length;
    const needsFixRows = rows.filter((row) => row.needs_fix === true);
    const basis = checkedCount > 0 ? "needs_fix" : "all";
    if (basis === "needs_fix") {
      // sort は同じ順位どうしの並びを変えないので、元の並び(日数の短い順など)はグループの中で保たれる
      rows.sort((a, b) => needsFixRank(a) - needsFixRank(b));
    }

    results.push({
      event_id: impact.event_id,
      occurred_at: impact.occurred_at,
      kind: impact.kind,
      title: impact.title,
      url: impact.url,
      day: impact.day,
      summary: {
        ...summarizeEventImpact(basis === "needs_fix" ? needsFixRows : rows),
        basis: basis,
        checked_count: checkedCount,
        needs_fix_count: needsFixRows.length,
      },
      mods: rows,
    });
  }
  return results;
}

module.exports = { buildEventImpacts, selectEventImpacts, summarizeEventImpact, eventDayKey };
