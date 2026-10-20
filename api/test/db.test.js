// ============================================================
// db.test.js
//
// db.js のうち、DB に接続しなくても確かめられる部分のテスト。
// 確かめたいこと:
//   - 接続文字列の内容(サーバー・DB 名・ユーザー)がそのまま設定に入ること
//   - DB の再開を待てるだけの再試行の回数と間隔が設定に入ること
// ============================================================

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { buildPoolConfig } = require("../src/db");

// Azure Portal が出す ADO.NET 形式と同じ形(値はダミー)
const CONNECTION_STRING =
  "Server=tcp:example.database.windows.net,1433;Initial Catalog=exampledb;User ID=user;Password=dummy;Encrypt=True;Connection Timeout=30;";

describe("buildPoolConfig", () => {
  test("接続文字列の内容がそのまま入る", () => {
    const config = buildPoolConfig(CONNECTION_STRING);
    assert.equal(config.server, "example.database.windows.net");
    assert.equal(config.database, "exampledb");
    assert.equal(config.user, "user");
    assert.equal(config.options.encrypt, true);
  });

  test("一時的なエラーの再試行で 1 分ほど待てる", () => {
    const { options } = buildPoolConfig(CONNECTION_STRING);
    assert.equal(options.maxRetriesOnTransientErrors, 6);
    assert.equal(options.connectionRetryInterval, 10000);
    assert.ok(options.maxRetriesOnTransientErrors * options.connectionRetryInterval >= 60000);
  });
});
