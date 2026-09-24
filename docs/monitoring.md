# 監視(Application Insights)

Mod Insight のバックエンド(Azure Functions)は Application Insights に接続されており、
関数の実行記録・ログ・例外が自動で収集される。このドキュメントは
「何が記録されているか」「どこで見るか」「何が起きたら通知されるか」をまとめたもの。

## 構成

| 項目 | 値 |
|---|---|
| Application Insights リソース | `mod-insight-ryuka`(リソースグループ `rg-mod-insight`) |
| 接続方法 | Function App のアプリケーション設定 `APPLICATIONINSIGHTS_CONNECTION_STRING` |
| 保存先 | Log Analytics ワークスペース(ワークスペースベース、保持期間 90 日) |
| サンプリング | `api/host.json` の `samplingSettings`。リクエスト(関数の実行記録)はサンプリング対象外 |

コード側に監視用の SDK は入れていない。Azure Functions のホストが自動で送る情報だけを使っている。
関数内の `context.log` / `context.error` はそのままトレースとして記録される。

## 記録されているもの

| テーブル | 内容 | 例 |
|---|---|---|
| `requests` | 関数の実行 1 回につき 1 行。関数名、成功/失敗、所要時間 | `GetOverview` が 533 ms で成功 |
| `traces` | ホストのログと関数内の `context.log` | `取得ジョブ終了: platform=thunderstore, status=success, 保存件数=24, 所要時間=1902ms`(プラットフォームごとに 1 行) |
| `exceptions` | 捕捉されなかった例外 | |

関数内のログはカテゴリ `Function.<関数名>.User` で記録される
(`customDimensions.Category` で絞り込める)。

**記録されていないもの**: Node.js の関数からの外部呼び出し(Azure SQL への問い合わせ、Thunderstore / Nexus Mods API への HTTP)は
`dependencies` テーブルに入らない。これを取るには関数内に Application Insights の Node.js SDK を組み込む必要があり、
現段階では入れていない。所要時間は関数全体の値(`requests.duration`)で見る。

## どこで見るか

Azure Portal → リソースグループ `rg-mod-insight` → Application Insights `mod-insight-ryuka` → 左メニュー「ログ」で、
下のクエリ(KQL)をそのまま実行できる。

コマンドラインから見る場合(Azure CLI の `application-insights` 拡張が必要):

```
az monitor app-insights query --app mod-insight-ryuka -g rg-mod-insight --analytics-query "<KQL>"
```

## よく使うクエリ

関数ごとの呼び出し回数・失敗数・平均所要時間(直近 24 時間):

```kusto
requests
| where timestamp > ago(24h)
| summarize calls = count(), failed = countif(success == "False"), avg_ms = round(avg(duration)) by name
| order by calls desc
```

取得ジョブ(タイマー / 手動)の実行履歴:

```kusto
requests
| where name in ("FetchThunderstoreDataTimer", "RunFetch")
| project timestamp, name, success, duration_ms = duration
| order by timestamp desc
```

取得ジョブが自分で出したログ(開始・件数・終了):

```kusto
traces
| where customDimensions.Category in ("Function.FetchThunderstoreDataTimer.User", "Function.RunFetch.User")
| project timestamp, operation_Name, message
| order by timestamp desc
```

失敗したリクエストとその直前のログ:

```kusto
requests
| where success == "False"
| join kind=leftouter (traces | project operation_Id, message, timestamp_trace = timestamp) on operation_Id
| project timestamp, name, resultCode, message
| order by timestamp desc
```

例外の一覧:

```kusto
exceptions
| project timestamp, operation_Name, outerMessage, problemId
| order by timestamp desc
```

## 通知(アラート)

通知先はアクショングループ `ag-mod-insight-email`(Azure アカウントのメールアドレス宛)。
ログ検索アラートのルールはリージョン `eastasia` に置いている(このサブスクリプションのポリシーで作成できるリージョンが限られており、`japaneast` では作成を拒否されたため)。

