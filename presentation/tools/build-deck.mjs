// 企画書(pptx)を作る。
//
// 解決すること: 企画書と発表動画で数字や構成がずれないように、どちらも同じデータ(video/assets/data.js)と
//   同じ原稿(script.md)から作る。PowerPoint を手で編集すると、データを取り直したときに直す場所が増えるため。
// 入力: ../video/assets/data.js(fetch-data.mjs が生成)、../script.md(発表者ノートに入れる)、../deck/images/*.png
// 出力: ../deck/renders/Mod-Insight-企画書.pptx(提出用のファイル名には別途クラス記号などを付ける)
//
// 使い方: cd presentation/tools && npm install && npm run deck

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const PptxGenJS = require("pptxgenjs");
const JSZip = require(require.resolve("jszip", { paths: [require.resolve("pptxgenjs")] }));

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT_DIR = join(ROOT, "deck", "renders");
const OUT = join(OUT_DIR, "Mod-Insight-企画書.pptx");
const IMG = (name) => join(ROOT, "deck", "images", name);

// ---- 入力 ----

// data.js は window.MI_DATA に代入する形なので、空の window を渡して実行する
async function loadData() {
  const code = await readFile(join(ROOT, "video", "assets", "data.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  return sandbox.window.MI_DATA;
}

// 原稿を「## 番号. 名前」ごとに分け、番号 → 本文 の表にする(発表者ノート用)
async function loadScript() {
  const text = await readFile(join(ROOT, "script.md"), "utf8");
  const body = text.split("\n---\n")[1] ?? "";
  const sections = {};
  for (const block of body.split(/^## /m).slice(1)) {
    const [head, ...lines] = block.split("\n");
    const no = Number(head.split(".")[0]);
    sections[no] = lines.join("\n").trim();
  }
  return sections;
}

const D = await loadData();
const SCRIPT = await loadScript();
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const md = (date) => {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
};
const jstStamp = (iso) => {
  const j = new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString();
  return `${j.slice(0, 10).replace(/-/g, "/")} ${j.slice(11, 16)}`;
};
const AS_OF = jstStamp(D.latestCapturedAt);

// ---- テーマ(ダッシュボードと同じ色) ----

const FONT = "Meiryo";
const THEME = {
  name: "Mod Insight",
  colors: {
    dk1: "0B0B0B",
    lt1: "FFFFFF",
    dk2: "52514E",
    lt2: "F9F9F7",
    accent1: "2A78D6", // データ・強調
    accent2: "EB6834", // 修正前の版
    accent3: "1BAF7A",
    accent4: "EDA100",
    accent5: "898781", // 控えめな文字
    accent6: "2E2D2A", // ゲームの更新
    hlink: "2A78D6",
    folHlink: "52514E",
  },
};
const HEX = THEME.colors;
const GRID = "E1E0D9";

const pres = new PptxGenJS();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 インチ
pres.author = "";
pres.title = "Mod Insight 企画書";
pres.theme = { headFontFace: FONT, bodyFontFace: FONT };
const C = pres.SchemeColor;

// 表紙と本文の 2 種類のレイアウト
pres.defineSlideMaster({
  title: "COVER",
  background: { color: C.background2 },
  objects: [
    {
      placeholder: {
        options: { name: "title", type: "title", x: 0.8, y: 1.7, w: 6.8, h: 1.3, fontSize: 60, bold: true, color: C.text1, margin: 0, align: "left" },
        text: "",
      },
    },
    {
      placeholder: {
        options: { name: "body", type: "body", x: 0.8, y: 3.05, w: 6.8, h: 1.0, fontSize: 22, color: C.text1, margin: 0, valign: "top", align: "left" },
        text: "",
      },
    },
  ],
});
pres.defineSlideMaster({
  title: "CONTENT",
  background: { color: C.background2 },
  margin: [0.5, 0.6, 0.6, 0.6],
  objects: [
    {
      placeholder: {
        options: { name: "title", type: "title", x: 0.6, y: 0.4, w: 12.1, h: 0.8, fontSize: 30, bold: true, color: C.text1, margin: 0, valign: "middle", align: "left" },
        text: "",
      },
    },
    { text: { text: "Mod Insight 企画書", options: { x: 0.6, y: 7.0, w: 4, h: 0.3, fontSize: 10, color: C.accent5, margin: 0 } } },
  ],
  slideNumber: { x: 12.2, y: 7.0, w: 0.5, h: 0.3, fontSize: 10, color: C.accent5, align: "right" },
});

// ---- 部品 ----

function card(slide, x, y, w, h, name) {
  slide.addShape(pres.ShapeType.roundRect, {
    x, y, w, h,
    rectRadius: 0.08,
    fill: { color: C.background1 },
    line: { color: GRID, width: 1 },
    shadow: { type: "outer", color: "0B0B0B", opacity: 0.08, blur: 6, offset: 1.5, angle: 90 },
    objectName: name,
  });
}

function text(slide, value, opts) {
  slide.addText(value, { isTextBox: true, margin: 0, color: C.text1, fontSize: 15, valign: "top", ...opts });
}

function arrow(slide, x1, y1, x2, y2, color = HEX.accent5) {
  slide.addShape(pres.ShapeType.line, {
    x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1) || 0.001, h: Math.abs(y2 - y1) || 0.001,
    flipH: x2 < x1, flipV: y2 < y1,
    line: { color, width: 1.75, endArrowType: "triangle" },
  });
}

// 大きな数字と説明
function stat(slide, x, y, w, value, label, color = C.text1, size = 40) {
  text(slide, value, { x, y, w, h: 0.75, fontSize: size, bold: true, color, valign: "bottom" });
  text(slide, label, { x, y: y + 0.8, w, h: 0.6, fontSize: 13, color: C.text2 });
}

const axisStyle = {
  catAxisLabelColor: HEX.dk2,
  valAxisLabelColor: HEX.dk2,
  catAxisLabelFontSize: 11,
  valAxisLabelFontSize: 11,
  catAxisLabelFontFace: "+mn-lt",
  valAxisLabelFontFace: "+mn-lt",
  titleFontFace: "+mn-lt",
  valGridLine: { color: GRID, size: 0.75 },
  catGridLine: { style: "none" },
  showLegend: false,
  titleColor: HEX.dk1,
  titleFontSize: 13,
};

const notes = (slide, ...nos) => {
  const t = nos.map((n) => SCRIPT[n]).filter(Boolean).join("\n\n");
  if (t) slide.addNotes(t);
};

// ---- 1. 表紙 ----
{
  const s = pres.addSlide({ masterName: "COVER" });
  text(s, "就職作品 企画書", { x: 0.8, y: 1.2, w: 5, h: 0.4, fontSize: 16, color: C.text2 });
  s.addText([{ text: "Mod " }, { text: "Insight", options: { color: C.accent1 } }], { placeholder: "title" });
  s.addText("配布サイトの公開データを毎日集めて\n分析するシステム", { placeholder: "body" });
  text(s, "HAL 東京 情報処理学科", { x: 0.8, y: 5.6, w: 6, h: 0.4, fontSize: 16 });
  text(s, "2026 年 11 月", { x: 0.8, y: 6.05, w: 6, h: 0.4, fontSize: 14, color: C.text2 });

  const days = D.daily;
  s.addChart(pres.ChartType.bar, [{ name: "日ごとの増加", labels: days.map((d) => md(d.date)), values: days.map((d) => d.value) }], {
    x: 7.7, y: 1.5, w: 5.1, h: 4.4,
    barDir: "col",
    barGapWidthPct: 40,
    chartColors: [HEX.accent1],
    showTitle: true,
    title: "日ごとのダウンロード数(2 サイトの合計)",
    catAxisLabelFrequency: 14,
    ...axisStyle,
    objectName: "表紙のグラフ",
  });
  text(s, `記録: ${md(days[0].date)}〜${md(days[days.length - 1].date)}(日本時間)`, { x: 7.7, y: 5.95, w: 5.1, h: 0.3, fontSize: 11, color: C.text2 });
  notes(s, 1, 2);
}

// ---- 2. 企画の目的 ----
{
  const s = pres.addSlide({ masterName: "CONTENT" });
  s.addText("企画の目的", { placeholder: "title" });
  const blocks = [
    ["背景", `Thunderstore と Nexus Mods で、自作の mod を 25 個ずつ公開している。ダウンロードは 2 つのサイトで合計 ${fmt(D.totals.all)}(${AS_OF} 時点)。`],
    ["課題", "配布サイトで見られるのは今の合計だけ。昨日何件増えたか、新しい版に移ったか、ゲームの更新で何が変わったかは、自分で記録しないと分からない。"],
    ["目的", "毎日 0 時(日本時間)に両サイトの数値を保存し、推移と、ゲームの更新への対応を数字で見られるようにする。"],
  ];
  blocks.forEach(([h, b], i) => {
    const y = 1.5 + i * 1.75;
    card(s, 0.6, y, 5.9, 1.55, `目的-${h}`);
    text(s, h, { x: 0.85, y: y + 0.18, w: 5.4, h: 0.4, fontSize: 18, bold: true, color: i === 2 ? C.accent1 : C.text1 });
    text(s, b, { x: 0.85, y: y + 0.62, w: 5.4, h: 0.85, fontSize: 14 });
  });
  const pts = D.totalsSeries.filter((p) => p.date >= "2026-09-16");
  s.addChart(pres.ChartType.line, [{ name: "合計", labels: pts.map((p) => md(p.date)), values: pts.map((p) => p.value) }], {
    x: 6.9, y: 1.5, w: 5.8, h: 4.9,
    chartColors: [HEX.accent1],
    lineSize: 2.5,
    lineDataSymbol: "none",
    showTitle: true,
    title: "毎日 0 時に記録した合計ダウンロード数(2 サイト)",
    valAxisMinVal: 30000,
    catAxisLabelFrequency: 10,
    ...axisStyle,
    objectName: "合計の推移",
  });
  notes(s, 3);
}

// ---- 3. 誰に見てほしいか ----
{
  const s = pres.addSlide({ masterName: "CONTENT" });
  s.addText("誰に見てほしいか: IT 企業の方", { placeholder: "title" });
  text(s, "見ていただきたいのは、データの取得から運用までを、ひとりで作って毎日動かしていること", { x: 0.6, y: 1.45, w: 12.1, h: 0.5, fontSize: 18, bold: true });
  const steps = [
    ["データの取得", "配布サイト 2 つの API\nSteam のお知らせ"],
    ["データベース", "Azure SQL\nテーブル 7 つ"],
    ["クラウドへの配置", "Azure Functions\nGitHub Actions"],
    ["監視", "Application Insights\nメール通知"],
    ["費用の確認", "Cost Management\n日別・サービス別"],
  ];
  const w = 2.15, gap = 0.34;
  steps.forEach(([h, b], i) => {
    const x = 0.6 + i * (w + gap);
    card(s, x, 2.25, w, 1.7, `工程-${h}`);
    text(s, h, { x: x + 0.18, y: 2.42, w: w - 0.3, h: 0.45, fontSize: 16, bold: true });
    text(s, b, { x: x + 0.18, y: 2.95, w: w - 0.3, h: 0.9, fontSize: 12, color: C.text2 });
    if (i < steps.length - 1) arrow(s, x + w + 0.04, 3.1, x + w + gap - 0.04, 3.1);
  });
  card(s, 0.6, 4.4, 5.9, 2.2, "稼働");
  text(s, "毎日動いている", { x: 0.85, y: 4.6, w: 5.4, h: 0.4, fontSize: 18, bold: true });
  text(s, `2026/09/14 から毎日 0 時に取得。50 件の mod、合計 ${fmt(D.totals.all)} ダウンロードの実データ。障害は原因と対応を docs/ops-log.md に記録している。`, { x: 0.85, y: 5.1, w: 5.4, h: 1.3, fontSize: 14 });
  card(s, 6.8, 4.4, 5.9, 2.2, "応用");
  text(s, "mod 以外にも使える", { x: 7.05, y: 4.6, w: 5.4, h: 0.4, fontSize: 18, bold: true });
  text(s, "「API で数値を取る → 時系列で保存 → 集計 API → 可視化」の作りなので、EC サイトの商品やアプリなど、API で数値が取れる対象に置き換えられる。", { x: 7.05, y: 5.1, w: 5.4, h: 1.3, fontSize: 14 });
  notes(s, 4);
}

// ---- 4. 画面 ----
{
  const s = pres.addSlide({ masterName: "CONTENT" });
  s.addText("作品の画面: ダッシュボード(insight.ryuka.cloud)", { placeholder: "title" });
  s.addImage({ path: IMG("overview.png"), x: 0.6, y: 1.4, w: 7.6, h: (7.6 * 760) / 2080, altText: "ダッシュボードの「全 mod の状況」。合計ダウンロード数と推移のグラフ", objectName: "画面-全体" });
  s.addImage({ path: IMG("daily.png"), x: 0.6, y: 4.4, w: 7.6, h: (7.6 * 600) / 2080, altText: "ダッシュボードの「日ごとの増加」。棒グラフとゲームの更新の縦線", objectName: "画面-日ごと" });
  card(s, 8.6, 1.4, 4.1, 5.2, "分かること");
  text(s, "画面で分かること", { x: 8.85, y: 1.6, w: 3.7, h: 0.4, fontSize: 18, bold: true });
  const items = [
    "全体の合計と、その推移",
    "日ごとの増加と 7 日平均",
    "ゲームの更新(縦線)との重なり",
    "新しい版への移行の速さ",
    "ゲームの更新後、各 mod が新しい版を出すまでの日数と、その間の旧版のダウンロード",
    "このシステム自体の運用費用",
  ];
  text(s, items.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < items.length - 1 } })), { x: 8.85, y: 2.15, w: 3.65, h: 4.2, fontSize: 14, paraSpaceAfter: 8 });
}

