// ============================================================
// FetchThunderstoreDataTimer.js
//
// Thunderstore のデータを定期的に取得するタイマー関数。
// このファイルは「いつ動かすか」を登録するだけで、
// 実際の処理は fetchJob.js の runFetchJob に任せている。
//
// スケジュール(NCRONTAB 形式、左から 秒 分 時 日 月 曜日):
//   "0 0 15 * * *" = 毎日 15:00 UTC(= 日本時間 0:00)に 1 回実行
//   ※ テスト段階では "0 0 * * * *"(毎時)で動かしていた
//
// 注意: タイマートリガーはローカル実行時にストレージ(Azurite など)が必要。
// ============================================================

const { app } = require("@azure/functions");
const { runFetchJob } = require("../fetchJob");

app.timer("FetchThunderstoreDataTimer", {
  schedule: "0 0 15 * * *",
  handler: async (myTimer, context) => {
    if (myTimer.isPastDue) {
      context.log("前回の実行が遅延していました(isPastDue=true)");
    }
    await runFetchJob(context);
  },
});
