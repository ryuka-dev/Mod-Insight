// ダッシュボードの URL の QR コードを作る(企画書と動画の最後のページに載せる)。
//
// 入力: なし(URL はここに書いてある 1 つだけ)
// 出力: ../video/assets/qr-insight.svg(動画用。拡大してもぼやけない)
//       ../deck/images/qr-insight.png(企画書用)
//
// 使い方: cd presentation/tools && npm run qr

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import QRCode from "qrcode";

const URL = "https://insight.ryuka.cloud";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 誤り訂正は M(約 15% まで欠けても読める)。画面に映すだけなので、これで十分な余裕がある
const options = { errorCorrectionLevel: "M", margin: 2, color: { dark: "#0b0b0bff", light: "#ffffffff" } };

await writeFile(join(ROOT, "video", "assets", "qr-insight.svg"), await QRCode.toString(URL, { ...options, type: "svg" }), "utf8");
await QRCode.toFile(join(ROOT, "deck", "images", "qr-insight.png"), URL, { ...options, width: 800 });
console.log(`QR コードを書き出し: ${URL}`);