// ---- 5. システム構成 ----
{
  const s = pres.addSlide({ masterName: "CONTENT" });
  s.addText("システム構成", { placeholder: "title" });
  const box = (x, y, w, h, title, sub, name, accent) => {
    card(s, x, y, w, h, name);
    text(s, title, { x: x + 0.15, y: y + 0.12, w: w - 0.3, h: 0.35, fontSize: 14, bold: true, color: accent ?? C.text1 });
    if (sub) text(s, sub, { x: x + 0.15, y: y + 0.48, w: w - 0.3, h: h - 0.55, fontSize: 11, color: C.text2 });
  };
  box(0.6, 1.5, 2.2, 0.8, "Thunderstore", "配布サイト(v1 API)", "構成-TS");
  box(0.6, 2.5, 2.2, 0.8, "Nexus Mods", "配布サイト(GraphQL)", "構成-NX");
  box(0.6, 3.5, 2.2, 0.8, "Steam", "ゲームのお知らせ", "構成-Steam");
  box(3.3, 1.5, 3.3, 2.8, "Azure Functions", "タイマー: 毎日 0:00(日本時間)\n\nthunderstore.js / nexusmods.js\n→ 共通の形にそろえてから保存\n\n配布サイトを増やすときは\nアダプターを 1 ファイル足すだけ", "構成-Functions", C.accent1);
  box(7.2, 1.5, 2.5, 1.1, "Azure SQL Database", "無料枠。使わないと自動で停止", "構成-SQL");
  box(7.2, 3.2, 2.5, 1.1, "Blob Storage", "API の応答を作り置き(取得のたびに作り直す)", "構成-Blob");
  box(10.3, 2.35, 2.4, 1.1, "ダッシュボード", "Static Web Apps\nHTML + Chart.js", "構成-画面");
  [1.9, 2.9, 3.9].forEach((y) => arrow(s, 2.85, y, 3.25, y));
  arrow(s, 6.65, 2.05, 7.15, 2.05);
  arrow(s, 6.65, 3.75, 7.15, 3.75);
  arrow(s, 10.25, 3.1, 9.75, 3.6, HEX.accent1);
  text(s, "画面は Blob だけを読む", { x: 9.9, y: 3.75, w: 2.8, h: 0.3, fontSize: 11, color: C.accent1, bold: true });

  // 監視と配置
  box(0.6, 4.9, 3.0, 1.0, "Application Insights", "ログからアラートをメールで", "構成-監視");
  box(3.9, 4.9, 2.7, 1.0, "Cost Management", "運用費用を毎日取得", "構成-費用");
  box(7.2, 4.9, 1.6, 1.0, "GitHub", "main に入る", "構成-GitHub");
  box(9.15, 4.9, 1.5, 1.0, "テスト", "PR ごとに実行", "構成-テスト");
  box(11.0, 4.9, 1.7, 1.0, "自動デプロイ", "OIDC で鍵なし", "構成-デプロイ");
  arrow(s, 8.85, 5.4, 9.1, 5.4);
  arrow(s, 10.7, 5.4, 10.95, 5.4);
  text(s, "取得ジョブは配布サイトの項目名を知らず、アダプターが返す共通の形だけを保存する。GET API はすべて認証なし(公開データの読み取りのみ)。", { x: 0.6, y: 6.15, w: 12.1, h: 0.6, fontSize: 13, color: C.text2 });
  notes(s, 5);
}

