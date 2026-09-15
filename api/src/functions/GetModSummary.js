// ============================================================
// GetModSummary.js
//
// GET /api/mods/{modId}/summary
// 1 つの mod の「今の状態」をまとめて返す(カード表示などに使う)。
//
// 応答: 200 { mod, latest_snapshot, latest_version, version_count }
//           ※ 内容は db.js の getModSummary を参照
//       400 { error }(modId が数値でない)
//       404 { error }(その mod_id の mod がない)
//       500 { error }
// ============================================================

const { app } = require("@azure/functions");
const db = require("../db");
const { parseModId, errorResponse } = require("../httpUtil");

app.http("GetModSummary", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "mods/{modId}/summary",
  handler: async (request, context) => {
    const modId = parseModId(request);
    if (modId === null) {
      return errorResponse(400, "modId は正の整数で指定してください");
    }

    try {
      const summary = await db.getModSummary(modId);
      if (summary === null) {
        return errorResponse(404, "指定された mod は存在しません");
      }
      return { status: 200, jsonBody: summary };
    } catch (err) {
      context.error(`mod ${modId} のサマリー取得に失敗しました:`, err);
      return errorResponse(500, "サマリーの取得に失敗しました");
    }
  },
});
