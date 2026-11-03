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
//   - 新しい版が出た後、どれくらいの速さで新しい版にダウンロードが移ったか
//
// 測れないこと:
//   - その mod が実際に壊れていたかどうか。ダウンロード数からは分からないので、
//     「修正版」ではなく「更新後に最初に出した版」と呼ぶ
//   - 何人が実際にその版を使っているか(分かるのはダウンロード数だけ)
//
// 言葉の決まり:
//   更新日 D       出来事の日時(occurred_at)を日本時間にした日付
//                  (例: 2026-10-28T13:06:51Z は日本時間 10/28 22:06 なので D = 10/28)
//   「日」の区切り  dailyIncrease.js と同じ。captured_at の UTC の日付 = 日本時間で何日の分か
//   日ごとの増加    releaseImpact.js の buildVersionDays と同じ数え方
//                  (1 日 1 点、前日にその mod の記録が無い日は数えない、新しい版は前日 0 から)
//   初めて現れた日  その版が初めて記録に現れた日(release_date ではない。理由は releaseImpact.js)
//
// 対象:
//   D の前日(D-1)に記録がある、非推奨でない mod。
//   D-1 に記録のある mod が 1 つも無い更新(記録を始める前の更新)は結果に入れない。
//
// mod ごとに出すもの:
//   version_at_event   D-1 の時点であった版のうち、一番新しいもの(初めて現れた日が一番遅いもの。
//                      同じ日に現れた版どうしは記録の並び順 = 公開日順で後のもの)
//   next_version       初めて現れた日が D 以降の版のうち、最初のもの(更新後に最初に出した版)。無ければ null
//                      分かっている限界: D の日に、ゲームの更新より前に出した版も「更新後」に数えてしまう
//                      (記録が 1 日 1 回なので、同じ日の中の前後は分からない)
//   next_first_day     next_version が初めて現れた日 "YYYY-MM-DD"
//   days_to_next       next_first_day − D の日数(同じ日なら 0)
//   old_downloads      旧版(D-1 の時点であった版すべて)の、D から next_first_day までのダウンロードの合計。
//                      next_version が無ければ D から記録の最後の日まで。
//                      記録は 1 日単位なので両端の日をどちらも含める。そのため多めの見積もり(上限の目安)
//   old_days           old_downloads に実際に足した日数(前日の記録が無く増加を出せない日は数えない)
//   next_first_2_days  next_version の、初めて現れた日とその翌日のダウンロードの合計
//                      (mod マネージャーで更新した人の数の下限の目安。Thunderstore でだけ意味がある)
//   next_days_counted  next_first_2_days に足した日数(翌日の記録がまだ無ければ 1)
//   days_to_90pct      next_version がその日の全ダウンロードの 90% 以上になった最初の日が、
//                      初めて現れた日から何日後か(0 = 初めて現れた日)。14 日以内に届かなければ null。
//                      その日の全ダウンロードが 0 以下の日は飛ばす
//   next_version が無い時は next_ で始まる項目と days_to_next / days_to_90pct はすべて null。
//
// 並び順: next_version がある mod を先に(days_to_next の小さい順、同じなら old_downloads の多い順)、
//         無い mod はその後に old_downloads の多い順。どちらも最後は名前順。
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

// 1 つの mod の、1 つの更新に対する対応状況を計算する
// 入力: versionDays(buildVersionDays の結果)、lastDay(その mod の記録の最後の日 "YYYY-MM-DD")、
//       eventDay(更新日 D "YYYY-MM-DD")
// 出力: { version_at_event, next_version, next_first_day, days_to_next, old_downloads, old_days,
//         next_first_2_days, next_days_counted, days_to_90pct }
//       D-1 にこの mod の記録が無ければ null(この更新については何も言えない)
function buildModImpact(versionDays, lastDay, eventDay) {
  const { byDay, daily, firstDays } = versionDays;
  const dayBefore = addDays(eventDay, -1);
  if (!byDay.has(dayBefore)) {
    return null;
  }

  // 旧版(D-1 の時点であった版)と、更新後に最初に出した版を決める
  // firstDays は初めて現れた日の古い順に並んでいるので、
  //   旧版のうち最後に見つかったもの = 一番新しい旧版、
  //   D 以降で最初に見つかったもの   = 更新後に最初に出した版
  const oldVersions = new Set();
  let versionAtEvent = null;
  let nextVersion = null;
  let nextFirstDay = null;
  for (const [version, firstDay] of firstDays) {
    if (firstDay < eventDay) {
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

  // 次の版がその日のダウンロードの 90% 以上になった最初の日(初めて現れた日を 0 日後とする)
  for (let k = 0; k < SHARE_DAYS; k++) {
    const day = daily.get(addDays(nextFirstDay, k));
    if (!day || day.total <= 0) {
      continue;
    }
    const increase = day.byVersion.get(nextVersion) || 0;
    if (increase / day.total >= SHARE_THRESHOLD) {
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
// }
// 出力: [{ event_id, occurred_at, kind, title, url, day,
//          mods: [{ mod_id, name, platform, version_at_event, next_version, next_first_day, days_to_next,
//                   old_downloads, old_days, next_first_2_days, next_days_counted, days_to_90pct }, ...] }, ...]
//       ※ 新しい更新が先。day は更新日 D。合計(summary)はここでは付けない(selectEventImpacts で付ける)
function buildEventImpacts({ mods, versionSnapshotsByMod, events }) {
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
    modDays.push({ mod: mod, versionDays: versionDays, lastDay: keys[keys.length - 1] });
  }

  const results = [];
  for (const event of events) {
    if (!ANCHOR_KINDS.includes(event.kind)) {
      continue;
    }
    const eventDay = eventDayKey(event.occurred_at);
    const rows = [];
    for (const { mod, versionDays, lastDay } of modDays) {
      const impact = buildModImpact(versionDays, lastDay, eventDay);
      if (impact === null) {
        continue;
      }
      rows.push({ mod_id: mod.mod_id, name: mod.name, platform: mod.platform, ...impact });
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
// 入力: rows(mod ごとの行の配列)
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

// buildEventImpacts の結果を platform で絞り、更新ごとの合計(summary)を付ける
// 入力: impacts(buildEventImpacts の結果)、platform(文字列または null。null なら全プラットフォーム)
// 出力: [{ event_id, occurred_at, kind, title, url, day, summary, mods }, ...]
//       絞った結果 mod が 1 つも無い更新は入れない
// 合計は絞った後の行から出す(キャッシュでも DB でも、合計の計算はここだけ)
function selectEventImpacts(impacts, platform) {
  const results = [];
  for (const impact of impacts) {
    const rows = impact.mods.filter((row) => platform === null || row.platform === platform);
    if (rows.length === 0) {
      continue;
    }
    results.push({
      event_id: impact.event_id,
      occurred_at: impact.occurred_at,
      kind: impact.kind,
      title: impact.title,
      url: impact.url,
      day: impact.day,
      summary: summarizeEventImpact(rows),
      mods: rows,
    });
  }
  return results;
}

module.exports = { buildEventImpacts, selectEventImpacts, summarizeEventImpact, eventDayKey };
