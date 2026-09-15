-- ============================================================
-- 003_add_platform_to_fetch_logs.sql
--
-- fetch_logs に platform 列を追加する。
--
-- 背景:
--   Nexus Mods の取得を追加したことで、1 回の取得ジョブがプラットフォームごとに
--   1 行ずつ fetch_logs を書くようになった。どの行がどのプラットフォームの結果かを
--   区別できるようにする。
--
-- 既存の行はすべて Thunderstore だけを取得していた時期のものなので、
-- 既定値 'thunderstore' で埋める(NOT NULL + DEFAULT を付けて追加すると
-- SQL Server が既存行にも既定値を入れてくれる)。
--
-- 使い方:
--   001、002 を実行済みのデータベースに対して、このファイルをそのまま一度だけ実行する。
-- ============================================================

ALTER TABLE fetch_logs
    ADD platform NVARCHAR(20) NOT NULL
        CONSTRAINT DF_fetch_logs_platform DEFAULT 'thunderstore';
