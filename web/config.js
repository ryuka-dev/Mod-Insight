// ============================================================
// config.js
//
// フロントエンドの設定。今は API のベース URL だけ。
// app.js より先に読み込まれ、window.MOD_INSIGHT_CONFIG として参照される。
//
// ローカルで Functions を動かして確認するときは apiBaseUrl を
// "http://localhost:7071/api" に書き換える(コミットするときは戻す)。
// ============================================================

window.MOD_INSIGHT_CONFIG = {
  apiBaseUrl: "https://mod-insight-ryuka-hrhbbdauc0ezbfc7.eastasia-01.azurewebsites.net/api",
};
