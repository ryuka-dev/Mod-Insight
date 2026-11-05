-- ============================================================
-- 006_add_released_at_to_mod_versions.sql
--
-- mod_versions に、公開日時(時刻まで)を持つ released_at 列を追加する。
--
-- 背景:
--   release_date は日付だけなので、同じ日に公開した版の新旧が分からない。
--   これまでは version_id の大きい方を新しいとしていたが、Thunderstore の API は新しい版から順に返すので、
--   1 回の取得で複数の版を入れると新しい版ほど version_id が小さくなり、新旧が逆になっていた
--   (SULFUR_Native_UI_Lib の 0.10.0 / 0.10.1、Toggle_Melee_Stance の 1.5.0 / 1.6.0)。
--
-- release_date を残す理由:
--   API の応答の形を変えないため。並び順も release_date のままにして、同じ日の時だけ released_at で決める。
--   こうしておくと、released_at がまだ空の行があっても今までと同じように動く。
--
-- 既存の行の埋め方:
--   取得ジョブは毎日全バージョンを upsertModVersion に通すので、released_at が空の行はそこで埋まる。
--   埋め戻しのスクリプトは要らない(次の取得で全部そろう)。
--
-- 使い方:
--   001〜005 を実行済みのデータベースに対して、このファイルをそのまま一度だけ実行する。
--   この列を使うコードをデプロイする前に実行すること(列が無いと SELECT が失敗する)。
-- ============================================================

ALTER TABLE mod_versions
    ADD released_at DATETIME2 NULL;  -- 配布サイトの API が返す公開日時(UTC)。API に無ければ NULL
