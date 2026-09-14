// ============================================================
// FetchThunderstoreDataTimer.js
//
// Thunderstore のデータを定期的に取得するタイマー関数。
// このファイルは「いつ動かすか」を登録するだけで、
// 実際の処理は fetchJob.js の runFetchJob に任せている。
//
// スケジュール(NCRONTAB 形式、左から 秒 分 時 日 月 曜日):
//   "0 0 * * * *"  = 毎時 0 分 0 秒に実行(テスト用)
//   本番では "0 0 0 * * *"(毎日 0:00 UTC)に変更する予定
//
// 注意: タイマートリガーはローカル実行時にストレージ(Azurite など)が必要。
// ============================================================

const { app } = require("@azure/functions");
const { runFetchJob } = require("../fetchJob");

app.timer("FetchThunderstoreDataTimer", {
  schedule: "0 0 * * * *",
  handler: async (myTimer, context) => {
    if (myTimer.isPastDue) {
      context.log("前回の実行が遅延していました(isPastDue=true)");
    }
    await runFetchJob(context);
  },
});
