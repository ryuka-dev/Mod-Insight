// 発表動画で使う数字を、ダッシュボードの公開 API から取って 1 つのファイルにまとめる。
//
// 解決すること: 動画の各場面が別々に数字を持つと、場面どうしで値がずれる。
//   ここで取った値だけを video/assets/data.js に書き出し、すべての場面がそれを読む。
// 入力: 公開 API(GET のみ。Blob キャッシュから返るので DB は起こさない)
// 出力: video/assets/data.js(window.MI_DATA に代入する形。動画の中では通信できないため JSON をそのまま埋め込む)
//
// 使い方: node presentation/tools/fetch-data.mjs

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "https://mod-insight-ryuka-hrhbbdauc0ezbfc7.eastasia-01.azurewebsites.net/api";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "video", "assets", "data.js");

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// UTC の日時を日本時間の日付(YYYY-MM-DD)にする
function jstDate(iso) {
  return new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

const [overview, overviewTs, overviewNx, events, impactsTs, costs] = await Promise.all([
  get("/overview"),
  get("/overview?platform=thunderstore"),
  get("/overview?platform=nexusmods"),
  get("/events"),
  get("/event-impacts?platform=thunderstore"),
  get("/costs"),
]);

// 1.0(大型アップデート)の行。修正が必要だった mod だけを使う
const major = impactsTs.find((e) => e.kind === "game_major");
if (!major) throw new Error("大型アップデートの記録が見つからない");
const patch102 = impactsTs.find((e) => e.title.includes("1.0.2"));

// 月ごとの費用(確定した日までの合計)
const costByMonth = {};
for (const d of costs.days) {
  const m = d.date.slice(0, 7);
  costByMonth[m] = (costByMonth[m] ?? 0) + d.total;
}

const data = {
  fetchedAt: new Date().toISOString(),
  latestCapturedAt: overview.latest_captured_at,
  totals: {
    all: overview.total_downloads,
    thunderstore: overviewTs.total_downloads,
    nexusmods: overviewNx.total_downloads,
    modCount: overview.mod_count,
  },
  // 全 mod の合計の推移(取得回ごと)
  totalsSeries: overview.totals.map((t) => ({ date: jstDate(t.captured_at), value: t.download_count })),
  // 日ごとの増加(両サイトの合計)
  daily: overview.daily.map((d) => ({ date: d.date, value: d.increase, avg7: d.average_7d })),
  // ゲームの大型アップデートとパッチ(日本時間の日付)
  gameEvents: events
    .filter((e) => e.kind === "game_major" || e.kind === "game_patch")
    .map((e) => ({ date: jstDate(e.occurred_at), kind: e.kind, title: e.title })),
  case10: {
    title: major.title,
    day: major.day,
    checked: major.summary.checked_count,
    needsFix: major.summary.needs_fix_count,
    released: major.summary.next_count,
    medianDaysFromMajor: major.summary.median_days_to_next,
    medianDaysFrom102: patch102?.summary.median_days_to_next ?? null,
    oldDownloads: major.summary.old_downloads_total,
    mods: major.mods
      .filter((m) => m.needs_fix)
      .map((m) => ({
        name: m.name,
        from: m.version_at_event,
        to: m.next_version,
        fixedDay: m.next_first_day,
        days: m.days_to_next,
        oldDownloads: m.old_downloads,
      })),
    allModNames: major.mods.map((m) => ({ name: m.name, needsFix: m.needs_fix })),
  },
  costs: {
    days: costs.days.map((d) => ({ date: d.date, total: d.total })),
    byMonth: Object.fromEntries(Object.entries(costByMonth).map(([k, v]) => [k, Math.round(v)])),
  },
};

const body =
  "// presentation/tools/fetch-data.mjs が生成するファイル。手で直さない。\n" +
  `window.MI_DATA = ${JSON.stringify(data, null, 2)};\n`;
await writeFile(OUT, body, "utf8");
console.log(`書き出し: ${OUT}`);
console.log(
  `合計 ${data.totals.all} / 1.0: 修正 ${data.case10.needsFix} 本、旧版 ${data.case10.oldDownloads}、中央値 ${data.case10.medianDaysFromMajor} 日(1.0.2 から ${data.case10.medianDaysFrom102} 日)`,
);