// ---- 6. 工夫: 最初の表示 ----
{
  const s = pres.addSlide({ masterName: "CONTENT" });
  s.addText("工夫: その日最初の表示を 50 秒から 0.34 秒に", { placeholder: "title" });
  card(s, 0.6, 1.5, 5.9, 2.4, "対策前");
  text(s, "対策前", { x: 0.85, y: 1.7, w: 5, h: 0.4, fontSize: 16, bold: true, color: C.text2 });
  stat(s, 0.85, 2.1, 5.4, "約 50 秒", "その日最初に開いた人が、止まっていた DB の起動を待つ\n(実測 47.7〜52.9 秒)", C.accent2, 44);
  card(s, 6.8, 1.5, 5.9, 2.4, "対策後");
  text(s, "対策後", { x: 7.05, y: 1.7, w: 5, h: 0.4, fontSize: 16, bold: true, color: C.text2 });
  stat(s, 7.05, 2.1, 5.4, "0.34 秒", "DB は止まったまま返す\n(2026-09-16 計測、同じ API)", C.accent1, 44);
  const points = [
    ["原因", "無料枠の Azure SQL は、使われない時間が続くと自動で止まる。次の接続で約 50 秒かかる"],
    ["考えたこと", "データが変わるのは 1 日 1 回の取得のときだけ。それ以外の時間に DB を使う理由がない"],
    ["対策", "取得のあとに GET API の応答をすべて Blob Storage に作り直し、API はまずそれを返す。DB を起こすのは 1 日 1 回の取得だけになった"],
    ["採らなかった案", "DB に定期的にアクセスして起こしておく方法は、無料枠の使用時間を使い切るおそれがあるので採らなかった"],
  ];
  points.forEach(([h, b], i) => {
    const y = 4.2 + i * 0.66;
    text(s, h, { x: 0.6, y, w: 2.0, h: 0.6, fontSize: 14, bold: true });
    text(s, b, { x: 2.6, y, w: 10.1, h: 0.6, fontSize: 14 });
  });
}

