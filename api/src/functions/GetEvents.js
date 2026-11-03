// ============================================================
// GetEvents.js
//
// GET /api/events
// 外部の出来事(ゲーム本体のお知らせ、手入力のメモ)を古い順に返す。
// ダッシュボードのグラフに「この日にゲームのパッチが出た」といった印を付けるために使う。
// 出来事は 1 か月に数件ずつしか増えないので、期間などの絞り込みはせず全件返す。
//
// まず Blob キャッシュ(events.json)を読み、無ければ DB に問い合わせる。
//
// 応答: 200 [{ event_id, occurred_at, kind, title, url, source, mod_id }, ...]
//           kind は 'game_major' / 'game_patch' / 'game_news' / 'note'(sql/004_create_events.sql)
//           mod_id はゲーム全体の出来事なら null
//       500 { error }
// ============================================================

const { app } = require("@azure/functions");
const db = require("../db");
const cache = require("../cache");
const { dataSourceHeaders, errorResponse } = require("../httpUtil");

app.http("GetEvents", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "events",
  handler: async (request, context) => {
    const cached = await cache.read("events.json", context);
    if (cached) {
      return { status: 200, headers: dataSourceHeaders("cache", cached.run_at), jsonBody: cached.data };
    }

    try {
      const events = await db.listEvents();
      return { status: 200, headers: dataSourceHeaders("db"), jsonBody: events };
    } catch (err) {
      context.error("出来事の一覧の取得に失敗しました:", err);
      return errorResponse(500, "出来事の一覧の取得に失敗しました");
    }
  },
});
