// ============================================================
// GetModVersionSnapshots.js
//
// GET /api/mods/{modId}/version-snapshots?from=YYYY-MM-DD&to=YYYY-MM-DD
// バージョンごとのダウンロード数の時系列を古い順に返す。
// 「新しいバージョンが公開されたあと、利用者がどれくらいの速さで移行したか」を
// 積み上げグラフで見るために使う。
//
// クエリパラメータは GetModSnapshots と同じ(from / to、どちらも省略可)。
// キャッシュの使い方も同じ(mods/{modId}/version-snapshots.json を読んで JS 側で絞る)。
//
// 応答: 200 [{ version_number, release_date, captured_at, download_count }, ...]
//       400 { error }(modId が数値でない、from / to が日付として読めない)
//       404 { error }(その mod_id の mod がない)
//       500 { error }
// ============================================================

const { app } = require("@azure/functions");
const db = require("../db");
const cache = require("../cache");
const { parseModId, parseDateParam, filterByCapturedAt, dataSourceHeaders, errorResponse } = require("../httpUtil");

app.http("GetModVersionSnapshots", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "mods/{modId}/version-snapshots",
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

    const cached = await cache.readForMod(modId, "version-snapshots", context);
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
      const rows = await db.listVersionSnapshots(modId, from.value, to.value);
      return { status: 200, headers: dataSourceHeaders("db"), jsonBody: rows };
    } catch (err) {
      context.error(`mod ${modId} のバージョン別スナップショット取得に失敗しました:`, err);
      return errorResponse(500, "バージョン別スナップショットの取得に失敗しました");
    }
  },
});
