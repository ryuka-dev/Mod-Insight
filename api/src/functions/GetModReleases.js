// ============================================================
// GetModReleases.js
//
// GET /api/mods/{modId}/releases
// バージョンを公開した前後でダウンロードがどう変わったかを返す(新しい公開が先)。
// 計算は releaseImpact.js。材料はバージョン別の時系列(全期間)なので、
// キャッシュの使い方は GetModVersionSnapshots と同じ(mods/{modId}/version-snapshots.json を読む)。
// 期間(from / to)は受け付けない。公開の前後 7 日を比べるので、表示中の期間で材料を切ると結果が変わってしまうため。
//
// 応答: 200 [{ version_number, release_date, first_day, before: { days, average }, after: { days, average },
//              change, share: [{ date, day, new_version, total, share }, ...] }, ...]
//           記録を始めた後に公開されたバージョンが無ければ []
//       400 { error }(modId が数値でない)
//       404 { error }(その mod_id の mod がない)
//       500 { error }
// ============================================================

const { app } = require("@azure/functions");
const db = require("../db");
const cache = require("../cache");
const { buildReleaseImpact } = require("../releaseImpact");
const { parseModId, dataSourceHeaders, errorResponse } = require("../httpUtil");

app.http("GetModReleases", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "mods/{modId}/releases",
  handler: async (request, context) => {
    const modId = parseModId(request);
    if (modId === null) {
      return errorResponse(400, "modId は正の整数で指定してください");
    }

    const cached = await cache.readForMod(modId, "version-snapshots", context);
    if (cached.status === "not_found") {
      return errorResponse(404, "指定された mod は存在しません");
    }
    if (cached.status === "hit") {
      return {
        status: 200,
        headers: dataSourceHeaders("cache", cached.entry.run_at),
        jsonBody: buildReleaseImpact(cached.entry.data),
      };
    }

    try {
      const mod = await db.getModById(modId);
      if (mod === null) {
        return errorResponse(404, "指定された mod は存在しません");
      }
      const rows = await db.listVersionSnapshots(modId, null, null);
      return { status: 200, headers: dataSourceHeaders("db"), jsonBody: buildReleaseImpact(rows) };
    } catch (err) {
      context.error(`mod ${modId} の公開前後の計算に失敗しました:`, err);
      return errorResponse(500, "公開前後のデータの取得に失敗しました");
    }
  },
});
