// ============================================================
// GetOverview.js
//
// GET /api/overview?from=YYYY-MM-DD&platform=thunderstore
// 全 mod をまとめて見る一覧画面用のデータを 1 回の呼び出しで返す。
// (mod ごとに summary を 24 回呼ぶのではなく、SQL 側で 1 回にまとめる)
// まず Blob キャッシュ(overview.json = 全期間・全プラットフォームの材料)を読んで
// cache.buildOverview で from / platform を絞り、無ければ DB(db.getOverview)に問い合わせる。
// どちらも同じ { mods, totals } の形になるので、その後の合計の計算は共通。
// 日ごとの増加(daily)は mod ごとの履歴から dailyIncrease.js で計算する。履歴はキャッシュなら
// overview.json の history、DB なら db.listSnapshotHistory() から取る。
//
// クエリパラメータ:
//   from      期間の開始(省略可)。「期間内の増加」の起点になる
//   platform  'thunderstore' / 'nexusmods'(省略可)。省略時は全プラットフォームの合計
//
// 応答: 200 {
//   total_downloads:  全 mod の最新ダウンロード数の合計
//   total_delta:      全 mod の「最新 − 期間開始時点」の合計(比較できる mod だけ)
//   mod_count:        mod の数
//   latest_captured_at: 一番新しい取得日時
//   mods: [{ mod_id, name, platform, captured_at, latest_download_count, rating_score,
//            start_download_count, delta, latest_version, latest_release_date }, ...]  ※ ダウンロード数の多い順
//   totals: [{ captured_at, download_count, mod_count }, ...]  ※ 取得回ごとの合計の推移(古い順)
//   daily:  [{ date, increase, mod_count, average_7d }, ...]  ※ 日ごとの増加(古い順。dailyIncrease.js 参照)
// }
//       400 { error }(from が日付として読めない、platform が知らない値)
//       500 { error }
// ============================================================

const { app } = require("@azure/functions");
const db = require("../db");
const cache = require("../cache");
const { buildDailyIncrease } = require("../dailyIncrease");
const { parseDateParam, parsePlatformParam, dataSourceHeaders, errorResponse } = require("../httpUtil");

app.http("GetOverview", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "overview",
  handler: async (request, context) => {
    const from = parseDateParam(request.query.get("from"));
    if (!from.ok) {
      return errorResponse(400, "from は YYYY-MM-DD または ISO 形式の日時で指定してください");
    }

    const platform = parsePlatformParam(request.query.get("platform"));
    if (!platform.ok) {
      return errorResponse(400, "platform は thunderstore または nexusmods で指定してください");
    }

    try {
      let overview;
      let history;
      let headers;
      const cached = await cache.read("overview.json", context);
      if (cached) {
        overview = cache.buildOverview(cached.data, from.value, platform.value);
        history = cached.data.history;
        headers = dataSourceHeaders("cache", cached.run_at);
      } else {
        overview = await db.getOverview(from.value, platform.value);
        history = await db.listSnapshotHistory();
        headers = dataSourceHeaders("db");
      }

      // 合計値はここで計算する(SQL で書くこともできるが、JS のほうが読みやすい)
      let totalDownloads = 0;
      let totalDelta = 0;
      let latestCapturedAt = null;
      for (const mod of overview.mods) {
        if (mod.latest_download_count !== null) {
          totalDownloads += mod.latest_download_count;
        }
        // 期間開始時点の値がある mod だけ増加分を計算する(まだ 1 回しか取得していない mod は null)
        if (mod.latest_download_count !== null && mod.start_download_count !== null) {
          mod.delta = mod.latest_download_count - mod.start_download_count;
          totalDelta += mod.delta;
        } else {
          mod.delta = null;
        }
        if (mod.captured_at && (latestCapturedAt === null || mod.captured_at > latestCapturedAt)) {
          latestCapturedAt = mod.captured_at;
        }
      }

      return {
        status: 200,
        headers: headers,
        jsonBody: {
          total_downloads: totalDownloads,
          total_delta: totalDelta,
          mod_count: overview.mods.length,
          latest_captured_at: latestCapturedAt,
          mods: overview.mods,
          totals: overview.totals,
          daily: buildDailyIncrease(history, from.value, platform.value),
        },
      };
    } catch (err) {
      context.error("一覧データの取得に失敗しました:", err);
      return errorResponse(500, "一覧データの取得に失敗しました");
    }
  },
});
