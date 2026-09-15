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
| `traces` | ホストのログと関数内の `context.log` | `取得ジョブ終了: status=success, 保存件数=24, 所要時間=1902ms` |
| `exceptions` | 捕捉されなかった例外 | |

関数内のログはカテゴリ `Function.<関数名>.User` で記録される
(`customDimensions.Category` で絞り込める)。

**記録されていないもの**: Node.js の関数からの外部呼び出し(Azure SQL への問い合わせ、Thunderstore API への HTTP)は
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

| 名前 | 条件 | 確認間隔 | 意図 |
|---|---|---|---|
| `alert-fetch-job-missing` | 直近 48 時間に `FetchThunderstoreDataTimer` の成功した実行が 1 件もない | 1 時間ごと | 毎日 15:00 UTC の取得が動いていない(タイマーの停止、アプリの停止、実行エラー)ことを検知する。ログ検索アラートの窓は 24 時間か 48 時間しか選べず、24 時間ちょうどだと実行タイミングのわずかなずれで誤検知し得るため 48 時間にしている(検知は最大で 1 日遅れる) |
| `alert-fetch-job-failed` | 直近 1 時間のログに `status=failed` を含む取得ジョブの終了ログがある | 1 時間ごと | 取得ジョブ自体は最後まで動いたが、API 取得か DB 保存に失敗した回を検知する(ジョブは例外を握りつぶして `fetch_logs` に記録する設計なので、`requests` の失敗では捕まらない) |
| `alert-api-failures` | 5 分間に失敗したリクエストが 5 件を超える | 5 分ごと | REST API の障害(DB に接続できない等)を検知する |

費用の目安: ログ検索アラートは 1 ルールあたり月 1 ドル未満、メトリックアラートは月 0.1 ドル程度。

## 既知の制限

- 2026-09-14 23:38 UTC より前の実行(初回のタイマー実行を含む)はテレメトリに残っていない。
  設定変更の記録はなく、原因は特定できていない。それ以降の実行はすべて記録されている。
- `context.log` の日本語は正しく保存されている。Windows のコマンドラインで結果を表示すると文字化けして見えることがあるが、
  Portal で見れば問題ない。