// ---- 7. 実例: 1.0 ----
{
  const C10 = D.case10;
  const s = pres.addSlide({ masterName: "CONTENT" });
  s.addText("実例: ゲームの正式版 1.0 のあとの 8 日間", { placeholder: "title" });
  card(s, 0.6, 1.5, 5.4, 5.1, "1.0 の数字");
  stat(s, 0.85, 1.6, 2.4, `${C10.needsFix} / ${C10.checked} 個`, "修正が必要だった mod\n(新しいビルドで確認)", C.text1, 32);
  stat(s, 3.35, 1.6, 2.4, `${C10.released} / ${C10.needsFix} 個`, "新しい版を出した mod", C.text1, 32);
  stat(s, 0.85, 3.2, 2.4, `${C10.medianDaysFromMajor} 日`, "新しい版までの日数の中央値\n(1.0 の 10/28 から)", C.text1, 32);
  stat(s, 3.35, 3.2, 2.4, `${C10.medianDaysFrom102} 日`, "同じく 1.0.2 から\n(1.0.2 を待ってから直した)", C.text1, 32);
  stat(s, 0.85, 4.8, 5.0, `${fmt(C10.oldDownloads)} 回`, "その間の修正前の版のダウンロード\n(Thunderstore のみ。両端の日を含む多めの見積もり)", C.accent2, 44);
  const sorted = [...C10.mods].sort((a, b) => a.oldDownloads - b.oldDownloads);
  s.addChart(pres.ChartType.bar, [{ name: "修正前の版のダウンロード", labels: sorted.map((m) => `${m.name.replace(/_/g, " ")}(${m.days} 日)`), values: sorted.map((m) => m.oldDownloads) }], {
    x: 6.3, y: 1.5, w: 6.4, h: 4.3,
    barDir: "bar",
    barGapWidthPct: 45,
    chartColors: [HEX.accent2],
    showValue: true,
    dataLabelPosition: "outEnd",
    dataLabelColor: HEX.dk1,
    dataLabelFontSize: 11,
    dataLabelFontFace: "+mn-lt",
    showTitle: true,
    title: "mod ごとの修正前の版のダウンロード(括弧内は新しい版までの日数)",
    ...axisStyle,
    objectName: "1.0 の内訳",
  });
  text(s, "1.0 のあとは 1.0.1(10/30)、1.0.2(10/31)と修正版が続いた。大きな更新の直後は小さな修正が続くことが多いので、1.0.2 を待ってから直した。次の大きな更新で、すぐ直すか待つかを決める材料にする。", { x: 6.3, y: 5.9, w: 6.4, h: 0.9, fontSize: 12, color: C.text2 });
  notes(s, 6);
}

