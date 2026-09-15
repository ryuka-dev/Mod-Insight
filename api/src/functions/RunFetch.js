// ============================================================
// RunFetch.js
//
// POST /api/fetch/run
// 取得ジョブをその場で 1 回実行する(デモ・動作確認用)。
// タイマー関数とまったく同じ runFetchJob を呼ぶので、結果も同じ形で DB に残る。
//
// 認証: authLevel "function"
//   Azure Functions 標準のキー認証を使う。呼び出し側は
//   ヘッダー x-functions-key(またはクエリ ?code=)に Function App のキーを付ける。
//   自前でキー比較を書かず、キーの発行・失効を Azure 側の管理画面に任せられる。
//   ローカル実行(func start)ではキーなしで呼べる。
//
// 応答: 200 { run_at, status, error_message, records_fetched }(fetch_logs に書いた内容と同じ)
//       401(キーなし・不一致。Azure 側が自動で返す)
//       500 { error }(ジョブ自体が例外で落ちた場合)
// ============================================================

const { app } = require("@azure/functions");
const { runFetchJob } = require("../fetchJob");
const { errorResponse } = require("../httpUtil");

app.http("RunFetch", {
  methods: ["POST"],
  authLevel: "function",
  route: "fetch/run",
  handler: async (request, context) => {
    try {
      const result = await runFetchJob(context);
      return { status: 200, jsonBody: result };
    } catch (err) {
      context.error("手動実行に失敗しました:", err);
      return errorResponse(500, "取得ジョブの実行に失敗しました");
    }
  },
});
