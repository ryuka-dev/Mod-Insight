// ============================================================
// httpUtil.js
//
// HTTP 関数(functions/Get*.js, RunFetch.js)で共通して使う小さな道具。
// 「URL の {modId} を数値に直す」「エラー応答を同じ形で返す」の 2 つだけ。
//
// エラー応答の形はすべて { "error": "説明文" } に統一する。
// フロントエンドはこの形だけ見ればエラーの内容が分かる。
// ============================================================

// URL の {modId} を整数に変換する
// 入力: request(Azure Functions の HttpRequest)
// 出力: 正の整数、または不正な値なら null
// 例: "12" → 12、"abc" → null、"0" → null、"1.5" → null
function parseModId(request) {
  const raw = request.params.modId;
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const modId = Number(raw);
  if (modId <= 0 || modId > 2147483647) {
    // SQL の INT に収まらない値は存在し得ないので不正扱い
    return null;
  }
  return modId;
}

// エラー応答を作る
// 入力: status(HTTP ステータスコード)、message(説明文)
// 出力: Azure Functions にそのまま返せる応答オブジェクト
function errorResponse(status, message) {
  return {
    status: status,
    jsonBody: { error: message },
  };
}

module.exports = { parseModId, errorResponse };
