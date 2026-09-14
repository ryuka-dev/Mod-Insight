-- ============================================================
-- 001_create_tables.sql
--
-- Mod Insight のテーブル作成スクリプト(Azure SQL Database 用)
--
-- 使い方:
--   Azure Portal のクエリエディター、または SSMS / Azure Data Studio で
--   このファイルの内容をそのまま実行する。
--   ※ 一度しか実行しない前提。二回目は「既に存在する」エラーになる。
--
-- テーブル構成:
--   mods          追跡対象の mod の基本情報(1 mod = 1 行)
--   mod_versions  各 mod のバージョン履歴
--   snapshots     定期的に記録するダウンロード数・評価の時系列データ(中心となるテーブル)
--   fetch_logs    取得ジョブの実行記録
-- ============================================================

-- ------------------------------------------------------------
-- mods: 追跡対象の mod の基本情報
--
-- platform + external_id の組み合わせで 1 つの mod を一意に特定する。
-- 現段階では platform は 'thunderstore' のみだが、将来 Nexus Mods など
-- 他のプラットフォームを追加できるようにこの形にしている。
-- ------------------------------------------------------------
CREATE TABLE mods (
    mod_id        INT IDENTITY PRIMARY KEY,
    name          NVARCHAR(200) NOT NULL,                              -- mod 名(例: SULFUR_Together)
    author        NVARCHAR(200),                                       -- 作者名(例: ryuka_labs)
    platform      NVARCHAR(20)  NOT NULL DEFAULT 'thunderstore',       -- データ取得元プラットフォーム
    external_id   NVARCHAR(200) NOT NULL,                              -- そのプラットフォーム上で mod を特定する ID(例: ryuka_labs/SULFUR_Together)
    is_deprecated BIT           NOT NULL DEFAULT 0,                    -- 非推奨 / 重複アップロードの mod なら 1
    created_at    DATETIME2     DEFAULT SYSUTCDATETIME(),              -- この行を作成した日時(UTC)
    CONSTRAINT UQ_mods_platform_external_id UNIQUE (platform, external_id)  -- 同じ mod を二重登録させない
);

-- ------------------------------------------------------------
-- mod_versions: バージョン履歴
-- ------------------------------------------------------------
CREATE TABLE mod_versions (
    version_id      INT IDENTITY PRIMARY KEY,
    mod_id          INT NOT NULL FOREIGN KEY REFERENCES mods(mod_id),
    version_number  NVARCHAR(50) NOT NULL,                             -- 例: 1.4.1
    release_date    DATE,                                              -- 公開日
    changelog       NVARCHAR(MAX) NULL                                 -- 変更履歴(現段階では未使用)
);

-- ------------------------------------------------------------
-- snapshots: 時系列データ(取得ジョブが実行されるたびに 1 mod につき 1 行追加)
--
-- download_count は API が直接返す値ではなく、
-- versions[].downloads を全バージョン分合計して算出した値を保存する。
-- ------------------------------------------------------------
CREATE TABLE snapshots (
    snapshot_id    INT IDENTITY PRIMARY KEY,
    mod_id         INT NOT NULL FOREIGN KEY REFERENCES mods(mod_id),
    captured_at    DATETIME2 NOT NULL,                                 -- 取得日時(UTC)
    download_count INT NOT NULL,                                       -- 全バージョンのダウンロード数合計(計算値)
    rating_score   INT NULL,                                           -- 評価スコア(API がそのまま返す整数)
    raw_json       NVARCHAR(MAX) NULL                                  -- API レスポンスをそのまま保存(将来の項目追加に備える)
);

-- グラフ用の「特定 mod の期間指定」クエリを速くするためのインデックス
CREATE INDEX IX_snapshots_mod_id_captured_at ON snapshots (mod_id, captured_at);

-- ------------------------------------------------------------
-- fetch_logs: 取得ジョブの実行記録
-- ------------------------------------------------------------
CREATE TABLE fetch_logs (
    log_id           INT IDENTITY PRIMARY KEY,
    run_at           DATETIME2 NOT NULL,                               -- 実行日時(UTC)
    status           NVARCHAR(20) NOT NULL,                            -- 'success' または 'failed'
    error_message    NVARCHAR(MAX) NULL,                               -- 失敗時のエラー内容
    records_fetched  INT NULL                                          -- 正常に保存できた mod の件数
);