// ---- 8. 運用 ----
{
  const s = pres.addSlide({ masterName: "CONTENT" });
  s.addText("運用: 監視と費用", { placeholder: "title" });
  const rows = [
    [{ text: "アラート", options: { bold: true } }, { text: "メールで届く条件", options: { bold: true } }],
    ["取得ジョブの異常", "定時の取得が 48 時間成功していない / 取得・保存の失敗 / キャッシュの作り直しの失敗 / 費用の取得の失敗"],
    ["API の失敗", "5 分間に失敗したリクエストが 5 件を超えた"],
    ["DB の無料枠", "残りが 20% を下回った(使い切ると、その月の残りは DB が止まる)"],
  ];
  s.addTable(rows, {
    x: 0.6, y: 1.5, w: 6.2, colW: [1.7, 4.5],
    fontSize: 12, color: HEX.dk1, fontFace: FONT,
    border: { type: "solid", color: GRID, pt: 0.75 },
    fill: { color: HEX.lt1 },
    margin: 0.08,
    objectName: "アラート一覧",
  });
  card(s, 0.6, 4.35, 6.2, 2.25, "費用を下げた話");
  text(s, "費用のほとんどが監視だった", { x: 0.85, y: 4.5, w: 5.8, h: 0.4, fontSize: 16, bold: true });
  text(s, "ログ検索のアラートは、発火しなくても「本数 × 時間」で課金される(1 本で月約 75 円)。取得ジョブ関係の 3 本(月約 225 円)を 1 本の検索にまとめた(2026-09-24)。経緯は docs/ops-log.md に記録。", { x: 0.85, y: 4.95, w: 5.75, h: 1.5, fontSize: 13 });
  const days = D.costs.days;
  s.addChart(pres.ChartType.bar, [{ name: "費用(円)", labels: days.map((d) => md(d.date)), values: days.map((d) => d.total) }], {
    x: 7.1, y: 1.5, w: 5.6, h: 3.9,
    barDir: "col",
    barGapWidthPct: 30,
    chartColors: [HEX.accent1],
    showTitle: true,
    title: "このシステムの運用費用(円/日)",
    catAxisLabelFrequency: 14,
    ...axisStyle,
    objectName: "日別の費用",
  });
  stat(s, 7.1, 5.4, 2.6, `${D.costs.byMonth["2026-10"]} 円`, "10 月の運用費用", C.accent1, 40);
  text(s, "Azure for Students の範囲で、無料枠を中心に運用", { x: 9.8, y: 5.75, w: 2.9, h: 0.8, fontSize: 12, color: C.text2 });
  notes(s, 7);
}

