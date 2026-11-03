-- ============================================================
-- 004_create_events.sql
--
-- 外部の出来事(ゲーム本体のアップデートやお知らせなど)を記録する events テーブルを追加する。
--
-- 背景:
--   ダウンロード数が急に増えたり減ったりした時、その理由が自分の mod の更新なのか、
--   ゲーム本体の出来事(正式リリース、パッチ)なのかを、これまでのデータだけでは区別できなかった。
--   例: 2026-10-29 からの急増は、同じ時期の自分の更新ではなく、ゲームの 1.0 正式リリース(10/28)によるもの。
--   グラフに出来事を重ねて表示し、増減の理由を後から確かめられるようにする。
--
-- 何を入れて、何を入れないか:
--   入れる:   Steam のゲームのお知らせ(取得ジョブが毎日取り込む)、手入力のメモ
--   入れない: mod 自身の公開日。mod_versions.release_date にすでにあるので、同じ事実を 2 か所に持たない
--
-- kind(出来事の種類):
--   'game_major'  ゲームの大型アップデート(正式リリースなど)。自動では判定できないので、手で付け替える(下の「使い方」)
--   'game_patch'  ゲームのパッチ。Steam のお知らせの tags に 'patchnotes' があるもの
--   'game_news'   上記以外のゲームのお知らせ(販売本数の発表、イベント出展など)
--   'note'        手入力のメモ(例: mod を紹介する投稿をした日)
--
-- 使い方:
--   001〜003 を実行済みのデータベースに対して、このファイルをそのまま一度だけ実行する。
--   取得ジョブは (source, external_id) で同じお知らせを判定し、2 回目以降は title と url だけを更新する。
--   kind は更新しないので、手で付け替えた値は残る。大型アップデートの付け替えの例:
--     UPDATE events SET kind = 'game_major'
--     WHERE source = 'steam' AND external_id = '1847920302230896';  -- SULFUR 1.0 OUT NOW(2026-10-28)
-- ============================================================

CREATE TABLE events (
    event_id     INT IDENTITY PRIMARY KEY,
    occurred_at  DATETIME2     NOT NULL,                     -- 出来事の日時(UTC)。Steam の場合はお知らせの投稿日時
    kind         NVARCHAR(20)  NOT NULL,                     -- 出来事の種類(上の説明を参照)
    title        NVARCHAR(300) NOT NULL,                     -- 表示用の見出し(例: Patch Notes 1.0.2)
    url          NVARCHAR(500) NULL,                         -- 詳細のページ。無ければ NULL
    source       NVARCHAR(20)  NOT NULL,                     -- どこから来たか: 'steam'(自動取り込み)/ 'manual'(手入力)
    external_id  NVARCHAR(100) NULL,                         -- 取得元での ID(Steam はお知らせの gid)。手入力は NULL
    mod_id       INT           NULL FOREIGN KEY REFERENCES mods(mod_id),  -- 特定の mod に関する出来事なら、その mod。ゲーム全体の出来事は NULL
    created_at   DATETIME2     DEFAULT SYSUTCDATETIME(),     -- この行を作成した日時(UTC)
    CONSTRAINT CK_events_kind CHECK (kind IN ('game_major', 'game_patch', 'game_news', 'note')),
    CONSTRAINT CK_events_source CHECK (source IN ('steam', 'manual'))
);

-- 同じお知らせを二重に取り込まないための一意制約。
-- 手入力(external_id が NULL)の行は何件あってもよいので、NULL の行は対象から外す(フィルター付きの索引)
CREATE UNIQUE INDEX UQ_events_source_external_id
    ON events (source, external_id)
    WHERE external_id IS NOT NULL;

-- グラフの期間で出来事を引くための索引
CREATE INDEX IX_events_occurred_at
    ON events (occurred_at);
