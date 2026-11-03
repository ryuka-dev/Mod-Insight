// ============================================================
// fetchJob.test.js
//
// fetchJob.js のうち、ゲームのお知らせを保存する段階(refreshGameEvents)のテスト。
// 本物の Steam API と DB にはつながない。steamNews.fetchGameEvents と db.upsertEvent を
// node:test の mock で差し替えて確かめる。
//
// 確かめていること:
//   - 取り込んだお知らせを 1 件ずつ保存し、新規と既存の件数をログに出すこと
//   - お知らせの取得や保存に失敗しても例外を外に投げないこと(取得ジョブを止めない)
//   - 失敗のログがアラート(docs/alerts/alert-fetch-job-health.json)の探す文言を含まないこと
// ============================================================

const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/db");
const steamNews = require("../src/steamNews");
const { refreshGameEvents } = require("../src/fetchJob");

// アラートのクエリが探している文言。お知らせの段階のログはこれを含んではいけない
const ALERT_WORDS = ["status=failed", "キャッシュの更新に失敗", "運用費用の取得に失敗", "取得ジョブ終了"];

// 出したログを覚えておく logger
function recordingLogger() {
  const lines = [];
  return {
    lines: lines,
    log: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
}

function event(externalId) {
  return {
    occurred_at: "2026-10-31T12:40:51.000Z",
    kind: "game_patch",
    title: `Patch ${externalId}`,
    url: null,
    source: "steam",
    external_id: externalId,
  };
}

afterEach(() => {
  mock.restoreAll();
});

describe("refreshGameEvents", () => {
  test("お知らせを 1 件ずつ保存し、新規と既存の件数をログに出す", async () => {
    mock.method(steamNews, "fetchGameEvents", async () => [event("1"), event("2"), event("3")]);
    const upsert = mock.method(db, "upsertEvent", async (e) => (e.external_id === "3" ? "INSERT" : "UPDATE"));
    const logger = recordingLogger();

    await refreshGameEvents(logger);

    assert.deepEqual(upsert.mock.calls.map((c) => c.arguments[0].external_id), ["1", "2", "3"]);
    assert.match(logger.lines.at(-1), /新規=1, 既存=2/);
  });

  test("お知らせの取得に失敗しても例外を投げず、DB には書かない", async () => {
    mock.method(steamNews, "fetchGameEvents", async () => { throw new Error("HTTP 503"); });
    const upsert = mock.method(db, "upsertEvent", async () => "INSERT");
    const logger = recordingLogger();

    await refreshGameEvents(logger);

    assert.equal(upsert.mock.callCount(), 0);
    assert.ok(logger.lines.some((line) => line.includes("ゲームのお知らせの取得に失敗しました")));
    for (const line of logger.lines) {
      for (const word of ALERT_WORDS) {
        assert.ok(!line.includes(word), `ログ「${line}」がアラートの文言「${word}」を含んでいる`);
      }
    }
  });

  test("保存に失敗したら例外を投げずにそこでやめる", async () => {
    mock.method(steamNews, "fetchGameEvents", async () => [event("1"), event("2"), event("3")]);
    let calls = 0;
    mock.method(db, "upsertEvent", async () => {
      calls++;
      if (calls === 2) {
        throw new Error("DB に接続できません");
      }
      return "INSERT";
    });
    const logger = recordingLogger();

    await refreshGameEvents(logger);

    assert.equal(calls, 2);
    assert.ok(logger.lines.some((line) => line.includes("ゲームのお知らせの保存に失敗しました(1 件保存した後)")));
    for (const line of logger.lines) {
      for (const word of ALERT_WORDS) {
        assert.ok(!line.includes(word), `ログ「${line}」がアラートの文言「${word}」を含んでいる`);
      }
    }
  });
});
