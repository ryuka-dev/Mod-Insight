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