// ---- 9. 開発の進め方 ----
{
  const s = pres.addSlide({ masterName: "CONTENT" });
  s.addText("開発の進め方", { placeholder: "title" });
  const flow = [
    ["Issue", "解決すること、理由、\nできたと言える条件"],
    ["ブランチ", "feat/ fix/ docs/ chore/"],
    ["コミット", "1 つの変更ずつ、\n理由を書く"],
    ["Pull Request", "テストを自動で実行"],
    ["マージ", "main に入ると\n自動でデプロイ"],
  ];
  const w = 2.15, gap = 0.34;
  flow.forEach(([h, b], i) => {
    const x = 0.6 + i * (w + gap);
    card(s, x, 1.6, w, 1.7, `進め方-${h}`);
    text(s, h, { x: x + 0.18, y: 1.78, w: w - 0.3, h: 0.45, fontSize: 16, bold: true });
    text(s, b, { x: x + 0.18, y: 2.3, w: w - 0.3, h: 0.9, fontSize: 12, color: C.text2 });
    if (i < flow.length - 1) arrow(s, x + w + 0.04, 2.45, x + w + gap - 0.04, 2.45);
  });
  stat(s, 0.6, 3.9, 3.0, "24 件", "完了した Issue(2026/11/07 時点)", C.text1, 40);
  stat(s, 3.9, 3.9, 3.0, "26 件", "マージした Pull Request", C.text1, 40);
  text(s, "数値の扱いの決めごと(「1 日」の区切り、取得に失敗した回の扱い、公開の前後の数え方など)は、README と各モジュールの先頭に書いている。", { x: 7.2, y: 3.95, w: 5.5, h: 1.6, fontSize: 14 });
}

