// ============================================================
// GetModSnapshots.js
//
// GET /api/mods/{modId}/snapshots?from=YYYY-MM-DD&to=YYYY-MM-DD
// 折れ線グラフ用の時系列データを古い順に返す。
//
// クエリパラメータ(どちらも省略可):
//   from  この日時以降のデータだけ返す(含む)
//   to    この日時以前のデータだけ返す(含む)
//   形式は "2026-09-01" のような日付、または ISO 形式の日時。
//   "2026-09-01" だけを指定した場合は UTC の 0 時として扱われる。
//
// まず Blob キャッシュ(mods/{modId}/snapshots.json、全期間)を読んで JS 側で from / to を絞り、
// 無ければ DB に問い合わせる(こちらは SQL の WHERE で絞る)。
//
// 応答: 200 [{ captured_at, download_count, rating_score }, ...]
//       400 { error }(modId が数値でない、from / to が日付として読めない)
//       404 { error }(その mod_id の mod がない)
//       500 { error }
// ============================================================

const { app } = require("@azure/functions");
const db = require("../db");
const cache = require("../cache");
const { parseModId, parseDateParam, filterByCapturedAt, dataSourceHeaders, errorResponse } = require("../httpUtil");

app.http("GetModSnapshots", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "mods/{modId}/snapshots",
  handler: async (request, context) => {
    const modId = parseModId(request);
    if (modId === null) {
      return errorResponse(400, "modId は正の整数で指定してください");
    }

    const from = parseDateParam(request.query.get("from"));
    const to = parseDateParam(request.query.get("to"));
    if (!from.ok || !to.ok) {
      return errorResponse(400, "from / to は YYYY-MM-DD または ISO 形式の日時で指定してください");
    }
    if (from.value && to.value && from.value > to.value) {
      return errorResponse(400, "from は to より前の日時にしてください");
    }

    const cached = await cache.readForMod(modId, "snapshots", context);
    if (cached.status === "not_found") {
      return errorResponse(404, "指定された mod は存在しません");
    }
    if (cached.status === "hit") {
      return {
        status: 200,
        headers: dataSourceHeaders("cache", cached.entry.run_at),
        jsonBody: filterByCapturedAt(cached.entry.data, from.value, to.value),
      };
    }

    try {
      const mod = await db.getModById(modId);
      if (mod === null) {
        return errorResponse(404, "指定された mod は存在しません");
      }
      const snapshots = await db.listSnapshots(modId, from.value, to.value);
      return { status: 200, headers: dataSourceHeaders("db"), jsonBody: snapshots };
    } catch (err) {
      context.error(`mod ${modId} のスナップショット取得に失敗しました:`, err);
      return errorResponse(500, "スナップショットの取得に失敗しました");
    }
  },
});
