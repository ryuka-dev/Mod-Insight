// ============================================================
// dailyIncrease.js
//
// 全 mod の「日ごとの増加数」を計算する。GET /api/overview の daily に使う。
//
// なぜ取得回ごとの合計の差ではだめか:
//   - 取得回ごとの合計は「その時点で記録のある mod」を足しているので、途中で mod が増えると
//     (新しい mod の公開、配布サイトの追加)その mod の既存のダウンロード数がそのまま段差になる
//   - 手動実行した日は 1 日に何回も取得しているので、回ごとの差は 1 日の増加にならない
//
// 計算のしかた:
//   1. mod ごとに 1 日 1 点にそろえる。同じ日に何回か取得していれば、その日の最後の値を使う
//   2. mod ごとに「当日の値 − 前日の値」を出す。前日の記録が無い mod(その日に追加された mod、
//      取得が抜けた日の翌日)は差を出さない。これで mod の追加による段差が入らない
//   3. 日ごとに全 mod の差を足す
//   4. その日を含む直近 7 日がすべてそろっていれば、7 日平均も出す
//
// 「日」の区切り:
//   captured_at の UTC の日付を使う。定時取得は UTC 15:00(日本時間 0:00)に動くので、
//   「UTC 9/23 15:00 の値 − UTC 9/22 15:00 の値」は日本時間 9/23 の 0:00〜24:00 の増加になり、
//   UTC の日付がそのまま「日本時間で何日の増加か」を表す。
//   手動実行(UTC 0〜3 時頃)は同じ UTC 日付の定時取得より前なので、1 の「最後の値」で自然に外れる。
//   ただし定時取得より後(UTC 15:00〜24:00)に手動実行すると、その回がその日の「最後の値」になり、
//   その日の増加に翌日の数時間分が入る(翌日の増加はその分少なくなる)。2026-10-06 16:58 UTC の
//   手動実行で、10/6 の増加に約 2 時間分(両サイト合計で 20 件弱)が入った例がある。
//   手動実行は UTC 15:00 より前に行う。
//
// 差がマイナスになる日(Thunderstore の CDN キャッシュによる 1〜2 件の揺れ)もそのまま足す。
// データ源の性質なので補正しない。
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;

// captured_at(ISO 文字列または Date)→ UTC の日付 "YYYY-MM-DD"
function dayKey(capturedAt) {
  return new Date(capturedAt).toISOString().slice(0, 10);
}

// "YYYY-MM-DD" → 前日の "YYYY-MM-DD"
function previousDayKey(key) {
  return new Date(Date.parse(`${key}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

// 日ごとの増加数を計算する
// 入力: history(db.listSnapshotHistory() の結果 = [{ mod_id, platform, captured_at, download_count }, ...])
//       from(Date または null。これより前の日は結果から外す)
//       platform(文字列または null。null なら全プラットフォーム)
// 出力: [{ date, increase, mod_count, average_7d }, ...]  ※ 古い順
//   date        "YYYY-MM-DD"(日本時間で何日の増加か。上の「日の区切り」参照)
//   increase    その日に増えたダウンロード数(全 mod の合計)
//   mod_count   差を計算できた mod の数
//   average_7d  その日を含む直近 7 日の increase の平均(7 日そろわなければ null)
// 7 日平均は from で絞る前に計算するので、期間の最初の日にも平均が出る。
function buildDailyIncrease(history, from, platform) {
  // 1. mod ごと・日ごとの最後の値: mod_id → Map(日付 → { time, count })
  const lastByModDay = new Map();
  for (const row of history) {
    if (platform !== null && row.platform !== platform) {
      continue;
    }
    const time = new Date(row.captured_at).getTime();
    const key = dayKey(row.captured_at);
    let days = lastByModDay.get(row.mod_id);
    if (!days) {
      days = new Map();
      lastByModDay.set(row.mod_id, days);
    }
    const current = days.get(key);
    if (!current || time > current.time) {
      days.set(key, { time: time, count: row.download_count });
    }
  }

  // 2. と 3. mod ごとの前日との差を、日ごとに足す
  const byDay = new Map(); // 日付 → { date, increase, mod_count }
  for (const days of lastByModDay.values()) {
    for (const [key, point] of days) {
      const previous = days.get(previousDayKey(key));
      if (!previous) {
        continue;
      }
      let day = byDay.get(key);
      if (!day) {
        day = { date: key, increase: 0, mod_count: 0 };
        byDay.set(key, day);
      }
      day.increase += point.count - previous.count;
      day.mod_count += 1;
    }
  }

  const daily = Array.from(byDay.values());
  daily.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 4. 直近 7 日の平均(小数第 1 位まで)
  for (const day of daily) {
    let sum = 0;
    let found = 0;
    let key = day.date;
    for (let i = 0; i < 7; i++) {
      const target = byDay.get(key);
      if (target) {
        sum += target.increase;
        found++;
      }
      key = previousDayKey(key);
    }
    day.average_7d = found === 7 ? Math.round((sum / 7) * 10) / 10 : null;
  }

  if (from === null) {
    return daily;
  }
  const fromKey = dayKey(from);
  return daily.filter((day) => day.date >= fromKey);
}

// dayKey は releaseImpact.js も使う(「日」の区切りをこのファイルの定義にそろえるため)
module.exports = { buildDailyIncrease, dayKey };