// ---- 10. スケジュールと今後 ----
{
  const s = pres.addSlide({ masterName: "CONTENT" });
  s.addText("スケジュールと今後", { placeholder: "title" });
  const marks = [
    ["2026/09", "運用開始", 0],
    ["2026/11", "企画書・発表", 2],
    ["2026/12", "作品展", 3],
    ["2027/01", "就職作品エントリー", 4],
    ["2027/09", "Azure の学生枠が終わる", 12],
  ];
  const x0 = 1.0, unit = 0.9, y = 2.4;
  s.addShape(pres.ShapeType.line, { x: x0, y, w: unit * 12, h: 0, line: { color: HEX.dk1, width: 2 } });
  marks.forEach(([d, what, m], i) => {
    const x = x0 + unit * m;
    s.addShape(pres.ShapeType.ellipse, { x: x - 0.1, y: y - 0.1, w: 0.2, h: 0.2, fill: { color: i === 4 ? HEX.accent2 : i === 1 ? HEX.accent1 : HEX.dk1 }, line: { color: HEX.lt2, width: 1 } });
    const below = i % 2 === 1;
    // 右端のラベルは右寄せにして、スライドからはみ出さないようにする
    const last = i === marks.length - 1;
    const lx = last ? x - 2.1 : x - 1.1;
    const align = last ? "right" : "center";
    text(s, d, { x: lx, y: below ? y + 0.25 : y - 0.85, w: 2.2, h: 0.3, fontSize: 14, bold: true, align });
    text(s, what, { x: lx, y: below ? y + 0.55 : y - 0.55, w: 2.2, h: 0.3, fontSize: 12, color: C.text2, align });
  });
  const tasks = [
    ["データベースへの接続からパスワードをなくす", "接続文字列のパスワードをやめ、マネージド ID で接続する(配置と運用費用の取得はすでに鍵を置かない形)"],
    ["静的ファイルへの書き出し", "利用枠が終わる前に、API の応答を静的なファイルに書き出し、費用をかけずに公開を続けられるようにする"],
    ["1.0 の事例を README にまとめる", "ゲームの更新 → 修正 → 利用者の移行までを、作品展で説明できる形にする"],
  ];
  tasks.forEach(([h, b], i) => {
    const yy = 3.75 + i * 1.0;
    card(s, 0.6, yy, 12.1, 0.85, `今後-${i}`);
    text(s, h, { x: 0.85, y: yy + 0.12, w: 4.9, h: 0.6, fontSize: 15, bold: true, valign: "middle" });
    text(s, b, { x: 5.9, y: yy + 0.12, w: 6.6, h: 0.6, fontSize: 13, color: C.text2, valign: "middle" });
  });
  notes(s, 8);
}

