// ============================================================
// GetModSummary.js
//
// GET /api/mods/{modId}/summary
// 1 つの mod の「今の状態」をまとめて返す(カード表示などに使う)。
//
// まず Blob キャッシュ(mods/{modId}/summary.json)を読み、無ければ DB に問い合わせる。
//
// 応答: 200 { mod, latest_snapshot, latest_version, version_count }
//           ※ 内容は db.js の getModSummary を参照
//       400 { error }(modId が数値でない)
//       404 { error }(その mod_id の mod がない)
//       500 { error }
// ============================================================

const { app } = require("@azure/functions");
const db = require("../db");
const cache = require("../cache");
const { parseModId, dataSourceHeaders, errorResponse } = require("../httpUtil");

app.http("GetModSummary", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "mods/{modId}/summary",
  handler: async (request, context) => {
    const modId = parseModId(request);
    if (modId === null) {
      return errorResponse(400, "modId は正の整数で指定してください");
    }

    const cached = await cache.readForMod(modId, "summary", context);
    if (cached.status === "not_found") {
      return errorResponse(404, "指定された mod は存在しません");
    }
    if (cached.status === "hit") {
      return { status: 200, headers: dataSourceHeaders("cache", cached.entry.run_at), jsonBody: cached.entry.data };
    }

    try {
      const summary = await db.getModSummary(modId);
      if (summary === null) {
        return errorResponse(404, "指定された mod は存在しません");
      }
      return { status: 200, headers: dataSourceHeaders("db"), jsonBody: summary };
    } catch (err) {
      context.error(`mod ${modId} のサマリー取得に失敗しました:`, err);
      return errorResponse(500, "サマリーの取得に失敗しました");
    }
  },
});
