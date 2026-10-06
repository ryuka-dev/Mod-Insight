// ============================================================
// costs.js
//
// このシステム自身の運用費用(リソースグループ rg-mod-insight の日別・サービス別の費用)を
// Azure Cost Management から取得し、Blob キャッシュ costs.json に置く。
// ダッシュボードの「運用状況」で GET /api/costs から表示する。
//
// なぜ DB に入れないか:
//   費用の正本は Azure 側にあり、毎回最新の値を取り直せる。
//   こちらで履歴を持つ必要が無いので、表を増やさずキャッシュだけに置く。
//
// 取得のしかた:
//   - Cost Management の Query API(POST {scope}/providers/Microsoft.CostManagement/query)を
//     1 日 1 回、取得ジョブの最後に呼ぶ。Query API の呼び出し自体は無料
//   - 認証は DefaultAzureCredential。Azure 上では Function App のマネージド ID、
//     手元では az login のアカウントでトークンを取る。コードにも設定にも秘密を置かない
//     (マネージド ID に付けるロールは rg-mod-insight に対する Cost Management Reader だけ)
//   - 対象のスコープは環境変数 COST_MANAGEMENT_SCOPE
//     (例: /subscriptions/{サブスクリプション ID}/resourceGroups/rg-mod-insight)。
//     未設定なら何もしない
//
// 集計中の日を捨てる理由:
//   Cost Management の日別の値は、その日が終わってからも 1 日以上増え続ける
//   (docs/ops-log.md 2.7: 09-26 の値が翌日 2.14 円 → 後で 2.57 円)。
//   途中の値を出すと「最後の日だけ急に安い」グラフになるので、
//   取得ジョブの日付の 2 日前までを確定した値として扱う。
//
// 方針: refreshCosts は例外を外に投げない。失敗したらログを出して前回の costs.json を残す。
//   費用の表示は mod データの取得とは関係ないので、ここで取得ジョブを止めない。
// ============================================================

const { DefaultAzureCredential } = require("@azure/identity");
const cache = require("./cache");

const DAY_MS = 24 * 60 * 60 * 1000;

// グラフに出す日数(確定した最後の日を含めて)
const DAYS_TO_KEEP = 90;

// 取得ジョブの日付から何日前までを確定とみなすか(上の「集計中の日を捨てる理由」)
const SETTLED_DAYS_AGO = 2;

const API_VERSION = "2023-11-01";

// 429(呼び出し回数の制限)のときに何回まで試すか
const MAX_ATTEMPTS = 3;

// トークンを取る道具。最初の呼び出しで作り、以降は使い回す
let credential = null;

// "YYYY-MM-DD"(UTC)にする
function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// 取得する期間を決める
// 入力: runAt(取得ジョブの実行日時、ISO 文字列)
// 出力: { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }(両端を含む、UTC の日付)
function queryPeriod(runAt) {
  const runDay = Date.parse(`${runAt.slice(0, 10)}T00:00:00Z`);
  const to = runDay - SETTLED_DAYS_AGO * DAY_MS;
  const from = to - (DAYS_TO_KEEP - 1) * DAY_MS;
  return { from: dateKey(new Date(from)), to: dateKey(new Date(to)) };
}

// 小数第 2 位までに丸める(1 円未満の費用が多いので、整数にはしない)
function round2(value) {
  return Math.round(value * 100) / 100;
}

// Query API の応答(列の定義と行)を、画面で使う形に直す
// 入力: columns([{ name }, ...])、rows([[Cost, UsageDate, ServiceName, Currency], ...] 列の順は columns のとおり)、
//       period(queryPeriod の結果。この範囲外の行は捨てる)
// 出力: {
//         currency: "JPY",
//         services: ["Azure Monitor", "Storage", ...](期間合計の多い順。0 円のサービスも残す),
//         days: [{ date: "YYYY-MM-DD", total, services: { "Azure Monitor": 2.57, ... } }, ...](古い順)
//       }
// 行が 1 つも無い日は作らない(0 円で埋めると「データが無い」と「0 円」の区別がつかなくなる)。
function toDailyCosts(columns, rows, period) {
  const index = {};
  columns.forEach((c, i) => { index[c.name] = i; });
  for (const name of ["Cost", "UsageDate", "ServiceName", "Currency"]) {
    if (!(name in index)) {
      throw new Error(`Cost Management の応答に ${name} 列がありません`);
    }
  }

  let currency = null;
  const byDate = new Map();          // date → { date, services: { name: 費用 } }
  const serviceTotals = new Map();   // サービス名 → 期間合計(並べ替え用)
  for (const row of rows) {
    // UsageDate は 20260924 のような数値で来る
    const raw = String(row[index.UsageDate]);
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    if (date < period.from || date > period.to) {
      continue;
    }
    const service = row[index.ServiceName] || "(不明)";
    const cost = Number(row[index.Cost]);
    currency = currency || row[index.Currency];

    let day = byDate.get(date);
    if (!day) {
      day = { date: date, services: {} };
      byDate.set(date, day);
    }
    day.services[service] = (day.services[service] || 0) + cost;
    serviceTotals.set(service, (serviceTotals.get(service) || 0) + cost);
  }

  const services = Array.from(serviceTotals.keys());
  services.sort((a, b) => serviceTotals.get(b) - serviceTotals.get(a) || (a < b ? -1 : 1));

  const days = Array.from(byDate.values());
  days.sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    currency: currency,
    services: services,
    days: days.map((d) => {
      // 合計は丸める前の値から出す(丸めた値を足すと誤差がたまる)
      const total = Object.values(d.services).reduce((sum, v) => sum + v, 0);
      const rounded = {};
      for (const name of Object.keys(d.services)) {
        rounded[name] = round2(d.services[name]);
      }
      return { date: d.date, total: round2(total), services: rounded };
    }),
  };
}

