// ============================================================
// GetEventImpacts.js
//
// GET /api/event-impacts?platform=thunderstore
// ゲーム本体の更新(大型アップデートとパッチ)ごとに、mod ごとの対応状況を返す(新しい更新が先)。
// 「更新後に最初に出した版までの日数」「その間の旧版のダウンロード」などの定義は eventImpact.js。
//
// まず Blob キャッシュ(event-impacts.json = 全プラットフォーム分の計算結果)を読み、
// 無ければ DB から同じ材料(mod 一覧、mod ごとのバージョン履歴とバージョン別の時系列、出来事、修正が必要だったかの記録)を読んで計算する。
// DB の場合は mod の数だけ問い合わせるので遅いが、キャッシュが無い時だけなので許容する。
// どちらの場合も、最後に selectEventImpacts で platform を絞って合計(summary)を付ける。
// 修正が必要だったかの記録がある更新では、合計は修正が必要だった mod だけで出す(basis = "needs_fix")。
//
// クエリパラメータ:
//   platform  'thunderstore' / 'nexusmods'(省略可)。省略時は全プラットフォームの mod をまとめて返す
//
// 応答: 200 [{ event_id, occurred_at, kind, title, url, day,
//              summary: { mod_count, next_count, median_days_to_next, old_downloads_total,
//                         basis, checked_count, needs_fix_count },
//              mods: [{ mod_id, name, platform, needs_fix, version_at_event, next_version, next_first_day, days_to_next,
//                       old_downloads, old_days, next_first_2_days, next_days_counted, days_to_90pct }, ...] }, ...]
//           対象の更新が無ければ []
//       400 { error }(platform が知らない値)
//       500 { error }
// ============================================================

const { app } = require("@azure/functions");
const db = require("../db");
const cache = require("../cache");
const { buildEventImpacts, selectEventImpacts } = require("../eventImpact");
const { parsePlatformParam, dataSourceHeaders, errorResponse } = require("../httpUtil");

app.http("GetEventImpacts", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "event-impacts",
  handler: async (request, context) => {
    const platform = parsePlatformParam(request.query.get("platform"));
    if (!platform.ok) {
      return errorResponse(400, "platform は thunderstore または nexusmods で指定してください");
    }

    const cached = await cache.read("event-impacts.json", context);
    if (cached) {
      return {
        status: 200,
        headers: dataSourceHeaders("cache", cached.run_at),
        jsonBody: selectEventImpacts(cached.data, platform.value),
      };
    }

    try {
      const mods = await db.listMods();
      const versionsByMod = new Map();
      const versionSnapshotsByMod = new Map();
      for (const mod of mods) {
        versionsByMod.set(mod.mod_id, await db.listModVersions(mod.mod_id));
        versionSnapshotsByMod.set(mod.mod_id, await db.listVersionSnapshots(mod.mod_id, null, null));
      }
      const events = await db.listEvents();
      const assessments = await db.listEventModAssessments();
      const impacts = buildEventImpacts({
        mods: mods,
        versionSnapshotsByMod: versionSnapshotsByMod,
        events: events,
        assessments: assessments,
        versionsByMod: versionsByMod,
      });
      return { status: 200, headers: dataSourceHeaders("db"), jsonBody: selectEventImpacts(impacts, platform.value) };
    } catch (err) {
      context.error("ゲーム更新ごとの対応状況の計算に失敗しました:", err);
      return errorResponse(500, "ゲーム更新ごとの対応状況の取得に失敗しました");
    }
  },
});
