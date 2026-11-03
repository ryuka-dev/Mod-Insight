-- ============================================================
-- 005_create_event_mod_assessments.sql
--
-- ゲームの更新ごとに、mod ごとの「修正が必要だったか」を記録する event_mod_assessments テーブルを追加する。
--
-- 背景:
--   ゲームが更新されても、多くの mod はそのまま動き、新しい版を出す必要がない。
--   ダウンロード数だけからは mod が動かなくなったかどうかを判断できないので、
--   「ゲーム更新への対応」(eventImpact.js)の合計が、直す必要のなかった mod まで含んでしまっていた。
--   互換性チェック(ゲームの新旧のビルドを比べ、各 mod が壊れたかどうかを調べる作業)の結論をここに記録し、
--   合計を「修正が必要だった mod」だけで出せるようにする。
--
-- 何を入れて、何を入れないか:
--   入れる:   更新 × mod ごとの「修正が必要だった / 不要だった」
--   入れない: 何が壊れたかの詳細(公開しない。互換性チェックの作業記録は別の非公開リポジトリにある)
--   行が無い組み合わせは「未確認」として扱う。
--
-- mod_id は配布サイトごとの mod(mods テーブルの 1 行)を指す。
-- 同じ mod を Thunderstore と Nexus Mods の両方で公開している時は、取り込みスクリプトが両方の行を書く。
--
-- 使い方:
--   001〜004 を実行済みのデータベースに対して、このファイルをそのまま一度だけ実行する。
--   行は scripts/import-assessment.js で書く(手で INSERT してもよい)。
-- ============================================================

CREATE TABLE event_mod_assessments (
    event_id    INT       NOT NULL FOREIGN KEY REFERENCES events(event_id),
    mod_id      INT       NOT NULL FOREIGN KEY REFERENCES mods(mod_id),
    needs_fix   BIT       NOT NULL,                     -- 1 = この更新で修正が必要だった、0 = 確認して修正は不要だった
    updated_at  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),  -- 最後に書いた日時(UTC)
    CONSTRAINT PK_event_mod_assessments PRIMARY KEY (event_id, mod_id)  -- 1 つの更新 × 1 つの mod に 1 行
);
