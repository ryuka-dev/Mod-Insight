// ============================================================
// GetCosts.js
//
// GET /api/costs
// このシステム自身の運用費用(リソースグループの日別・サービス別の費用)を返す。
// ダッシュボードの「運用状況」で使う。
//
// 値は取得ジョブが毎日 costs.js で Cost Management から取って Blob キャッシュ(costs.json)に置いたもの。
// 費用は DB に入れていないので、ほかの GET API と違って DB へのフォールバックは無い。
//
// 応答: 200 { fetched_at, currency, services: [...], days: [{ date, total, services: { 名前: 費用 } }, ...] }
//           fetched_at は Cost Management から取った日時。days は確定した日だけ(古い順)
//       404 { error }(まだ一度も取得していない、またはキャッシュが読めない)
// ============================================================

const { app } = require("@azure/functions");
const cache = require("../cache");
const { dataSourceHeaders, errorResponse } = require("../httpUtil");

app.http("GetCosts", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "costs",
  handler: async (request, context) => {
    const cached = await cache.read("costs.json", context);
    if (!cached) {
      return errorResponse(404, "運用費用のデータはまだありません");
    }
    return {
      status: 200,
      headers: dataSourceHeaders("cache", cached.run_at),
      jsonBody: { fetched_at: cached.generated_at, ...cached.data },
    };
  },
});
