// ============================================================
// httpUtil.js
//
// HTTP 関数(functions/Get*.js, RunFetch.js)で共通して使う小さな道具。
// 「URL の {modId} を数値に直す」「from / to の日付を読む」「エラー応答を同じ形で返す」の 3 つだけ。
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

// クエリパラメータの日付文字列を Date に変換する
// 入力: 文字列または null(未指定)
// 出力: { ok: true, value: Date または null } / { ok: false }(読めない文字列)
// "2026-09-01" のような日付、または ISO 形式の日時を受け付ける。
// 日付だけの場合は UTC の 0 時として扱われる(JavaScript の Date の仕様)。
function parseDateParam(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return { ok: true, value: null };
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { ok: false };
  }
  return { ok: true, value: date };
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

module.exports = { parseModId, parseDateParam, errorResponse };