// 待つ
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Query API を 1 回呼ぶ(429 なら待ってやり直す)
// 入力: url、body(JSON にするもの)、token(アクセストークン)
// 出力: 応答の properties({ columns, rows, nextLink })
async function postQuery(url, body, token) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 429 && attempt < MAX_ATTEMPTS) {
      // 何秒待てばよいかはヘッダーで返ってくる。無ければ 10 秒。長すぎる値は 60 秒で打ち切る
      const seconds = Number(response.headers.get("x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after")
        || response.headers.get("retry-after")) || 10;
      await sleep(Math.min(seconds, 60) * 1000);
      continue;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cost Management Query API が HTTP ${response.status} を返しました: ${text.slice(0, 300)}`);
    }
    const json = await response.json();
    return json.properties;
  }
}

// 指定期間の日別・サービス別の費用を Query API から取る
// 入力: scope(COST_MANAGEMENT_SCOPE)、period(queryPeriod の結果)
// 出力: { columns, rows }(複数ページあればつなげたもの)
async function queryDailyCosts(scope, period) {
  if (!credential) {
    credential = new DefaultAzureCredential();
  }
  const token = (await credential.getToken("https://management.azure.com/.default")).token;

  const body = {
    type: "ActualCost",
    timeframe: "Custom",
    timePeriod: { from: `${period.from}T00:00:00Z`, to: `${period.to}T23:59:59Z` },
    dataset: {
      granularity: "Daily",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping: [{ type: "Dimension", name: "ServiceName" }],
    },
  };

  let url = `https://management.azure.com${scope}/providers/Microsoft.CostManagement/query?api-version=${API_VERSION}`;
  let columns = null;
  const rows = [];
  // 90 日 × 数サービスなら 1 ページに収まるが、行が多い時は nextLink で続きが返る
  while (url) {
    const page = await postQuery(url, body, token);
    columns = columns || page.columns;
    rows.push(...page.rows);
    url = page.nextLink || null;
  }
  return { columns: columns, rows: rows };
}

// 費用を取り直して costs.json を書く。取得ジョブ(fetchJob.js)の最後に呼ぶ
// 入力: runAt(取得ジョブの実行日時、ISO 文字列)、logger
// 出力: なし。失敗してもログを出すだけで、例外は投げない
async function refreshCosts(runAt, logger) {
  const scope = process.env.COST_MANAGEMENT_SCOPE;
  if (!scope) {
    logger.log("COST_MANAGEMENT_SCOPE が未設定のため、運用費用は取得しません");
    return;
  }
  // URL の一部にそのまま入れるので、形が違えば呼ばない(設定ミスで別のホストへ送らないため)
  if (!/^\/subscriptions\/[0-9a-f-]+\/resourceGroups\/[\w.()-]+$/i.test(scope)) {
    logger.error("運用費用の取得に失敗しました: COST_MANAGEMENT_SCOPE の形が /subscriptions/{ID}/resourceGroups/{名前} ではありません");
    return;
  }

  const startedAt = Date.now();
  try {
    const period = queryPeriod(runAt);
    const result = await queryDailyCosts(scope, period);
    const data = toDailyCosts(result.columns, result.rows, period);
    const saved = await cache.save("costs.json", runAt, data, logger);
    if (saved) {
      logger.log(`運用費用を更新しました: ${period.from}〜${period.to}, ${data.days.length} 日分, 所要時間=${Date.now() - startedAt}ms`);
    }
  } catch (err) {
    // 文言はアラート(docs/alerts/alert-fetch-job-health.json)の cost_fetch_failed が探している
    logger.error("運用費用の取得に失敗しました(前回の costs.json をそのまま使います):", err);
  }
}

module.exports = { refreshCosts, queryPeriod, toDailyCosts };