| 名前 | 種類 | 条件 | 確認間隔 | 意図 |
|---|---|---|---|---|
| `alert-fetch-job-health` | ログ検索 | 下の 3 つの問題のどれかがある(問題ごとに別々に発火・自動解決する) | 1 時間ごと | 取得ジョブまわりの異常をまとめて検知する |
| `alert-api-failures` | メトリック | 5 分間に失敗したリクエストが 5 件を超える | 5 分ごと | REST API の障害(DB に接続できない等)を検知する |
| `alert-sql-free-limit-low` | メトリック | Azure SQL の無料枠の残量(`free_amount_remaining`)の 1 時間の最小値が 20,000 vCore 秒を下回る | 1 時間ごと | 無料枠(月 100,000 vCore 秒)を使い切ると `freeLimitExhaustionBehavior = AutoPause` により**その月の残りずっと DB が止まる**。開発で DB を長く起こした日が続くと現実に起こるため(2026-09-15 は 1 日で 22,000。`docs/ops-log.md` 1.5 節)、残り 20% で先に知らせる。対象リソースは Application Insights ではなく SQL Database 本体 |

### `alert-fetch-job-health` が見ている 3 つの問題

クエリは問題 1 つにつき 1 行(`problem` 列と `detail` 列)を返し、行があれば発火する。`problem` を次元にしているので、
通知には問題の種類が出て、それぞれ独立に発火・解決する。

| `problem` | 条件 | 意図 |
|---|---|---|
| `fetch_missing` | 直近 48 時間に `FetchThunderstoreDataTimer` の成功した実行が 1 件もない | 毎日 15:00 UTC の取得が動いていない(タイマーの停止、アプリの停止、実行エラー)ことを検知する。24 時間ちょうどだと実行タイミングのわずかなずれで誤検知し得るため 48 時間にしている(検知は最大で 1 日遅れる) |
| `fetch_failed` | 直近 1 時間のログに `status=failed` を含む取得ジョブの終了ログがある | 取得ジョブ自体は最後まで動いたが、API 取得か DB 保存に失敗した回を検知する(ジョブは例外を握りつぶして `fetch_logs` に記録する設計なので、`requests` の失敗では捕まらない) |
| `cache_update_failed` | 直近 1 時間のログに `キャッシュの更新に失敗しました` がある | 取得ジョブが DB には保存できたのに Blob キャッシュの作り直しに失敗した回を検知する。`fetch_logs` は success のままなので `fetch_failed` では捕まらず、放置するとダッシュボードが前日のデータを出し続ける(`docs/ops-log.md` 1.8 節) |

ルールの窓は 48 時間(`fetch_missing` に合わせる)で、残り 2 つはクエリの中で `ago(1h)` に絞っている。
こうしないと、1 回の失敗が 48 時間ずっと「発火中」になり続ける。

```kusto
let jobLogs = traces
    | where customDimensions.Category in ('Function.FetchThunderstoreDataTimer.User', 'Function.RunFetch.User');
let lastSuccess = toscalar(requests
    | where name == 'FetchThunderstoreDataTimer' and success == 'True'
    | summarize max(timestamp));
let notRun = print problem = 'fetch_missing', detail = 'no successful scheduled fetch in the last 48 hours'
    | where isnull(lastSuccess);
let jobFailed = jobLogs
    | where timestamp > ago(1h) and message contains 'status=failed'
    | project problem = 'fetch_failed', detail = message;
let cacheFailed = jobLogs
    | where timestamp > ago(1h) and message contains 'キャッシュの更新に失敗'
    | project problem = 'cache_update_failed', detail = message;
union notRun, jobFailed, cacheFailed
```

注意: KQL では `missing` を `let` の変数名に使えない(`let missing = ...` は `BadArgumentError` になる)。

以前は 3 つを別々のログ検索アラートにしていたが、2026-09-24 に 1 本にまとめた(`docs/ops-log.md` 2 章)。

