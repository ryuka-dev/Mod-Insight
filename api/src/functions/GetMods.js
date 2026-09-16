// ============================================================
// GetMods.js
//
// GET /api/mods
// 追跡中の mod 一覧を返す。フロントエンドはまずこれを呼んで、
// 表示する mod を選ぶためのリストを作る。
//
// まず Blob キャッシュ(cache.js の mods.json)を読み、無ければ DB に問い合わせる。
//
// 応答: 200 [{ mod_id, name, author, platform, external_id, is_deprecated, created_at }, ...]
//       500 { error }(キャッシュが無く、DB にも接続できないなど)
// ============================================================

const { app } = require("@azure/functions");
const db = require("../db");
const cache = require("../cache");
const { dataSourceHeaders, errorResponse } = require("../httpUtil");

app.http("GetMods", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "mods",
  handler: async (request, context) => {
    const cached = await cache.read("mods.json", context);
    if (cached) {
      return { status: 200, headers: dataSourceHeaders("cache", cached.run_at), jsonBody: cached.data };
    }

    try {
      const mods = await db.listMods();
      return { status: 200, headers: dataSourceHeaders("db"), jsonBody: mods };
    } catch (err) {
      context.error("mod 一覧の取得に失敗しました:", err);
      return errorResponse(500, "mod 一覧の取得に失敗しました");
    }
  },
});
