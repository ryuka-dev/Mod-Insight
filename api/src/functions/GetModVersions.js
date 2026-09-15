// ============================================================
// GetModVersions.js
//
// GET /api/mods/{modId}/versions
// バージョン履歴を新しい順に返す。グラフ上に「この日に v1.2.0 を公開」
// といった印を付けるために使う。
//
// 応答: 200 [{ version_id, version_number, release_date, changelog }, ...]
//       400 { error }(modId が数値でない)
//       404 { error }(その mod_id の mod がない)
//       500 { error }
// ============================================================

const { app } = require("@azure/functions");
const db = require("../db");
const { parseModId, errorResponse } = require("../httpUtil");

app.http("GetModVersions", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "mods/{modId}/versions",
  handler: async (request, context) => {
    const modId = parseModId(request);
    if (modId === null) {
      return errorResponse(400, "modId は正の整数で指定してください");
    }

    try {
      const mod = await db.getModById(modId);
      if (mod === null) {
        return errorResponse(404, "指定された mod は存在しません");
      }
      const versions = await db.listModVersions(modId);
      return { status: 200, jsonBody: versions };
    } catch (err) {
      context.error(`mod ${modId} のバージョン履歴取得に失敗しました:`, err);
      return errorResponse(500, "バージョン履歴の取得に失敗しました");
    }
  },
});
