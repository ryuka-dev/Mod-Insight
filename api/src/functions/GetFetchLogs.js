// ============================================================
// GetFetchLogs.js
//
// GET /api/fetch/logs?limit=N
// 取得ジョブの実行記録を新しい順に返す(監視・デモ用)。
// 1 回の実行につきプラットフォームごとに 1 行ある(run_at が同じで platform が違う)。
//
// クエリパラメータ:
//   limit  返す最大件数。省略時 30、最大 200。
//
// 応答: 200 [{ log_id, run_at, platform, status, error_message, records_fetched }, ...]
//       400 { error }(limit が 1〜200 の整数でない)
//       500 { error }
// ============================================================

const { app } = require("@azure/functions");
const db = require("../db");
const { errorResponse } = require("../httpUtil");

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;

app.http("GetFetchLogs", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "fetch/logs",
  handler: async (request, context) => {
    const rawLimit = request.query.get("limit");
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== null && rawLimit !== "") {
      if (!/^[0-9]+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_LIMIT) {
        return errorResponse(400, `limit は 1〜${MAX_LIMIT} の整数で指定してください`);
      }
      limit = Number(rawLimit);
    }

    try {
      const logs = await db.listFetchLogs(limit);
      return { status: 200, jsonBody: logs };
    } catch (err) {
      context.error("実行記録の取得に失敗しました:", err);
      return errorResponse(500, "実行記録の取得に失敗しました");
    }
  },
});
