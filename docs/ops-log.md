# 運用記録

本番環境で起きた問題を、調査の手順と実測値つきで残すためのファイル。
「何が起きたか → どう調べたか → 何が原因だったか → 何を決めたか」の順に書く。
対策を入れた後は、同じ問題の項目に「対策と効果」を追記する。

時刻はすべて UTC。日本時間は +9 時間(UTC 00:15 = JST 09:15)。

---

## 1. その日はじめてのアクセスに約 50 秒かかる(2026-09-16)

### 1.1 現象

- ダッシュボード(https://www.ryuka.cloud)をその日はじめて開くと、画面に何も出ないまま約 50 秒待たされる。
- 2 回目以降の表示は 1 秒以内。
- エラーは出ない。ブラウザの開発者ツールで見ると、最初の `GET /api/mods` が 200 を返すまでに 50 秒近くかかっている。

### 1.2 調査

#### (1) どのリクエストが遅いか

Application Insights の `requests` テーブルで、所要時間が 5 秒を超えたリクエストを探した。

```kusto
requests
| where timestamp > ago(7d)
| where duration > 5000
| project timestamp, name, resultCode, duration_ms = round(duration)
| order by timestamp asc
```

| timestamp (UTC) | name | resultCode | duration |
|---|---|---|---|
| 2026-09-16 00:15:14 | `GetMods` | 200 | 47,709 ms |

遅いのは `GetMods` 1 本だけで、結果は 200(成功)。失敗ではなく「待っている」。

`web/app.js` は起動時にまず `/api/mods` を取り、その結果を使って残りの API を呼ぶ。
そのため最初の 1 本が終わるまで画面には何も出ず、後続の API は「復帰済み」の状態で走る。

#### (2) 関数の中のどこで待っているか

同じ時間帯の `traces` を時系列に並べた。

```kusto
traces
| where timestamp between (datetime(2026-09-16T00:15:00Z) .. datetime(2026-09-16T00:16:30Z))
| project timestamp, operation_Name, category = tostring(customDimensions.Category), message
| order by timestamp asc
```

| timestamp (UTC) | 出どころ | 内容 |
|---|---|---|
| 00:15:15.317 | `Host.Startup` | `Initializing Host` |
| 00:15:15.345 | `Host.Startup` | `Host initialized (22ms)` |
| 00:15:15.350 | `Function.GetMods` | `Executing 'Functions.GetMods'` |
| (46.9 秒の空白) | | |
| 00:16:02.427 | `Host.Function.Console` | `Azure SQL Database に接続しました`(`api/src/db.js` が出すログ) |
| 00:16:02.577 | `Function.GetMods` | `Executed 'Functions.GetMods' (Succeeded)` |

- Function App のホスト起動(コールドスタート)は 22 ms。ここは原因ではない。
- 空白の 46.9 秒は「関数が始まってから DB 接続が確立するまで」= `db.js` の `pool.connect()` の中。
- 接続が確立してからクエリと応答までは 0.15 秒。

#### (3) データベース側で何が起きていたか

DB の状態と設定を確認した。

```
az sql db show -g rg-mod-insight -s sql-mod-insight-ryuka -n sqldb-mod-insight \
  --query "{status:status,pausedDate:pausedDate,resumedDate:resumedDate,autoPause:autoPauseDelay,minCapacity:minCapacity,sku:currentServiceObjectiveName,useFreeLimit:useFreeLimit,exhaustion:freeLimitExhaustionBehavior}"
```

| 項目 | 値 |
|---|---|
| `sku` | `GP_S_Gen5_2`(General Purpose **サーバーレス**、最大 2 vCore) |
| `minCapacity` | 0.5 vCore |
| `autoPauseDelay` | 60(分) |
| `useFreeLimit` | true(無料枠を使う) |
| `freeLimitExhaustionBehavior` | `AutoPause`(無料枠を使い切ると一時停止) |
| `resumedDate` | `2026-09-16T00:15:58Z` |

`resumedDate` が遅かったリクエストの時刻と一致した。
さらに DB の Azure 活動ログで、一時停止と復帰の操作を時刻つきで取り出した。

```
SUB=$(az account show --query id -o tsv)
RID="/subscriptions/$SUB/resourceGroups/rg-mod-insight/providers/Microsoft.Sql/servers/sql-mod-insight-ryuka/databases/sqldb-mod-insight"
az monitor activity-log list --resource-id "$RID" --start-time 2026-09-15T22:00:00Z \
  --query "[?contains(operationName.value,'pause') || contains(operationName.value,'resume')].{t:eventTimestamp,op:operationName.value,status:status.value}" -o table
```

| 時刻 (UTC) | 操作 | 状態 |
|---|---|---|
| 2026-09-15 22:45:17 | resume | Started |
| 2026-09-15 22:46:17 | resume | Succeeded |
| 2026-09-15 23:02:51 | pause | Started |
| 2026-09-15 23:03:21 | pause | Succeeded |
| 2026-09-15 23:20:17 | resume | Started |
| 2026-09-15 23:20:47 | resume | Succeeded |
| 2026-09-15 23:36:49 | pause | Started / Succeeded |
| 2026-09-15 23:39:09 | resume | Started |
| 2026-09-15 23:40:09 | resume | Succeeded |
| 2026-09-15 23:57:48 | pause | Started |
| 2026-09-15 23:58:18 | pause | Succeeded |
| 2026-09-16 00:15:18 | resume | Started |
| 2026-09-16 00:16:18 | resume | Succeeded |
| 2026-09-16 00:38:49 | pause | Started |
| 2026-09-16 00:39:19 | pause | Succeeded |

遅かったリクエスト(00:15:14 開始)の 4 秒後に `resume` が始まり、接続が確立した 00:16:02 は `resume` の開始から 44 秒後。
時間はすべて「一時停止中の DB が起き上がるのを待っていた時間」で説明がつく。

同じ日にあと 2 回、52,775 ms(23:19:51 開始)と 52,920 ms(23:39:02 開始)を計測している。
この 2 回は Application Insights の `requests` に残っていない(手元で計測した値)が、
上の表の `resume` 開始時刻 23:20:17 / 23:39:09 と対応している。

#### (4) 復帰した後の速さ

DB が起きた直後(00:16:03〜00:16:05)に続けて呼ばれた API と、その 10 秒後の 2 回目の画面読み込み(00:16:12)の所要時間。

| API | 復帰直後 | 2 回目の読み込み |
|---|---|---|
| `GetMods` | 47,709 ms | 14 ms |
| `GetOverview` | 405 ms | 21 ms |
| `GetFetchLogs` | 509 ms | 184 ms |
| `GetModSnapshots` | 613 ms | 18 ms |
| `GetModVersionSnapshots` | 606 ms | 289 ms |
| `GetModSummary` | 199 ms | 290 ms |
| `GetModVersions` | 198 ms | 191 ms |

DB が起きてさえいれば、どの API も 1 秒未満。遅いのは「その日最初の 1 本」だけ。

#### (5) ついでに分かったこと: 一時停止までの実際の間隔

設定上の `autoPauseDelay` は 60 分だが、活動ログでは `resume` から `pause` までが 16〜23 分だった
(22:46 → 23:02、23:20 → 23:36、23:40 → 23:57、00:16 → 00:38)。
理由は未確認。ここでは「設定値より早く止まることがある」という観測事実だけ残す。

### 1.3 根因

**Azure SQL Database(サーバーレス)の自動一時停止。**

- サーバーレスの DB は、一定時間アクセスがないと自動で一時停止し、次の接続要求で復帰する。復帰には約 1 分かかる。
- 1 日 1 回の取得ジョブ以外は人がアクセスした時しか DB を使わないので、ほぼ毎回「最初のアクセス = 復帰待ち」になる。
- `api/src/db.js` の接続プールは、復帰が終わるまで `pool.connect()` の中で待ち続け、その間 HTTP 応答も返らない。
- Function App のコールドスタート(22 ms)は関係ない。

### 1.4 誤解しやすい点

- **強制再読み込みで「直った」ように見える**: 待っている間にリロードすると速く表示されることがあるが、それは最初のリクエストが DB を起こし終えたタイミングにたまたま重なっただけ。リロード自体には効果がない。
- **「Connection Timeout=30」との関係**: 接続文字列には 30 秒のタイムアウトが入っているが、実測は 47〜53 秒。「1 回目の接続が 30 秒でタイムアウトし、mssql のプールが再試行して 2 回目で成功している」と考えると辻褄が合うが、ログには再試行の記録がないので推測にとどめる。確かめるには `db.js` に接続の試行ごとのログを足す必要がある。
- **`cpu_percent` メトリックでは一時停止が見えない**: 一時停止中も 0.0 が返るので、「CPU が 0 = 止まっている」とは判断できない。一時停止の有無は `az sql db show` の `status` / `pausedDate` / `resumedDate` か、活動ログの `pause` / `resume` で見る。
- **Function App の遅さではない**: ホスト起動は 22 ms。Flex Consumption のコールドスタートを疑って設定をいじっても解決しない。

### 1.5 却下した案

#### 定期的に DB に ping して起こしておく(却下)

タイマー関数で数十分おきに軽いクエリを投げ、一時停止させない案。手軽だが、この構成では成立しない。

- この DB は **無料枠(useFreeLimit)** で動いている。無料枠は **1 か月あたり 100,000 vCore 秒** の計算量。
- 起きている間にどれだけ消費するかは、`app_cpu_billed`(課金対象の vCore 秒)メトリックで実測できる。

```
az monitor metrics list --resource "$RID" --metric app_cpu_billed \
  --start-time 2026-09-15T20:00:00Z --end-time 2026-09-16T02:00:00Z --interval PT1H --aggregation Total \
  --query "value[0].timeseries[0].data[].{t:timeStamp,total:total}" -o table
```

| 時間帯 (UTC) | 課金 vCore 秒 | 備考 |
|---|---|---|
| 2026-09-15 22:00 | 524 | 途中から起動 |
| 2026-09-15 23:00 | 1,668 | ほぼ 1 時間起きていた |
| 2026-09-16 00:00 | 974 | 途中で一時停止 |

- 起きているだけで **約 1,700 vCore 秒 / 時間**(minCapacity 0.5 vCore の分が常に課金される)。
  100,000 ÷ 1,700 ≒ **1 か月に約 60 時間**しか起きていられない。1 日あたり約 2 時間。
- ping で 24 時間起こし続けると、無料枠は **2.5 日で尽きる**。
- 尽きた後の動作は `freeLimitExhaustionBehavior = AutoPause`、つまり **その月の残りはずっと一時停止 = サイト全体が停止**。
  (もう一方の選択肢 `BillOverUsage` は超過分を Azure for Students の残高から払うことになる)
- 実際の消費量は `free_amount_consumed` / `free_amount_remaining` で確認できる。
  2026-09-16 時点で消費 20,218 / 残り 79,782(開発と検証で 2 日使った分)。

```
az monitor metrics list --resource "$RID" --metric free_amount_consumed free_amount_remaining \
  --start-time 2026-09-01T00:00:00Z --end-time 2026-09-17T00:00:00Z --interval P1D --aggregation Maximum Minimum -o table
```

結論: 自動一時停止は「不便な仕様」ではなく、**この DB を無料で動かし続けるために必要な仕組み**。止めてはいけない。

#### そのほか

- `autoPauseDelay` を無効化(-1)する: ping と同じ理由で却下。
- 有料の固定サイズ(Basic / S0 など)に変える: 自動一時停止はなくなるが、学生クレジットを毎月消費する。作品の運用期間を考えると割に合わない。
- フロントエンドに「初回は時間がかかります」と表示する: 原因を放置しているだけなので、単独の対策としては却下。

### 1.6 決定

**読み取り経路を DB から切り離す。** 取得ジョブが 1 日 1 回データを書いた直後に、GET API が返す JSON をそのまま Blob Storage に置き、
API は Blob を返す。データは 1 日 1 回しか変わらないので、それ以外の時間に DB を起こす理由がない。

- DB が起きるのは取得ジョブの時だけ(1 日 1 回、数分)になり、無料枠の消費も減る。
- Blob を読めなかった時だけ DB に落ちる(fall back)ようにして、キャッシュが壊れても表示できなくならないようにする。
- 実装と「対策後の数字」は、キャッシュを入れた後にこの項目の続きとして追記する。

### 1.7 対策(2026-09-16 実施)

読み取り経路を DB から切り離した。実装の詳細は README「読み取りの流れ」と `api/src/cache.js` の冒頭コメントにある。要点だけ書く。

- 取得ジョブ(タイマー / `POST /api/fetch/run`)が保存を終えた直後に、GET API 7 本が返す JSON をすべて Blob Storage(コンテナー `api-cache`)に書き直す。この時 DB は起きているので追加の待ち時間は無い
- GET API はまず Blob を読む。無い時・読めない時だけ従来どおり DB に問い合わせる。応答ヘッダー `x-data-source`(`cache` / `db`)と `x-data-run-at`(そのデータを作った取得ジョブの実行日時)で経路が分かる
- `from` / `to` / `platform` は全期間の Blob を読んだ後に JS で絞る。期間ごとに Blob を分けない
- 存在しない mod_id は `mods.json` で判定して 404 を返す(DB を起こさない)
- Blob の書き込み失敗は取得ジョブの結果(`fetch_logs`)を変えない。API は DB に戻るだけ
- 設定 `CACHE_STORAGE_CONNECTION_STRING`(Function App と同じストレージアカウント)。未設定なら従来どおりの動き

**検討して見送ったこと: 取得ジョブの後に DB を手動で一時停止する。**
管理 API(`POST .../databases/{db}/pause`)を呼ぶと `FeatureDisabledOnSelectedEdition` が返る。
General Purpose のサーバーレスは自動一時停止のみで、手動の pause / resume は使えない(Azure CLI にも `az sql db pause` は無い。`az sql dw pause` はデータウェアハウス用)。
活動ログに出る pause / resume はすべてプラットフォームが起こした操作。したがって DB の起動時間を縮める手段は「起こす回数を減らす」しかなく、それは上の対策で達成している。

### 1.8 効果(2026-09-16 計測)

**手順**

1. DB が一時停止していることを確認する(`az sql db show` → `status = Paused`、`pausedDate = 2026-09-16T01:42:25Z`)
2. ダッシュボードが起動時と mod 切り替え時に呼ぶ URL 13 本を、DB を起こさないまま順番に呼ぶ(`curl`、東京の学内ネットワークから。関数のコールドスタート込み)
3. DB の状態をもう一度確認する

**結果**

| URL | HTTP | 所要時間 | 経路 |
|---|---|---|---|
| `/api/mods` | 200 | 0.34 s | cache |
| `/api/overview?from=…` | 200 | 0.37 s | cache |
| `/api/mods/1/summary` | 200 | 0.30 s | cache |
| `/api/mods/1/snapshots?from=…` | 200 | 3.16 s | cache |
| `/api/mods/1/versions` | 200 | 0.27 s | cache |
| `/api/mods/1/version-snapshots?from=…` | 200 | 0.28 s | cache |
| `/api/fetch/logs?limit=10` | 200 | 0.26 s | cache |
| `/api/overview?platform=nexusmods&from=…` | 200 | 0.31 s | cache |
| `/api/mods/25/summary` | 200 | 0.32 s | cache |
| `/api/mods/25/snapshots?from=…` | 200 | 0.25 s | cache |
| `/api/mods/25/versions` | 200 | 0.27 s | cache |
| `/api/mods/25/version-snapshots?from=…` | 200 | 0.41 s | cache |
| `/api/mods/999999/summary` | 404 | 0.29 s | (mods.json で判定) |

- 13 本すべて `x-data-source: cache`、`x-data-run-at = 2026-09-16T01:25:39Z`(直前の手動実行の回)
- 計測の前後で DB は `Paused` のまま、`pausedDate` も変わらず。**DB を一度も起こしていない**
- 3.16 s の 1 本は Function App の新しいインスタンスが立ち上がった分と推測している(直後の同種の URL は 0.25 s)。DB は停止したままなので DB の待ちではない

**対策前との比較(その日はじめてのアクセスの `GET /api/mods`)**

| | 所要時間 | 備考 |
|---|---|---|
| 対策前 | 47.7 s / 52.8 s / 52.9 s(1.2 節)、52.9 s(2026-09-16 00:58 UTC、デプロイ前の最後の例) | DB の復帰待ち |
| 対策後 | 0.34 s | DB は停止したまま |

**取得ジョブ側の変化**

- `POST /api/fetch/run` は 16.5 s(Application Insights の `requests`)。2 プラットフォームの取得・保存に加えてキャッシュの作り直し(Blob 203 個 = 50 mod × 4 + 3)を含む
- DB を起こすのはこの取得ジョブだけになった(1 日 1 回)。1.5 節の試算では 1 回あたり 16〜60 分の起動なので、月 15,000〜51,000 vCore 秒。無料枠 100,000 の中に収まる

**残っている課題**

- 取得ジョブが DB には保存できたのに Blob の書き込みだけ失敗すると、キャッシュは前回のまま(古いデータ)になる。`fetch_logs` は success なので既存のアラートでは気づけない。ログ `キャッシュの更新に失敗しました` を条件にしたアラートを足すのが次の手
- Function App のコールドスタート(数秒)は残る。DB の 50 秒とは桁が違うので今は対策しない
- 無料枠の残量(`free_amount_remaining`)を監視するアラートが無い。開発で DB を長く起こした日に備えて追加したい

---

## 2. 費用のほとんどが監視(ログ検索アラート)だった(2026-09-24)

### 2.1 現象

Azure Portal の費用表示で、サービス別の最大が Azure Monitor(約 63 円)だった。
SQL Database と Functions はどちらも 0 円で、アプリ本体ではなく監視に費用がかかっていた。

### 2.2 調査

Cost Management の Query API で、2026-09-01〜09-23 の実績を「サービス / メーター / リソース」単位で集計した。

```
az rest --method post --body @query.json \
  --url "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.CostManagement/query?api-version=2023-11-01"
```

(`query.json` は `type: ActualCost`、期間指定、`grouping` に `ServiceName` / `Meter` / `ResourceId`)

| リソース | メーター | 費用 |
|---|---|---:|
| `alert-fetch-job-missing` | Alerts System Log Monitored at 15 Minute Frequency | 22.06 円 |
| `alert-fetch-job-failed` | 同上 | 22.06 円 |
| `alert-cache-update-failed`(1 日遅れて作成) | 同上 | 19.17 円 |
| ストレージアカウント | Hot Read Operations ほか | 5.33 円 |
| Log Analytics | Analytics Logs Data Ingestion | 0.47 円 |
| SQL Database / Functions / メトリックアラート 2 本 | (無料枠) | 0 円 |

日別に見ると、Azure Monitor は 3 本そろった 09-16 以降、毎日 7〜7.7 円で一定だった。

### 2.3 原因

ログ検索アラートは、発火したかどうかに関係なく「ルールの本数 × 時間」で課金される。1 本あたり 1 日約 2.5 円(月約 75 円)。
3 本で月約 225 円になり、このシステムの費用のほとんどを占めていた。

- 3 本とも確認間隔は 1 時間だが、メーター名は「15 Minute Frequency」。15 分以上の間隔は同じ料金区分なので、**間隔を延ばしても安くならない**
- メトリックアラート(`alert-api-failures`、`alert-sql-free-limit-low`)は課金されていない

### 2.4 検討した案

| 案 | 月の費用(アラート) | 監視の範囲 | 判断 |
|---|---:|---|---|
| そのまま | 約 225 円 | 変わらない | 学生向けの無料クレジット(年 100 ドル)で払える額だが、「通知を送る仕組み」だけに月の予算の約 2 割を使うことになる |
| 3 本を 1 本のクエリにまとめる | 約 75 円 | 変わらない | **採用** |
| キャッシュ更新失敗のアラートを消す | 約 150 円 | 狭くなる | キャッシュが壊れても API は DB に戻るので止まりはしないが、ダッシュボードが前日のデータを出し続けるのに気づけなくなる |
| 確認間隔を延ばす | 変わらない | — | 料金区分が同じなので効果が無い |

### 2.5 決定

3 つの条件を 1 つの KQL にまとめた `alert-fetch-job-health` に置き換える。

- クエリは問題 1 つにつき 1 行を返し、`problem` 列(`fetch_missing` / `fetch_failed` / `cache_update_failed`)を次元にする。
  通知に問題の種類が出て、それぞれ独立に発火・自動解決するので、1 本にしても「何が起きたか」は分かる
- 窓は `fetch_missing` に合わせて 48 時間。残り 2 つはクエリの中で直近 1 時間に絞る(1 回の失敗が 48 時間発火し続けないように)
- 今後ログ検索アラートの条件を増やす時は、本数を増やさずこのクエリに `problem` を足す

クエリと定義ファイルは [monitoring.md](monitoring.md) と `docs/alerts/alert-fetch-job-health.json` にある。

### 2.6 対策と確認(2026-09-24 実施)

1. **クエリの確認**(Application Insights に直接実行、窓 48 時間)
   - 本番の条件: 0 行(健全な今は発火しない)
   - `fetch_missing`: 関数名を存在しない名前に差し替えると `fetch_missing` の 1 行が返る
   - `fetch_failed`: `status=failed` を `status=success` に、`ago(1h)` を `ago(48h)` に差し替えると、直近 2 回分の終了ログ 4 行(2 回 × 2 サイト)が返る
   - `cache_update_failed`: 検索文字列を正常時のログ `キャッシュ更新完了` に差し替えると 2 行が返る(日本語の検索文字列が正しく渡っていることの確認も兼ねる)
2. **ルールを作成**: `alert-fetch-job-health`(`docs/alerts/alert-fetch-job-health.json` を REST API で PUT)。作成後に取り出したクエリの日本語が壊れていないことも確認した
3. **発火の確認**: 必ず当たる変種(上の `fetch_failed` の差し替え)で一時的なルール `alert-test-fire` を作り、実際に発火させた
   - 作成の約 3 分後に発火(2026-09-24 02:33:28)
   - 発火した警告の次元が `problem = fetch_failed` になっていること、アクショングループが実行されたこと(抑止されていないこと)を確認
   - 確認後、一時ルールを削除し、発火した警告は Closed にした
   - ただし、この時点では**メールが実際に届いたかは確認していなかった**。届いていなかったことが後で分かった(2.8)
4. **古い 3 本を削除**: 定義を手元に退避してから `alert-fetch-job-missing` / `alert-fetch-job-failed` / `alert-cache-update-failed` を削除。
   新しいルールは作成後も発火していない(誤検知なし)

ログ検索アラートは 3 本から 1 本になった。監視している条件は変わらない。

### 2.7 効果

2026-09-27 に、2.2 と同じ Query API で日別・サービス別の実績を取り直した(日付は UTC)。

| 日付 | Azure Monitor | Storage | そのほか |
|---|---:|---:|---:|
| 09-18〜09-23(6 日) | 7.07〜7.71 円 | 0.58〜0.67 円 | 0 円 |
| 09-24(切り替えた日) | 3.22 円 | 0.76 円 | 0 円 |
| 09-25 | 2.46 円 | 0.61 円 | 0 円 |
| 09-26 | 2.14 円 | 0.48 円 | 0 円 |

- 切り替え後の丸 1 日(09-25)で Azure Monitor は 2.46 円になり、見込みどおり約 3 分の 1 になった。月にすると約 225 円 → 約 75 円
- 09-24 は古い 3 本が 02:45 UTC ごろまで残っていたのと、確認用の一時ルールの分で中間の値になっている
- 09-26 がやや低いのは、取得した時点でその日の集計が終わっていない可能性がある
- SQL Database / Functions / Log Analytics は引き続き 0 円で、費用はほぼ「ログ検索アラート 1 本 + ストレージ」だけになった

**その後の実績(2026-10-07 追記)**: 同じ Query API で 10 日分を確かめた。

| 期間 | Azure Monitor | Storage | 合計(1 日) |
|---|---:|---:|---:|
| 09-25〜10-04(10 日) | 2.33〜2.61 円 | 0.02〜0.61 円 | 2.56〜3.19 円(平均 2.98 円) |

- 切り替え後の水準はそのまま続いている。月にすると約 90 円
- 上の表で「集計が終わっていない可能性がある」とした 09-26 は、確定後の値が Azure Monitor 2.57 円だった。
  日別の値は締めた後も 1 日以上増えることがこれで分かったので、ダッシュボードの表示では取得日の 2 日前までを確定値として扱っている
- Storage が 10-01・10-02 だけ 0.02 円と低い。この 2 日に使い方は変えておらず、理由は分かっていない
- 2026-10-07 から、この日別・サービス別の費用をダッシュボードの「運用状況」に毎日表示している(取得ジョブの最後に Cost Management から取る。#19)。
  ここに書いた数字は、以後はダッシュボードで確かめられる

### 2.8 通知メールが一度も届いていなかった(2026-09-24 発覚、09-27 解決)

2.6 の発火確認のあと、実際のメールを受信側で探したところ、見つからなかった。

**原因**: アクショングループの通知先は 2026-09-15 の作成時から学校のメールアドレスだけだったが、
作成時に Azure から届いた「Verify your email address」のメールが未確認のままだった。確認されていない宛先にはメールが送られない。
つまり監視を作ってから 9 日間、どのアラートが発火してもメールは届かない状態だった。

**見落とした理由**: Azure 側の表示はすべて「正常」に見えていた。

- 通知先の状態は `Enabled`
- 警告の履歴には `Action group ag-mod-insight-email executed` と出る
- Portal の「テスト通知」はこのサブスクリプションでは使えない(`Free subscription not supported`)ので、そこで気づく機会もなかった

「アクショングループが実行された」は Azure が送信を試みたという意味でしかなく、届いたことの証明にはならない。

**対策と確認**:

1. 通知先を個人のメールアドレスに差し替え、確認メールのリンクを開いた(09-24 02:49 UTC に「action group に追加された」旨のメールを受信)
2. 同じ手順の一時ルール(`alert-test-fire-2`)を 02:52 に発火させたが、このメールは届かなかった(09-27 に迷惑メールを含めて受信箱を確認)。確認直後だったことのほかに違いが見当たらず、原因は特定できていない
3. 09-27 に新しい名前の一時ルール(`alert-test-fire-4`)で再度発火させた(02:35 UTC)。**今回は受信側でメールを確認できた**。本文に `problem = fetch_failed` の次元も出ている。確認後、一時ルールは削除し、警告は Closed にした

**教訓**: 通知の確認は「送った側の記録」ではなく「受け取った側」で行う。通知先を変えたときも同じ確認をする。