// ---- 11. まとめ ----
{
  const s = pres.addSlide({ masterName: "COVER" });
  s.addText([{ text: "Mod " }, { text: "Insight", options: { color: C.accent1 } }], { placeholder: "title" });
  s.addText("ゲームの更新から mod の修正までを\n毎日の数字で追う", { placeholder: "body" });
  text(s, "ダッシュボード: insight.ryuka.cloud\nソースコード: github.com/ryuka-dev/Mod-Insight", { x: 0.8, y: 4.4, w: 8, h: 0.9, fontSize: 16, color: C.text2, paraSpaceAfter: 4 });
  text(s, "HAL 東京 情報処理学科", { x: 0.8, y: 5.6, w: 6, h: 0.4, fontSize: 16 });
  notes(s, 9);
}

// ---- 書き出しと、テーマの色・日本語フォントの設定 ----

await mkdir(OUT_DIR, { recursive: true });
await pres.writeFile({ fileName: OUT });

// pptxgenjs はテーマの色を書けず、日本語のフォント(ea)も空のままなので、theme1.xml を直接書き換える
const zip = await JSZip.loadAsync(await readFile(OUT));
const part = "ppt/theme/theme1.xml";
let xml = await zip.file(part).async("string");
const slots = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
const scheme = `<a:clrScheme name="${THEME.name}">` + slots.map((k) => `<a:${k}><a:srgbClr val="${THEME.colors[k]}"/></a:${k}>`).join("") + "</a:clrScheme>";
xml = xml.replace(/<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/, () => scheme);
xml = xml.replace(/<a:ea typeface="[^"]*"\s*\/>/g, `<a:ea typeface="${FONT}"/>`);
if (!xml.includes(scheme)) throw new Error("theme1.xml の色を書き換えられなかった");
zip.file(part, xml);
// 書き戻すときにフォルダーの項目を入れない(クラウド上で開けなくなることがあるため)
const out = new JSZip();
for (const [name, entry] of Object.entries(zip.files)) {
  if (!entry.dir) out.file(name, await entry.async("uint8array"), { createFolders: false });
}
await writeFile(OUT, await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(`書き出し: ${OUT}`);
