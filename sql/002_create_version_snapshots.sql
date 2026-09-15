-- ============================================================
-- 002_create_version_snapshots.sql
--
-- バージョンごとのダウンロード数の時系列テーブルを追加する。
--
-- 背景:
--   snapshots.download_count は全バージョンの合計。
--   「新しいバージョンが公開されたあと、利用者がどれくらいの速さで移行したか」を
--   見るには、バージョン単位の推移が必要になる。
--   Thunderstore API の versions[].downloads がその値で、これまでも
--   snapshots.raw_json の中には保存されていたが、SQL で集計できる形ではなかった。
--
-- 使い方:
--   001 を実行済みのデータベースに対して、このファイルをそのまま一度だけ実行する。
--   既存データからの埋め戻しは scripts/backfill-version-snapshots.js で行う。
-- ============================================================

-- ------------------------------------------------------------
-- mod_versions: (mod_id, version_number) の組を一意にする
--
-- 取得ジョブは MERGE で二重登録を避けているが、テーブル側にも制約を置いて
-- 「同じ mod の同じバージョンは 1 行だけ」をデータベースが保証するようにする。
-- version_snapshots が version_id を参照するので、この一意性が前提になる。
-- ------------------------------------------------------------
ALTER TABLE mod_versions
    ADD CONSTRAINT UQ_mod_versions_mod_id_version_number UNIQUE (mod_id, version_number);

-- ------------------------------------------------------------
-- version_snapshots: バージョン単位の時系列データ
--
-- 取得ジョブが実行されるたびに、1 バージョンにつき 1 行追加される。
-- captured_at は同じ回の snapshots.captured_at と同じ値にする(同じ回だと分かるように)。
-- ------------------------------------------------------------
CREATE TABLE version_snapshots (
    version_snapshot_id INT IDENTITY PRIMARY KEY,
    version_id          INT NOT NULL FOREIGN KEY REFERENCES mod_versions(version_id),
    captured_at         DATETIME2 NOT NULL,                        -- 取得日時(UTC)
    download_count      INT NOT NULL                               -- そのバージョン単体のダウンロード数(API の versions[].downloads)
);

-- グラフ用の「あるバージョンの期間内の推移」を速く引くための索引
CREATE INDEX IX_version_snapshots_version_id_captured_at
    ON version_snapshots (version_id, captured_at);