### 費用

2026-09-01〜09-23 の実績(Cost Management)。

| 種類 | 費用 | 備考 |
|---|---|---|
| ログ検索アラート | 1 本あたり 1 日約 2.5 円(月約 75 円) | 発火の有無に関係なく本数 × 時間で課金される。確認間隔 15 分以上は同じ料金区分なので、間隔を延ばしても安くならない |
| メトリックアラート | 0 円 | この 2 本の範囲では課金されていない |

ログ検索アラートを増やす時は、既存の `alert-fetch-job-health` のクエリに `problem` を 1 つ足す形にする(本数を増やさない)。

### アラートを作ったコマンド

後から同じものを作り直せるように残しておく(`$SUB` はサブスクリプション ID、Git Bash では `MSYS_NO_PATHCONV=1` を付ける)。

```
DB="/subscriptions/$SUB/resourceGroups/rg-mod-insight/providers/Microsoft.Sql/servers/sql-mod-insight-ryuka/databases/sqldb-mod-insight"
AI="/subscriptions/$SUB/resourceGroups/rg-mod-insight/providers/microsoft.insights/components/mod-insight-ryuka"
AG="/subscriptions/$SUB/resourceGroups/rg-mod-insight/providers/microsoft.insights/actionGroups/ag-mod-insight-email"

# 無料枠の残量(メトリックアラート。対象は SQL Database)
az monitor metrics alert create -g rg-mod-insight -n alert-sql-free-limit-low --scopes "$DB" \
  --condition "min free_amount_remaining < 20000" --window-size 1h --evaluation-frequency 1h \
  --severity 1 --action "$AG"

# 取得ジョブの健全性(ログ検索アラート。対象は Application Insights)
# 定義は docs/alerts/alert-fetch-job-health.json。{SUBSCRIPTION_ID} を置き換えて REST API で作る
sed "s/{SUBSCRIPTION_ID}/$SUB/g" docs/alerts/alert-fetch-job-health.json > /tmp/rule.json
az rest --method put --body @/tmp/rule.json \
  --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/rg-mod-insight/providers/Microsoft.Insights/scheduledQueryRules/alert-fetch-job-health?api-version=2021-08-01"
```

`alert-fetch-job-health` は `az monitor scheduled-query create` ではなく JSON ファイルで作っている。
クエリが複数行で引用符と日本語を含み、次元の指定もあるため、コマンドライン引数で渡すより定義をファイルにしたほうが確実で、
リポジトリに設定そのものを残せるため。

### SQL Database 側のメトリック

無料枠の消費は Application Insights ではなく SQL Database のメトリックで見る(Portal → SQL Database → メトリック、または下のコマンド)。

| メトリック | 集計 | 意味 |
|---|---|---|
| `free_amount_consumed` | Maximum | 今月使った vCore 秒 |
| `free_amount_remaining` | Minimum | 今月の残り vCore 秒(アラートの対象) |
| `app_cpu_billed` | Total | 期間内に課金された vCore 秒。起きている間は約 1,700 / 時間 |

```
az monitor metrics list --resource "$DB" --metric free_amount_consumed free_amount_remaining \
  --start-time 2026-09-01T00:00:00Z --end-time 2026-10-01T00:00:00Z --interval P1D --aggregation Maximum Minimum -o table
```

`cpu_percent` は一時停止中も 0.0 を返すので、停止しているかどうかの判断には使えない(`az sql db show` の `status` を見る)。

## 既知の制限

- 2026-09-14 23:38 UTC より前の実行(初回のタイマー実行を含む)はテレメトリに残っていない。
  設定変更の記録はなく、原因は特定できていない。それ以降の実行はすべて記録されている。
- `context.log` の日本語は正しく保存されている。Windows のコマンドラインで結果を表示すると文字化けして見えることがあるが、
  Portal で見れば問題ない。
