// ============================================================
// releaseImpact.js
//
// 1 つの mod について、バージョンを公開した前後でダウンロードがどう変わったかを計算する。
// GET /api/mods/{modId}/releases に使う。
//
// 測れることと測れないこと:
//   取れるのはダウンロード数だけで、「何人がどの版を入れているか」は分からない。
//   そこで「移行した人数」ではなく、次の 2 つを出す:
//     - 公開の前 7 日と後 7 日の、1 日あたりのダウンロード(全バージョンの合計)
//     - その日のダウンロードのうち、新しい版が占める割合(公開から 14 日まで)
//
// 計算のしかた:
//   1. バージョンごとに 1 日 1 点にそろえる(同じ日に何回か取得していれば、その日の最後の値)
//   2. 日ごとに、バージョンごとの「当日の値 − 前日の値」を出す。
//      前日にその mod の記録が無い日は計算しない。
//      前日の記録はあるのにそのバージョンが無ければ、新しく公開された版なので前日の値を 0 とする
//   3. 「公開 1 日目」= そのバージョンが初めて記録に現れた日。
//      release_date を使わないのは、release_date は UTC の日付で、下の「日」の区切り(日本時間)と
//      1 日ずれることがあるため(1.5.7 は release_date が 9/21 だが、増え始めたのは 9/22 の分から)
//   4. 公開 1 日目の前日にその mod の記録が無いバージョン(記録を始める前に公開された版)は比べない
//   5. 次のバージョンが現れたら、その前日までで区切る(次の公開の影響を混ぜないため)
//
// 「日」の区切りは dailyIncrease.js と同じ(captured_at の UTC の日付 = 日本時間で何日の分か)。
// ============================================================

const { dayKey } = require("./dailyIncrease");

const DAY_MS = 24 * 60 * 60 * 1000;

// 前後を比べる日数
const WINDOW_DAYS = 7;

// 新しい版の割合を出す日数
const SHARE_DAYS = 14;

// "YYYY-MM-DD" の n 日後(n が負なら前)の "YYYY-MM-DD"
function addDays(key, n) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

// 小数第 1 位までに丸める
function round1(value) {
  return Math.round(value * 10) / 10;
}

// 1 日あたりの平均。日が 1 つも無ければ null
// 入力: daily(日付 → { total, ... } の Map)、keys(平均を取りたい日付の配列。daily に無い日は数えない)
// 出力: { days, average }(days = 実際に平均に使った日数)
function averageOf(daily, keys) {
  const found = keys.filter((key) => daily.has(key));
  if (found.length === 0) {
    return { days: 0, average: null };
  }
  const sum = found.reduce((s, key) => s + daily.get(key).total, 0);
  return { days: found.length, average: round1(sum / found.length) };
}

// 公開の前後を計算する
// 入力: rows(バージョン別の時系列 = [{ version_number, release_date, captured_at, download_count }, ...]、全期間)
// 出力: [{
//         version_number,
//         release_date,   "YYYY-MM-DD"(配布サイトが返した公開日。参考表示用)
//         first_day,      "YYYY-MM-DD"(公開 1 日目 = 初めて記録に現れた日)
//         before: { days, average },  公開前 7 日の 1 日あたりのダウンロード(日数が足りなければある分だけ)
//         after:  { days, average },  公開 1 日目から 7 日(次の公開の前日まで)
//         change,         after.average − before.average(どちらかが null なら null)
//         share: [{ date, day, new_version, total, share }, ...]
//           day = 公開から何日目か(1 始まり)、new_version = 新しい版のその日の増加、
//           total = その日の全バージョンの増加、share = new_version / total の %(total が 0 以下なら null)
//       }, ...]  ※ 新しい公開が先
function buildReleaseImpact(rows) {
  // 1. 日ごと・バージョンごとの最後の値: 日付 → Map(バージョン → { time, count })
  const byDay = new Map();
  const releaseDates = new Map();  // バージョン → release_date
  for (const row of rows) {
    const key = dayKey(row.captured_at);
    const time = new Date(row.captured_at).getTime();
    let versions = byDay.get(key);
    if (!versions) {
      versions = new Map();
      byDay.set(key, versions);
    }
    const current = versions.get(row.version_number);
    if (!current || time > current.time) {
      versions.set(row.version_number, { time: time, count: row.download_count });
    }
    if (!releaseDates.has(row.version_number)) {
      releaseDates.set(row.version_number, row.release_date ? dayKey(row.release_date) : null);
    }
  }

  // 2. 日ごとの増加: 日付 → { total, byVersion: Map(バージョン → 増加) }
  const daily = new Map();
  for (const [key, versions] of byDay) {
    const previous = byDay.get(addDays(key, -1));
    if (!previous) {
      continue;
    }
    const byVersion = new Map();
    let total = 0;
    for (const [version, point] of versions) {
      const before = previous.get(version);
      const increase = point.count - (before ? before.count : 0);
      byVersion.set(version, increase);
      total += increase;
    }
    daily.set(key, { total: total, byVersion: byVersion });
  }

  // 3. バージョンごとの公開 1 日目(初めて記録に現れた日)
  const firstDays = new Map();
  for (const key of Array.from(byDay.keys()).sort()) {
    for (const version of byDay.get(key).keys()) {
      if (!firstDays.has(version)) {
        firstDays.set(version, key);
      }
    }
  }

  // 4. 前日に記録がある(= 記録を始めた後に公開された)バージョンだけを、公開の古い順に並べる
  const releases = Array.from(firstDays.entries())
    .filter(([, firstDay]) => byDay.has(addDays(firstDay, -1)))
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  const results = releases.map(([version, firstDay], i) => {
    // 5. 次の公開があれば、その前日までで区切る
    const next = releases[i + 1];
    const lastDay = next ? addDays(next[1], -1) : null;
    const inRange = (key) => lastDay === null || key <= lastDay;

    const beforeKeys = [];
    for (let n = 1; n <= WINDOW_DAYS; n++) {
      beforeKeys.push(addDays(firstDay, -n));
    }
    const afterKeys = [];
    for (let n = 0; n < WINDOW_DAYS; n++) {
      afterKeys.push(addDays(firstDay, n));
    }
    const before = averageOf(daily, beforeKeys);
    const after = averageOf(daily, afterKeys.filter(inRange));

    const share = [];
    for (let n = 0; n < SHARE_DAYS; n++) {
      const key = addDays(firstDay, n);
      if (!inRange(key) || !daily.has(key)) {
        continue;
      }
      const day = daily.get(key);
      const increase = day.byVersion.get(version) || 0;
      share.push({
        date: key,
        day: n + 1,
        new_version: increase,
        total: day.total,
        share: day.total > 0 ? round1((increase / day.total) * 100) : null,
      });
    }

    return {
      version_number: version,
      release_date: releaseDates.get(version),
      first_day: firstDay,
      before: before,
      after: after,
      change: before.average !== null && after.average !== null ? round1(after.average - before.average) : null,
      share: share,
    };
  });

  return results.reverse();
}

module.exports = { buildReleaseImpact };
