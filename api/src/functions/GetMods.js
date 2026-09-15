// ============================================================
// GetMods.js
//
// GET /api/mods
// 追跡中の mod 一覧を返す。フロントエンドはまずこれを呼んで、
// 表示する mod を選ぶためのリストを作る。
//
// 応答: 200 [{ mod_id, name, author, platform, external_id, is_deprecated, created_at }, ...]
//       500 { error }(DB に接続できないなど)
// ============================================================

const { app } = require("@azure/functions");
const db = require("../db");
const { errorResponse } = require("../httpUtil");

app.http("GetMods", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "mods",
  handler: async (request, context) => {
    try {
      const mods = await db.listMods();
      return { status: 200, jsonBody: mods };
    } catch (err) {
      context.error("mod 一覧の取得に失敗しました:", err);
      return errorResponse(500, "mod 一覧の取得に失敗しました");
    }
  },
});
