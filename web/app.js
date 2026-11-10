// ============================================================
// app.js
//
// ダッシュボードの動作をすべて担当するファイル。
// フレームワークは使わず、素の JavaScript だけで書いている。
//
// 流れ:
//   1. 起動時に GET /api/mods で mod 一覧を取り、選択中のプラットフォームのものをセレクトボックスに入れる
//   2. プラットフォームか期間が変わるたびに GET /api/overview?platform= で全 mod の一覧を取り直す
//      (合計の推移と日ごとの増加もこの応答に入っている)
//   3. mod か期間が変わるたびに、その mod の
//        GET /api/mods/{id}/summary            (今の数字)
//        GET /api/mods/{id}/snapshots          (時系列。期間は ?from= で絞る)
//        GET /api/mods/{id}/versions           (バージョン履歴)
//        GET /api/mods/{id}/version-snapshots  (バージョンごとの時系列)
//        GET /api/mods/{id}/releases           (公開の前後。期間に関係なく全期間から計算される)
//      を同時に取りに行き、揃ったら画面を描き直す
//   4. GET /api/fetch/logs と GET /api/costs は mod に関係ないので起動時に 1 回だけ取る
//   5. GET /api/events(ゲームのアップデートなど外部の出来事)も起動時に 1 回だけ取り、
//      合計の推移・日ごとの増加・mod のダウンロード数のグラフに縦線で重ねる
//   6. GET /api/event-impacts?platform=(ゲーム更新ごとの mod の対応状況)は起動時と
//      プラットフォームが変わった時に取る(期間には関係しない)
//
// 画面に出す文字列はすべて textContent で入れる(API から来た文字列を
// innerHTML に入れると、万一 HTML が混ざっていたときにそのまま実行されてしまうため)。
// ============================================================

const API_BASE = window.MOD_INSIGHT_CONFIG.apiBaseUrl;

// 表示期間ボタンの値(日数)。"all" は絞り込みなし
const RANGE_PRESETS = { "7": 7, "30": 30, "90": 90, "all": null };

// バージョン別グラフで個別に表示するバージョンの数(それより古いものは「その他」)
const VERSION_SERIES_LIMIT = 4;

// プラットフォームごとの表示文言。値は API の mods.platform と同じ文字列
// rating は snapshots.rating_score の意味がプラットフォームで違うので、ラベルを切り替える
const PLATFORM_LABELS = {
  thunderstore: {
    name: "Thunderstore",
    rating: "評価",
    ratingSub: "Thunderstore の rating_score",
    downloadsNote: "灰色の細い縦線(v1.2.3 などの名前つき)はバージョンの公開日。ほかの縦線はゲーム本体の出来事で、「日ごとの増加」の下に一覧があります。数値は Thunderstore の CDN キャッシュの影響で 1〜2 件程度上下することがあります。",
  },
  nexusmods: {
    name: "Nexus Mods",
    rating: "推薦数",
    ratingSub: "Nexus Mods の endorsements",
    downloadsNote: "灰色の細い縦線(v1.2.3 などの名前つき)はバージョン(ファイル)の公開日。ほかの縦線はゲーム本体の出来事で、「日ごとの増加」の下に一覧があります。Nexus Mods はファイル単位でダウンロード数を数えるため、同じバージョン番号のファイルは合算しています。",
  },
};

// 今画面に表示している状態。描画関数はすべてここを見る
const state = {
  platform: "thunderstore",  // 選択中のプラットフォーム(PLATFORM_LABELS のキー)
  mods: [],              // mod 一覧(全プラットフォーム)
  modId: null,           // 選択中の mod_id
  rangeDays: 30,         // 選択中の期間(日数)。null なら全期間
  rangeFrom: null,       // 選択中の期間の開始時刻(ミリ秒)。全期間なら null。loadMod / loadOverview が設定する
  overview: null,        // overview API の結果
  allOverview: null,     // 絞り込みなし(全プラットフォーム・全期間)の overview API の結果。ヘッダーの 1 行用(取れなければ null)
  summary: null,         // summary API の結果
  snapshots: [],         // snapshots API の結果(古い順)
  versions: [],          // versions API の結果(新しい順)
  versionSnapshots: [],  // version-snapshots API の結果(古い順)
  releases: [],          // releases API の結果(新しい公開が先)
  costs: null,           // costs API の結果(取れなければ null)
  events: [],            // events API の結果(古い順。取れなければ空のまま)
  eventImpacts: [],      // event-impacts API の結果(新しい更新が先。取れなければ空のまま)
  eventImpactId: null,   // 「ゲーム更新への対応」で選択中の更新の event_id
};

// 出来事の種類(events.kind)ごとの、グラフの縦線の描き方と一覧での呼び名
//   color  線の色(CSS 変数の名前)
//   width  線の太さ(px)
//   dash   破線のパターン [線の長さ, すき間](空なら実線)
//   label  一覧に出す種類の名前
// 大型アップデートを一番目立たせ、パッチ、お知らせ・メモの順に控えめにする
// (一覧の線の見本は style.css の .event-swatch-○○ で、同じ色・破線にそろえている)
const EVENT_KINDS = {
  game_major: { color: "--event-strong", width: 2, dash: [], label: "大型アップデート" },
  game_patch: { color: "--event-strong", width: 1.5, dash: [6, 4], label: "パッチ" },
  game_news: { color: "--event-subtle", width: 1.5, dash: [2, 3], label: "お知らせ" },
  note: { color: "--event-subtle", width: 1.5, dash: [2, 3], label: "メモ" },
};

// 日本時間と UTC の差(ミリ秒)
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// Chart.js のインスタンス。描き直すときは destroy してから作り直す
const charts = {
  totals: null,     // 全 mod 合計の推移
  daily: null,      // 全 mod の日ごとの増加
  downloads: null,  // 選択中 mod のダウンロード数推移
  versions: null,   // 選択中 mod のバージョン別積み上げ
  releaseShare: null,  // 選択中 mod の公開後の新しい版の割合
  costs: null,      // 運用費用のサービス別積み上げ
};

// ---- 画面の要素をまとめて取得 ----
const el = {
  modSelect: document.getElementById("modSelect"),
  platformButtons: document.querySelectorAll(".platform-buttons button"),
  rangeButtons: document.querySelectorAll(".range-buttons button"),
  errorBox: document.getElementById("errorBox"),
  pageFacts: document.getElementById("pageFacts"),
  content: document.getElementById("content"),
  // 全 mod の一覧
  ovTotal: document.getElementById("ovTotal"),
  ovTotalSub: document.getElementById("ovTotalSub"),
  ovDelta: document.getElementById("ovDelta"),
  ovDeltaSub: document.getElementById("ovDeltaSub"),
  ovModCount: document.getElementById("ovModCount"),
  ovPlatformName: document.getElementById("ovPlatformName"),
  ovRatingHead: document.getElementById("ovRatingHead"),
  totalsCanvas: document.getElementById("totalsChart"),
  overviewTableBody: document.querySelector("#overviewTable tbody"),
  // 日ごとの増加
  dailyCanvas: document.getElementById("dailyChart"),
  dailyTableBody: document.querySelector("#dailyTable tbody"),
  // 期間内の出来事
  eventSection: document.getElementById("eventSection"),
  eventList: document.getElementById("eventList"),
  // ゲーム更新への対応
  eventImpactCard: document.getElementById("eventImpactCard"),
  eventImpactSelect: document.getElementById("eventImpactSelect"),
  eventImpactSummary: document.getElementById("eventImpactSummary"),
  eventImpactBasisNote: document.getElementById("eventImpactBasisNote"),
  eventImpactMainTitle: document.getElementById("eventImpactMainTitle"),
  eventImpactEmptyNote: document.getElementById("eventImpactEmptyNote"),
  eventImpactMainWrap: document.getElementById("eventImpactMainWrap"),
  eventImpactFixHead: document.getElementById("eventImpactFixHead"),
  eventImpactTableBody: document.querySelector("#eventImpactTable tbody"),
  eventImpactOtherDetails: document.getElementById("eventImpactOtherDetails"),
  eventImpactOtherSummary: document.getElementById("eventImpactOtherSummary"),
  eventImpactOtherTableBody: document.querySelector("#eventImpactOtherTable tbody"),
  // 選択中 mod の詳細
  detailTitle: document.getElementById("detailTitle"),
  statDownloads: document.getElementById("statDownloads"),
  statCapturedAt: document.getElementById("statCapturedAt"),
  statDelta: document.getElementById("statDelta"),
  statDeltaSub: document.getElementById("statDeltaSub"),
  statRatingHead: document.getElementById("statRatingHead"),
  statRating: document.getElementById("statRating"),
  statRatingSub: document.getElementById("statRatingSub"),
  statVersion: document.getElementById("statVersion"),
  statVersionSub: document.getElementById("statVersionSub"),
  downloadsNote: document.getElementById("downloadsNote"),
  downloadsCanvas: document.getElementById("downloadsChart"),
  snapshotRatingHead: document.getElementById("snapshotRatingHead"),
  snapshotTableBody: document.querySelector("#snapshotTable tbody"),
  versionsCanvas: document.getElementById("versionsChart"),
  versionSnapshotTableHead: document.querySelector("#versionSnapshotTable thead"),
  versionSnapshotTableBody: document.querySelector("#versionSnapshotTable tbody"),
  versionTableBody: document.querySelector("#versionTable tbody"),
  releaseTableBody: document.querySelector("#releaseTable tbody"),
  releaseShareCanvas: document.getElementById("releaseShareChart"),
  // 運用状況
  costAverage: document.getElementById("costAverage"),
  costAverageSub: document.getElementById("costAverageSub"),
  costMonthly: document.getElementById("costMonthly"),
  costMonthTotal: document.getElementById("costMonthTotal"),
  costMonthTotalSub: document.getElementById("costMonthTotalSub"),
  costZeroNote: document.getElementById("costZeroNote"),
  costCanvas: document.getElementById("costChart"),
  costTableBody: document.querySelector("#costTable tbody"),
  logTableBody: document.querySelector("#logTable tbody"),
};

// ============================================================
// 共通の小さな道具
// ============================================================

// API を呼んで JSON を返す。HTTP エラーのときは API の { error } を含めた例外を投げる
async function fetchJson(path) {
  const response = await fetch(API_BASE + path);
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body && body.error) {
        message += `: ${body.error}`;
      }
    } catch (_) {
      // 本文が JSON でなければステータスだけで十分
    }
    throw new Error(message);
  }
  return response.json();
}

// 3,710 のように桁区切りで表示する
function formatNumber(value) {
  if (value === null || value === undefined) {
    return "–";
  }
  return Number(value).toLocaleString("ja-JP");
}

// +25 / -3 / ±0 のように符号つきで表示する
function formatSigned(value) {
  if (value === null || value === undefined) return "–";
  if (value > 0) return `+${formatNumber(value)}`;
  if (value < 0) return `−${formatNumber(Math.abs(value))}`;
  return "±0";
}

// ISO 文字列 → "2026/09/14 15:00"(見ている人のタイムゾーン)
function formatDateTime(iso) {
  const date = new Date(iso);
  return date.toLocaleString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

// ISO 文字列 → "2026/09/14"(日付だけ。バージョン公開日など時刻が意味を持たないもの用)
function formatDate(iso) {
  const date = new Date(iso);
  return date.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" });
}

// CSS 変数の値を読む(グラフの色を style.css と揃えるため)
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// 期間の開始 → snapshots 系 API の ?from= 文字列("" なら絞り込みなし)
function rangeQuery() {
  if (state.rangeFrom === null) {
    return "";
  }
  return `?from=${encodeURIComponent(new Date(state.rangeFrom).toISOString())}`;
}

// overview API 用のクエリ文字列(プラットフォーム + 期間)
function overviewQuery() {
  const params = new URLSearchParams();
  params.set("platform", state.platform);
  if (state.rangeFrom !== null) {
    params.set("from", new Date(state.rangeFrom).toISOString());
  }
  return `?${params.toString()}`;
}

// 選択中のプラットフォームの表示文言
function platformLabels() {
  return PLATFORM_LABELS[state.platform];
}

// エラー表示の出し入れ
function showError(message) {
  el.errorBox.textContent = message;
  el.errorBox.hidden = false;
}
function clearError() {
  el.errorBox.hidden = true;
}

// 表の中身を空にする
function clearTable(tbody) {
  while (tbody.firstChild) {
    tbody.removeChild(tbody.firstChild);
  }
}

// <td> を作る。className は省略可
function makeCell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) {
    td.className = className;
  }
  return td;
}

// 「データなし」の 1 行を表に入れる
function appendEmptyRow(tbody, columnCount, message) {
  const tr = document.createElement("tr");
  const td = makeCell(message, "empty");
  td.colSpan = columnCount;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

// 増減の値を表示用の要素に入れる(増えていれば緑にする)
function setDeltaValue(element, delta) {
  element.classList.remove("is-up");
  element.textContent = formatSigned(delta);
  if (delta > 0) {
    element.classList.add("is-up");
  }
}

// ============================================================
// グラフ共通の設定
// 3 つのグラフはどれも「横軸が時間」なので、軸の設定をここにまとめている
// ============================================================

// 横軸(時間)の設定
function timeAxisOptions() {
  return {
    type: "time",
    min: state.rangeFrom === null ? undefined : state.rangeFrom,  // 全期間ならデータに任せる
    time: {
      unit: "day",
      displayFormats: { day: "M/d" },
      tooltipFormat: "yyyy/MM/dd HH:mm",
    },
    grid: { display: false },
    ticks: { color: cssVar("--text-muted"), maxRotation: 0 },
    border: { color: cssVar("--grid") },
  };
}

// 縦軸(件数)の設定
function countAxisOptions() {
  return {
    grid: { color: cssVar("--grid") },
    ticks: {
      color: cssVar("--text-muted"),
      precision: 0,  // ダウンロード数は整数なので 476.8 のような目盛りを出さない
      callback: (value) => formatNumber(value),
    },
    border: { display: false },
  };
}

// 1 本の折れ線データセットを作る(合計の推移と mod 別の推移で共通)
function lineDataset(label, points) {
  return {
    label: label,
    data: points,
    borderColor: cssVar("--series-1"),
    backgroundColor: cssVar("--series-1-wash"),
    fill: true,
    borderWidth: 2,
    pointRadius: 4,
    pointHoverRadius: 6,
    pointBackgroundColor: cssVar("--series-1"),
    pointBorderColor: cssVar("--surface"),
    pointBorderWidth: 2,
    tension: 0,
  };
}

// Chart.js プラグイン: マウス位置に縦の細い線(クロスヘア)を出す
const crosshairPlugin = {
  id: "crosshair",
  afterDraw(chartInstance) {
    const active = chartInstance.tooltip && chartInstance.tooltip.getActiveElements();
    if (!active || active.length === 0) {
      return;
    }
    const x = active[0].element.x;
    const yScale = chartInstance.scales.y;
    const ctx = chartInstance.ctx;
    ctx.save();
    ctx.strokeStyle = cssVar("--text-muted");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yScale.top);
    ctx.lineTo(x, yScale.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// Chart.js プラグイン: バージョン公開日に縦線と小さなラベルを描く
// (Chart.js の描画のあとに呼ばれる afterDraw で、キャンバスに直接線を引いている)
const versionMarkerPlugin = {
  id: "versionMarker",
  afterDraw(chartInstance) {
    const xScale = chartInstance.scales.x;
    const yScale = chartInstance.scales.y;
    if (!xScale || !yScale) {
      return;
    }
    const ctx = chartInstance.ctx;
    ctx.save();
    ctx.strokeStyle = cssVar("--marker");
    ctx.fillStyle = cssVar("--text-muted");
    ctx.lineWidth = 1;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";

    for (const version of state.versions) {
      const time = new Date(version.release_date).getTime();
      // 表示中の範囲の外にあるバージョンは描かない
      if (time < xScale.min || time > xScale.max) {
        continue;
      }
      const x = xScale.getPixelForValue(time);
      ctx.beginPath();
      ctx.moveTo(x, yScale.top);
      ctx.lineTo(x, yScale.bottom);
      ctx.stroke();
      ctx.fillText(`v${version.version_number}`, x + 4, yScale.top + 12);
    }
    ctx.restore();
  },
};

// 出来事の種類 → 描き方と呼び名(EVENT_KINDS)。知らない種類が来たら一番控えめな「メモ」として扱う
function eventKind(kind) {
  return EVENT_KINDS[kind] || EVENT_KINDS.note;
}

// 出来事の日時(ISO 文字列)→ 日本時間で何日の出来事か("YYYY-MM-DD")
// 例: 2026-10-28T13:06:51Z は日本時間 10/28 22:06 なので "2026-10-28"
function jstDateKey(iso) {
  return new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString().slice(0, 10);
}

// 大型アップデートの縦線の横に見出しを書く
// 入力: ctx(キャンバス)、text(見出し)、x(縦線の位置 px)、xScale / yScale(グラフの軸)
// 線の左側に右寄せで書く(同じ日のバージョンの名前は線の右側に出るので重ならない)。
// 左に入りきらない時だけ右側に書く。文字の後ろを背景色で塗り、折れ線と重なっても読めるようにする
function drawEventLabel(ctx, text, x, xScale, yScale) {
  const width = ctx.measureText(text).width;
  const y = yScale.top + 12;
  const left = x - 6 - width >= xScale.left ? x - 6 - width : x + 6;
  ctx.fillStyle = cssVar("--surface");
  ctx.fillRect(left - 2, y - 10, width + 4, 14);
  ctx.fillStyle = cssVar("--text-secondary");
  ctx.textAlign = "left";
  ctx.fillText(text, left, y);
}

// Chart.js プラグイン: 外部の出来事(ゲームのアップデートなど)の日時に縦線を描く
// グラフごとの設定は options.plugins.eventMarker で渡す(Chart.js がフックの 3 つ目の引数 options に入れてくれる):
//   modId       この mod に関する出来事も描く。null ならゲーム全体の出来事(mod_id が null)だけ
//   alignToDay  true なら出来事を日本時間のその日の棒の位置に置く(日ごとの増加の棒グラフ用)。
//               false なら出来事の時刻そのままの位置に置く
// バージョン公開日の線(versionMarkerPlugin、灰色の細い実線)と見分けられるよう、色・太さ・破線を変えている。
// 見出しは大型アップデートだけに付ける(パッチは数日のうちに続けて出ることがあり、文字が重なるため)。
// ほかの出来事は「日ごとの増加」の下の一覧(renderEventList)で説明する。
// afterDatasetsDraw(データを描いた直後)で描くので、マウスを乗せた時のツールチップは線より手前に出る
const eventMarkerPlugin = {
  id: "eventMarker",
  afterDatasetsDraw(chartInstance, args, options) {
    const xScale = chartInstance.scales.x;
    const yScale = chartInstance.scales.y;
    if (!xScale || !yScale || state.events.length === 0) {
      return;
    }
    const ctx = chartInstance.ctx;
    ctx.save();
    ctx.font = "11px system-ui, sans-serif";

    for (const event of state.events) {
      // 特定の mod の出来事は、その mod のグラフにだけ描く
      if (event.mod_id !== null && event.mod_id !== options.modId) {
        continue;
      }
      const time = options.alignToDay
        ? dailyPointTime(jstDateKey(event.occurred_at))
        : Date.parse(event.occurred_at);
      // 表示中の範囲の外にある出来事は描かない(日時が読めず NaN になったものもここで外れる)
      if (!(time >= xScale.min && time <= xScale.max)) {
        continue;
      }
      const x = xScale.getPixelForValue(time);
      const kind = eventKind(event.kind);
      ctx.strokeStyle = cssVar(kind.color);
      ctx.lineWidth = kind.width;
      ctx.setLineDash(kind.dash);
      ctx.beginPath();
      ctx.moveTo(x, yScale.top);
      ctx.lineTo(x, yScale.bottom);
      ctx.stroke();
      if (event.kind === "game_major") {
        ctx.setLineDash([]);
        drawEventLabel(ctx, event.title, x, xScale, yScale);
      }
    }
    ctx.restore();
  },
};

// ============================================================
// データ取得
// ============================================================

// 期間ボタンの状態から state.rangeFrom を計算する
function updateRangeFrom() {
  if (state.rangeDays === null) {
    state.rangeFrom = null;
    return;
  }
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - state.rangeDays);
  state.rangeFrom = from.getTime();
}

// 全 mod の一覧を取り直して描画する
async function loadOverview() {
  try {
    state.overview = await fetchJson(`/overview${overviewQuery()}`);
    renderOverviewTiles();
    renderTotalsChart();
    renderOverviewTable();
    renderDailyChart();
    renderDailyTable();
    renderEventList();
  } catch (err) {
    showError(`全 mod の一覧の取得に失敗しました(${err.message})`);
  }
}

// 選択中の mod と期間に合わせて 4 つの API を同時に呼び、state を更新して描画する
async function loadMod() {
  if (state.modId === null) {
    return;
  }

  el.content.classList.add("is-loading");
  clearError();

  try {
    const query = rangeQuery();
    const [summary, snapshots, versions, versionSnapshots, releases] = await Promise.all([
      fetchJson(`/mods/${state.modId}/summary`),
      fetchJson(`/mods/${state.modId}/snapshots${query}`),
      fetchJson(`/mods/${state.modId}/versions`),
      fetchJson(`/mods/${state.modId}/version-snapshots${query}`),
      fetchJson(`/mods/${state.modId}/releases`),
    ]);
    state.summary = summary;
    state.snapshots = snapshots;
    state.versions = versions;
    state.versionSnapshots = versionSnapshots;
    state.releases = releases;

    renderDetailTitle();
    renderStats();
    renderDownloadsChart();
    renderSnapshotTable();
    renderVersionsChart();
    renderVersionSnapshotTable();
    renderReleaseTable();
    renderReleaseShareChart();
    renderVersionTable();
    highlightSelectedModRows();
  } catch (err) {
    showError(`データの取得に失敗しました(${err.message})`);
  } finally {
    el.content.classList.remove("is-loading");
  }
}

// 取得ジョブの実行記録(mod に依存しないので起動時に 1 回だけ。全プラットフォーム分をまとめて表示)
async function loadFetchLogs() {
  try {
    const logs = await fetchJson("/fetch/logs?limit=10");
    renderLogTable(logs);
  } catch (err) {
    clearTable(el.logTableBody);
    appendEmptyRow(el.logTableBody, 4, `取得できませんでした(${err.message})`);
  }
}

// 運用費用(mod にも期間にも関係ないので起動時に 1 回だけ)
async function loadCosts() {
  try {
    state.costs = await fetchJson("/costs");
  } catch (err) {
    state.costs = null;
    clearTable(el.costTableBody);
    appendEmptyRow(el.costTableBody, 3, `取得できませんでした(${err.message})`);
    el.costAverageSub.textContent = "データがまだありません";
    el.costCanvas.parentElement.hidden = true;  // 空のグラフの枠だけが残らないように隠す
    renderFacts();
    return;
  }
  el.costCanvas.parentElement.hidden = state.costs.days.length === 0;
  renderCostTiles();
  renderCostChart();
  renderCostTable();
  renderFacts();  // ヘッダーの 1 行にも費用を出す
}

// ヘッダーの 1 行の材料(全プラットフォーム・全期間の合計。画面の選択に関係ないので起動時に 1 回だけ)
// 失敗した時は 1 行を出さないだけで、ほかの表示は今までどおりにする(補足なので、エラーはコンソールにだけ残す)
async function loadFacts() {
  try {
    state.allOverview = await fetchJson("/overview");
  } catch (err) {
    console.warn(`全体の合計の取得に失敗したため、ヘッダーの 1 行は表示しません(${err.message})`);
    state.allOverview = null;
  }
  renderFacts();
}

// 外部の出来事(mod にも期間にも関係なく全件で数十件なので、起動時に 1 回だけ全部取る)
// 失敗した時(/api/events がまだ無い環境の 404 など)は出来事なしとして扱い、ほかの表示は今までどおりにする。
// グラフの補足情報なので、画面にエラーは出さずコンソールにだけ残す
async function loadEvents() {
  try {
    const events = await fetchJson("/events");
    state.events = Array.isArray(events) ? events : [];
  } catch (err) {
    console.warn(`出来事の取得に失敗したため、出来事なしで表示します(${err.message})`);
    state.events = [];
  }
  // グラフや一覧が先に描かれていたら、出来事を足して描き直す(後から描かれるものは描画時に state.events を見る)
  for (const chart of [charts.totals, charts.daily, charts.downloads]) {
    if (chart) {
      chart.update();
    }
  }
  if (state.overview) {
    renderEventList();
  }
}

// ゲーム更新ごとの mod の対応状況(選択中のプラットフォームの分。期間には関係しない)
// 失敗した時(/api/event-impacts がまだ無い環境の 404 など)や、対象の更新が 1 件も無い時はカードごと隠す。
// 補足の分析なので、画面にエラーは出さずコンソールにだけ残す(loadEvents と同じ扱い)
async function loadEventImpacts() {
  const platform = state.platform;
  let impacts;
  try {
    impacts = await fetchJson(`/event-impacts?platform=${encodeURIComponent(platform)}`);
  } catch (err) {
    console.warn(`ゲーム更新への対応の取得に失敗したため、表示しません(${err.message})`);
    impacts = [];
  }
  // 待っている間にプラットフォームが切り替わっていたら、古い応答は捨てる(新しいほうの応答で描く)
  if (platform !== state.platform) {
    return;
  }
  state.eventImpacts = Array.isArray(impacts) ? impacts : [];
  el.eventImpactCard.hidden = state.eventImpacts.length === 0;
  if (state.eventImpacts.length === 0) {
    return;
  }
  // 選んでいた更新がこのプラットフォームにもあればそのまま。無ければ最新の大型アップデート(無ければ最新の更新)
  if (!state.eventImpacts.some((impact) => impact.event_id === state.eventImpactId)) {
    const major = state.eventImpacts.find((impact) => impact.kind === "game_major");
    state.eventImpactId = (major || state.eventImpacts[0]).event_id;
  }
  fillEventImpactSelect();
  renderEventImpact();
}

// mod を切り替える(セレクトボックスと一覧表の行クリックの両方から呼ばれる)
function selectMod(modId) {
  state.modId = modId;
  el.modSelect.value = String(modId);
  window.location.hash = `mod=${modId}`;
  loadMod();
}

// セレクトボックスの中身を、選択中のプラットフォームの mod だけに入れ替える
function fillModSelect() {
  while (el.modSelect.firstChild) {
    el.modSelect.removeChild(el.modSelect.firstChild);
  }
  for (const mod of state.mods) {
    if (mod.platform !== state.platform) {
      continue;
    }
    const option = document.createElement("option");
    option.value = String(mod.mod_id);
    option.textContent = mod.name;
    el.modSelect.appendChild(option);
  }
}

// そのプラットフォームで最初に詳細を表示する mod(ダウンロード数が一番多いもの)の mod_id を返す
// 一覧(overview)はダウンロード数の多い順なので、その中でプラットフォームが合う先頭を使う。
// 一覧が取れなかった時は、名前順(mods API の順)の先頭で代用する
function defaultModId(platform) {
  const top = state.overview && state.overview.mods.find((m) => m.platform === platform);
  if (top) {
    return top.mod_id;
  }
  const first = state.mods.find((m) => m.platform === platform);
  return first ? first.mod_id : null;
}

// プラットフォームを切り替える(ボタンから呼ばれる。起動時は init が直接 state を設定する)
// 一覧・セレクトボックス・文言を切り替え、一覧を取り直してから、ダウンロード数が一番多い mod を選び直す
async function selectPlatform(platform) {
  state.platform = platform;
  for (const button of el.platformButtons) {
    button.classList.toggle("is-selected", button.dataset.platform === platform);
  }
  renderPlatformLabels();
  fillModSelect();
  loadEventImpacts();
  await loadOverview();

  const modId = defaultModId(platform);
  if (modId !== null) {
    selectMod(modId);
  }
}

// プラットフォームによって意味が変わる見出し・注記を書き換える
function renderPlatformLabels() {
  const labels = platformLabels();
  el.ovPlatformName.textContent = labels.name;
  el.ovRatingHead.textContent = labels.rating;
  el.statRatingHead.textContent = labels.rating;
  el.statRatingSub.textContent = labels.ratingSub;
  el.snapshotRatingHead.textContent = labels.rating;
  el.downloadsNote.textContent = labels.downloadsNote;
}

// ============================================================
// 描画: 全 mod の一覧
// ============================================================

function renderOverviewTiles() {
  const ov = state.overview;
  el.ovTotal.textContent = formatNumber(ov.total_downloads);
  el.ovTotalSub.textContent = ov.latest_captured_at ? `${formatDateTime(ov.latest_captured_at)} 時点` : "";
  setDeltaValue(el.ovDelta, ov.total_delta);
  el.ovDeltaSub.textContent = state.rangeFrom === null
    ? "最初の取得からの増加"
    : `${formatDate(new Date(state.rangeFrom).toISOString())} 以降の増加`;
  el.ovModCount.textContent = formatNumber(ov.mod_count);
}

// 全 mod 合計の推移(取得回ごとの合計)
function renderTotalsChart() {
  const points = state.overview.totals.map((t) => ({
    x: new Date(t.captured_at).getTime(),
    y: t.download_count,
  }));

  if (charts.totals) {
    charts.totals.destroy();
  }

  charts.totals = new Chart(el.totalsCanvas, {
    type: "line",
    data: { datasets: [lineDataset("合計ダウンロード数", points)] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => formatDateTime(items[0].parsed.x),
            label: (item) => `合計 ${formatNumber(item.parsed.y)} ダウンロード`,
          },
        },
        eventMarker: { modId: null, alignToDay: false },  // ゲーム全体の出来事だけを、時刻どおりの位置に
      },
      scales: { x: timeAxisOptions(), y: countAxisOptions() },
    },
    plugins: [eventMarkerPlugin, crosshairPlugin],
  });
}

// mod ごとの一覧表(ダウンロード数の多い順。行クリックで詳細を切り替えて、詳細までスクロールする)
function renderOverviewTable() {
  clearTable(el.overviewTableBody);
  const mods = state.overview.mods;
  if (mods.length === 0) {
    appendEmptyRow(el.overviewTableBody, 6, "追跡中の mod がありません");
    return;
  }

  for (const mod of mods) {
    const tr = document.createElement("tr");
    tr.dataset.modId = String(mod.mod_id);
    tr.appendChild(makeCell(mod.name));
    tr.appendChild(makeCell(formatNumber(mod.latest_download_count), "num"));
    const deltaCell = makeCell(formatSigned(mod.delta), "num");
    if (mod.delta > 0) {
      deltaCell.classList.add("status-good");
    }
    tr.appendChild(deltaCell);
    tr.appendChild(makeCell(formatNumber(mod.rating_score), "num"));
    tr.appendChild(makeCell(mod.latest_version ? `v${mod.latest_version}` : "–"));
    tr.appendChild(makeCell(mod.latest_release_date ? formatDate(mod.latest_release_date) : "–"));
    tr.addEventListener("click", () => {
      selectMod(mod.mod_id);
      // 詳細は表よりずっと下にあるので、切り替わったことが見えるようにそこまで動かす
      el.detailTitle.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    el.overviewTableBody.appendChild(tr);
  }
  highlightSelectedModRows();
}

// 一覧表と「ゲーム更新への対応」の 2 つの表の中で、いま詳細に表示している mod の行に印を付ける
function highlightSelectedModRows() {
  for (const tbody of [el.overviewTableBody, el.eventImpactTableBody, el.eventImpactOtherTableBody]) {
    for (const tr of tbody.querySelectorAll("tr")) {
      tr.classList.toggle("is-selected", tr.dataset.modId === String(state.modId));
    }
  }
}

// ============================================================
// 描画: 日ごとの増加
// ============================================================

// API の date("2026-09-23" = 日本時間 9/23 の増加)→ グラフの横軸の位置(ミリ秒)
// 日本時間のその日の 0 時に置く(横軸の日付の目盛りと棒の位置がそろう)
function dailyPointTime(date) {
  return Date.parse(`${date}T00:00:00+09:00`);
}

// 日ごとの増加の棒グラフと、7 日平均の折れ線(同じ単位なので縦軸は 1 本)
function renderDailyChart() {
  const daily = state.overview.daily;
  const barPoints = daily.map((d) => ({ x: dailyPointTime(d.date), y: d.increase }));
  const averagePoints = daily.map((d) => ({ x: dailyPointTime(d.date), y: d.average_7d }));

  if (charts.daily) {
    charts.daily.destroy();
  }

  charts.daily = new Chart(el.dailyCanvas, {
    data: {
      datasets: [
        {
          type: "bar",
          label: "その日の増加",
          data: barPoints,
          order: 1,
          backgroundColor: cssVar("--series-1"),
          maxBarThickness: 24,
          borderRadius: 4,
          borderSkipped: "start",  // 角丸は値の側だけ(0 の線の側は四角のまま)
        },
        {
          type: "line",
          label: "7 日平均",
          data: averagePoints,
          order: 0,  // order が小さいほど手前に描かれる(線を棒の上に出す)
          borderColor: cssVar("--series-2"),
          backgroundColor: cssVar("--series-2"),  // 凡例の四角を塗りつぶすため
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: cssVar("--series-2"),
          pointBorderColor: cssVar("--surface"),
          pointBorderWidth: 2,
          spanGaps: false,  // 平均が出ない日(null)は線を切る
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "top",
          align: "start",
          labels: {
            color: cssVar("--text-secondary"),
            boxWidth: 12,
            boxHeight: 12,
            sort: (a, b) => a.datasetIndex - b.datasetIndex,  // order ではなく datasets の並び(棒が先)で並べる
          },
        },
        tooltip: {
          itemSort: (a, b) => a.datasetIndex - b.datasetIndex,
          callbacks: {
            // 棒の時刻(日本時間の 0:00 = UTC の前日 15:00)から日付を逆算すると 1 日ずれるので、API の date をそのまま使う
            title: (items) => `${formatDate(`${daily[items[0].dataIndex].date}T00:00:00Z`)} の増加`,
            label: (item) => `${item.dataset.label}: ${item.parsed.y === null ? "–" : formatSigned(item.parsed.y)}`,
          },
        },
        eventMarker: { modId: null, alignToDay: true },  // ゲーム全体の出来事だけを、日本時間のその日の棒の位置に
      },
      scales: {
        x: { ...timeAxisOptions(), offset: true },  // offset: 両端の棒が半分切れないように余白を取る
        y: { ...countAxisOptions(), beginAtZero: true },
      },
    },
    plugins: [eventMarkerPlugin],
  });
}

// 日ごとの増加の表(新しい日が上)
function renderDailyTable() {
  clearTable(el.dailyTableBody);
  const daily = state.overview.daily;
  if (daily.length === 0) {
    appendEmptyRow(el.dailyTableBody, 4, "この期間のデータはありません");
    return;
  }
  for (const d of [...daily].reverse()) {
    const tr = document.createElement("tr");
    tr.appendChild(makeCell(formatDate(`${d.date}T00:00:00Z`)));
    tr.appendChild(makeCell(formatSigned(d.increase), "num"));
    tr.appendChild(makeCell(d.average_7d === null ? "–" : formatNumber(d.average_7d), "num"));
    tr.appendChild(makeCell(formatNumber(d.mod_count), "num"));
    el.dailyTableBody.appendChild(tr);
  }
}

// ============================================================
// 描画: 期間内の出来事
// ============================================================

// 一覧に出す出来事の期間の始まり(ミリ秒)
// 期間ボタンで選んだ開始。全期間なら記録の最初の取得日時(記録を始める前のお知らせまで並べないため)。
// 記録がまだ 1 件も無ければ null(絞り込まない)
function eventListFrom() {
  if (state.rangeFrom !== null) {
    return state.rangeFrom;
  }
  const totals = state.overview.totals;
  return totals.length > 0 ? Date.parse(totals[0].captured_at) : null;
}

// 期間内の出来事の一覧(新しい出来事が上)。グラフの縦線が何の印かを説明する
// 出すもの: ゲーム全体の出来事と、選択中の配布サイトの mod に関する出来事(mod の名前を添える)
// 1 件も無ければ、凡例ごと一覧を隠す
function renderEventList() {
  clearTable(el.eventList);
  const from = eventListFrom();
  const events = state.events.filter((event) => {
    if (from !== null && !(Date.parse(event.occurred_at) >= from)) {
      return false;
    }
    if (event.mod_id === null) {
      return true;
    }
    const mod = state.mods.find((m) => m.mod_id === event.mod_id);
    return mod !== undefined && mod.platform === state.platform;
  });

  el.eventSection.hidden = events.length === 0;

  for (const event of [...events].reverse()) {
    const li = document.createElement("li");

    // 線の見本(グラフの縦線と同じ色・破線)。知らない種類は「メモ」と同じ見た目にする
    const swatch = document.createElement("span");
    swatch.className = `event-swatch event-swatch-${EVENT_KINDS[event.kind] ? event.kind : "note"}`;
    li.appendChild(swatch);

    // 日付は日本時間(日ごとの増加の棒と同じ日になる)
    const date = document.createElement("span");
    date.className = "event-date";
    date.textContent = formatDate(`${jstDateKey(event.occurred_at)}T00:00:00Z`);
    li.appendChild(date);

    const kind = document.createElement("span");
    kind.className = "event-kind";
    kind.textContent = eventKind(event.kind).label;
    li.appendChild(kind);

    // 見出し。詳細のページがあれば新しいタブで開くリンクにする
    // (rel="noopener noreferrer": 開いた先のページにこのページを操作させず、参照元も送らない)
    if (event.url) {
      const link = document.createElement("a");
      link.href = event.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = event.title;
      li.appendChild(link);
    } else {
      const title = document.createElement("span");
      title.textContent = event.title;
      li.appendChild(title);
    }

    // 特定の mod の出来事なら、どの mod かを添える
    if (event.mod_id !== null) {
      const mod = state.mods.find((m) => m.mod_id === event.mod_id);
      const modName = document.createElement("span");
      modName.className = "event-mod";
      modName.textContent = `(${mod.name})`;
      li.appendChild(modName);
    }

    el.eventList.appendChild(li);
  }
}

// ============================================================
// 描画: ヘッダーの 1 行(だれが、いつから、どの規模で動かしているか)
// ============================================================

// 費用の記録がそろっている最後の月("YYYY-MM")。記録が無ければ null
// 入力: days(costs API の days = [{ date: "YYYY-MM-DD", total }, ...]、古い順)
// 記録の最後の日がある月は、まだ月の途中か、日別の値が確定していない日が残っているので使わず、その前の月を返す
function lastFullCostMonth(days) {
  if (days.length === 0) {
    return null;
  }
  const [year, month] = days[days.length - 1].date.split("-").map(Number);
  // Date の月は 0 始まりなので、month - 2 が「前の月」(1 月なら前の年の 12 月になる)
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}

// ヘッダーの 1 行を作る。loadFacts と loadCosts のどちらが後に終わっても正しく出るよう、両方の最後で呼ぶ
// 例: ひとりで開発し、2026 年 9 月から毎日動かしています。公開中の mod は Thunderstore 26 本・Nexus Mods 26 本、
//     ダウンロードは合わせて 54,152 回、10 月の運用費用は約 95 円です。
function renderFacts() {
  const overview = state.allOverview;
  if (!overview || overview.totals.length === 0) {
    el.pageFacts.hidden = true;
    return;
  }

  // いつから: 最初の取得の日(日本時間)の年と月
  const [startYear, startMonth] = jstDateKey(overview.totals[0].captured_at).split("-").map(Number);

  // 公開中の mod の数を配布サイトごとに("Thunderstore 26 本" の形。PLATFORM_LABELS の順)
  const counts = [];
  for (const platform of Object.keys(PLATFORM_LABELS)) {
    const count = overview.mods.filter((mod) => mod.platform === platform).length;
    if (count > 0) {
      counts.push(`${PLATFORM_LABELS[platform].name} ${formatNumber(count)} 本`);
    }
  }

  // 費用: 記録がそろっている最後の月の合計。費用が取れていない時や、その月の記録が無い時は省く
  let costText = "";
  const costMonth = state.costs ? lastFullCostMonth(state.costs.days) : null;
  if (costMonth !== null) {
    const monthDays = state.costs.days.filter((day) => day.date.startsWith(costMonth));
    if (monthDays.length > 0) {
      const total = monthDays.reduce((sum, day) => sum + day.total, 0);
      const amount = state.costs.currency === "JPY"
        ? `${formatNumber(Math.round(total))} 円`
        : `${total.toFixed(2)} ${state.costs.currency}`;
      costText = `、${Number(costMonth.slice(5))} 月の運用費用は約 ${amount}`;
    }
  }

  el.pageFacts.textContent =
    `ひとりで開発し、${startYear} 年 ${startMonth} 月から毎日動かしています。`
    + `公開中の mod は ${counts.join("・")}、ダウンロードは合わせて ${formatNumber(overview.total_downloads)} 回${costText}です。`;
  el.pageFacts.hidden = false;
}

// ============================================================
// 描画: ゲーム更新への対応
// ============================================================

// 選択中の更新(state.eventImpactId)の結果。見つからなければ null
function selectedEventImpact() {
  return state.eventImpacts.find((impact) => impact.event_id === state.eventImpactId) || null;
}

// 更新を選ぶセレクトボックスの中身を入れ替える("2026/10/28 大型アップデート SULFUR 1.0 OUT NOW" の形)
function fillEventImpactSelect() {
  while (el.eventImpactSelect.firstChild) {
    el.eventImpactSelect.removeChild(el.eventImpactSelect.firstChild);
  }
  for (const impact of state.eventImpacts) {
    const option = document.createElement("option");
    option.value = String(impact.event_id);
    option.textContent = `${formatDate(`${impact.day}T00:00:00Z`)} ${eventKind(impact.kind).label} ${impact.title}`;
    el.eventImpactSelect.appendChild(option);
  }
  el.eventImpactSelect.value = String(state.eventImpactId);
}

// 合計の数字のタイルを 1 つ作る(見出し、大きな数字、補足の 3 行。ほかのカードのタイルと同じ見た目)
function makeStatTile(label, value, sub) {
  const tile = document.createElement("div");
  tile.className = "stat-tile";
  for (const [className, text] of [["stat-label", label], ["stat-value", value], ["stat-sub", sub]]) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    tile.appendChild(span);
  }
  return tile;
}

// 新しい版の最初の 2 日。翌日の記録がまだ無ければ "31(1 日)" のように足した日数を添える
function formatFirstTwoDays(row) {
  if (row.next_first_2_days === null) {
    return "–";
  }
  const days = row.next_days_counted < 2 ? `(${row.next_days_counted} 日)` : "";
  return `${formatNumber(row.next_first_2_days)}${days}`;
}

// 更新後に出した版(旧版以外)がその日のダウンロードの 90% を超えるまでの日数の表示
// 0 = 次の版が初めて記録に現れた日のうちに超えた。新しい版はあるのに null なら、まだ(または 14 日以内に)超えていない
function formatDaysTo90(row) {
  if (row.next_version === null) {
    return "–";
  }
  if (row.days_to_90pct === null) {
    return "未達";
  }
  return row.days_to_90pct === 0 ? "当日" : `${row.days_to_90pct} 日後`;
}

// 修正が必要だったか(needs_fix)の表示。必要な mod だけ少し強調する
function makeNeedsFixCell(needsFix) {
  if (needsFix === true) {
    return makeCell("必要", "needs-fix");
  }
  return makeCell(needsFix === false ? "不要" : "未確認", "needs-fix-none");
}

// 「ゲーム更新への対応」の表の 1 行を作る
// 入力: row(API の mods の 1 件)、withFixCell(「修正」の列を入れるか)
// 出力: tr 要素(クリックすると下の詳細がその mod に切り替わる)
function makeEventImpactRow(row, withFixCell) {
  const tr = document.createElement("tr");
  tr.dataset.modId = String(row.mod_id);
  tr.appendChild(makeCell(row.name));
  if (withFixCell) {
    tr.appendChild(makeNeedsFixCell(row.needs_fix));
  }
  tr.appendChild(makeCell(`v${row.version_at_event}`));
  if (row.next_version === null) {
    tr.appendChild(makeCell("なし", "not-released"));
    tr.appendChild(makeCell("–"));
    tr.appendChild(makeCell("–", "num"));
  } else {
    tr.appendChild(makeCell(`v${row.next_version}`));
    // 公開した日(next_day)。この項目ができる前に作られたキャッシュには無いので、その間は初めて記録に現れた日を出す
    tr.appendChild(makeCell(formatDate(`${row.next_day || row.next_first_day}T00:00:00Z`)));
    tr.appendChild(makeCell(`${row.days_to_next} 日`, "num"));
  }
  // 旧版のダウンロードには、足した日数を添える(前日の記録が無い日は足していない)
  tr.appendChild(makeCell(`${formatNumber(row.old_downloads)}(${row.old_days} 日)`, "num"));
  tr.appendChild(makeCell(formatFirstTwoDays(row), "num"));
  tr.appendChild(makeCell(formatDaysTo90(row), "num"));
  tr.addEventListener("click", () => {
    selectMod(row.mod_id);
    // 詳細は表よりずっと下にあるので、切り替わったことが見えるようにそこまで動かす
    el.detailTitle.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  return tr;
}

// 選択中の更新の合計(数字のタイル)と、mod ごとの表を描く
//
// 修正が必要だったかの記録がある更新(basis = "needs_fix")では、合計は修正が必要だった mod だけで出ている。
// 表もそれに合わせて 2 つに分ける:
//   上の表       修正が必要だった mod と、未確認の mod(未確認の mod がある時だけ「修正」の列を出して区別する)
//   折りたたみ   修正が不要だった mod。更新後に新しい版を出していても、この更新への修正ではない
// 記録が無い更新(basis = "all")では、すべての mod を上の表に出し、合計もすべての mod で出す
function renderEventImpact() {
  const impact = selectedEventImpact();
  clearTable(el.eventImpactSummary);
  clearTable(el.eventImpactTableBody);
  clearTable(el.eventImpactOtherTableBody);
  if (impact === null) {
    return;
  }

  const summary = impact.summary;
  const byNeedsFix = summary.basis === "needs_fix";
  const median = summary.median_days_to_next === null ? "–" : `${formatNumber(summary.median_days_to_next)} 日`;

  // 合計の数字
  if (byNeedsFix) {
    el.eventImpactSummary.appendChild(makeStatTile("修正が必要だった mod",
      `${formatNumber(summary.needs_fix_count)} 本`, `確認した ${formatNumber(summary.checked_count)} 本中`));
    el.eventImpactSummary.appendChild(makeStatTile("そのうち次の版を出した mod",
      `${formatNumber(summary.next_count)} 本`, `修正が必要だった ${formatNumber(summary.needs_fix_count)} 本のうち`));
    el.eventImpactSummary.appendChild(makeStatTile("次の版までの日数(中央値)",
      median, "更新日から、次の版を公開した日まで"));
    el.eventImpactSummary.appendChild(makeStatTile("その間の旧版のダウンロード",
      formatNumber(summary.old_downloads_total), "修正が必要だった mod の合計。多めの見積もり"));
  } else {
    el.eventImpactSummary.appendChild(makeStatTile("更新後に次の版を出した mod",
      `${formatNumber(summary.next_count)} 本`, `全 ${formatNumber(summary.mod_count)} 本中`));
    el.eventImpactSummary.appendChild(makeStatTile("次の版までの日数(中央値)",
      median, "更新日から、次の版を公開した日まで"));
    el.eventImpactSummary.appendChild(makeStatTile("その間の旧版のダウンロード",
      formatNumber(summary.old_downloads_total), "すべての mod の合計。多めの見積もり"));
  }
  el.eventImpactBasisNote.hidden = byNeedsFix;

  // 行の並びは API のまま(次の版を出した mod が日数の短い順に先、出していない mod は旧版のダウンロードの多い順に後)
  const mainRows = byNeedsFix ? impact.mods.filter((row) => row.needs_fix !== false) : impact.mods;
  const otherRows = byNeedsFix ? impact.mods.filter((row) => row.needs_fix === false) : [];

  // 上の表。未確認の mod が混ざる時だけ、見出しにそう書き、「修正」の列(必要 / 未確認)を出す。
  // 修正が必要だった mod だけの時は、全部の行が「必要」なので列は要らない
  const hasUnchecked = byNeedsFix && mainRows.some((row) => row.needs_fix !== true);
  if (!byNeedsFix) {
    el.eventImpactMainTitle.textContent = "更新の時点で公開していた mod";
  } else {
    el.eventImpactMainTitle.textContent = hasUnchecked ? "修正が必要だった mod と、未確認の mod" : "修正が必要だった mod";
  }
  el.eventImpactFixHead.hidden = !hasUnchecked;
  for (const row of mainRows) {
    el.eventImpactTableBody.appendChild(makeEventImpactRow(row, hasUnchecked));
  }
  // 確認したすべての mod で修正が不要だった更新では、空の表の代わりに一言出す
  el.eventImpactMainWrap.hidden = mainRows.length === 0;
  el.eventImpactEmptyNote.hidden = mainRows.length > 0;

  // 折りたたみの中の表(修正が不要だった mod)。そのうち何本が更新後に次の版を出したかを見出しに添える
  el.eventImpactOtherDetails.hidden = otherRows.length === 0;
  if (otherRows.length > 0) {
    const released = otherRows.filter((row) => row.next_version !== null).length;
    el.eventImpactOtherSummary.textContent =
      `修正が不要だった mod(${formatNumber(otherRows.length)} 本。うち ${formatNumber(released)} 本は更新後に次の版を公開)`;
    for (const row of otherRows) {
      el.eventImpactOtherTableBody.appendChild(makeEventImpactRow(row, false));
    }
  }
  highlightSelectedModRows();
}

// ============================================================
// 描画: 選択中 mod の詳細
// ============================================================

function renderDetailTitle() {
  const mod = state.summary.mod;
  el.detailTitle.textContent = "";
  el.detailTitle.appendChild(document.createTextNode(`${mod.name} の詳細`));
  const sub = document.createElement("span");
  sub.className = "section-title-sub";
  sub.textContent = mod.external_id;
  el.detailTitle.appendChild(sub);
}

// サマリータイル
function renderStats() {
  const latest = state.summary.latest_snapshot;

  // 総ダウンロード数(最新スナップショット)
  el.statDownloads.textContent = latest ? formatNumber(latest.download_count) : "–";
  el.statCapturedAt.textContent = latest ? `${formatDateTime(latest.captured_at)} 時点` : "まだ取得データがありません";

  // 期間内の増加 = 期間内の最後のスナップショット − 最初のスナップショット
  if (state.snapshots.length >= 2) {
    const first = state.snapshots[0];
    const last = state.snapshots[state.snapshots.length - 1];
    setDeltaValue(el.statDelta, last.download_count - first.download_count);
    el.statDeltaSub.textContent = `${formatDate(first.captured_at)} 〜 ${formatDate(last.captured_at)}`;
  } else {
    setDeltaValue(el.statDelta, null);
    el.statDeltaSub.textContent = "比較には 2 回以上の取得が必要です";
  }

  // 評価
  el.statRating.textContent = latest ? formatNumber(latest.rating_score) : "–";

  // 最新バージョン
  const version = state.summary.latest_version;
  el.statVersion.textContent = version ? `v${version.version_number}` : "–";
  el.statVersionSub.textContent = version
    ? `${formatDate(version.release_date)} 公開 / 全 ${state.summary.version_count} バージョン`
    : "";
}

// ダウンロード数の推移(折れ線 + バージョン公開日の縦線)
function renderDownloadsChart() {
  const points = state.snapshots.map((s) => ({
    x: new Date(s.captured_at).getTime(),
    y: s.download_count,
  }));

  if (charts.downloads) {
    charts.downloads.destroy();
  }

  charts.downloads = new Chart(el.downloadsCanvas, {
    type: "line",
    data: { datasets: [lineDataset("ダウンロード数", points)] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },  // 系列が 1 本だけなので凡例は不要(タイトルが役割を果たす)
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => formatDateTime(items[0].parsed.x),
            label: (item) => `${formatNumber(item.parsed.y)} ダウンロード`,
          },
        },
        eventMarker: { modId: state.modId, alignToDay: false },  // ゲーム全体の出来事と、この mod の出来事
      },
      scales: { x: timeAxisOptions(), y: countAxisOptions() },
    },
    plugins: [eventMarkerPlugin, versionMarkerPlugin, crosshairPlugin],
  });
}

// スナップショットの表(グラフと同じデータ。グラフが読めない環境のための代替表示)
function renderSnapshotTable() {
  clearTable(el.snapshotTableBody);
  if (state.snapshots.length === 0) {
    appendEmptyRow(el.snapshotTableBody, 4, "この期間のデータはありません");
    return;
  }

  // 新しい順に表示する(グラフは古い順だが、表は最新が上のほうが読みやすい)
  const rows = [...state.snapshots].reverse();
  for (let i = 0; i < rows.length; i++) {
    const current = rows[i];
    const previous = rows[i + 1];  // 1 つ古いスナップショット(配列は新しい順なので i+1)
    const tr = document.createElement("tr");
    tr.appendChild(makeCell(formatDateTime(current.captured_at)));
    tr.appendChild(makeCell(formatNumber(current.download_count), "num"));
    tr.appendChild(makeCell(previous ? formatSigned(current.download_count - previous.download_count) : "–", "num"));
    tr.appendChild(makeCell(formatNumber(current.rating_score), "num"));
    el.snapshotTableBody.appendChild(tr);
  }
}

// ---- バージョン別の積み上げグラフ ----

// version-snapshots の行(バージョン × 取得日時)を、グラフ用の系列に組み替える
// 出力: {
//   times:  取得日時(ミリ秒)の配列(古い順)
//   series: [{ label, color, values: { [time]: download_count } }, ...]
//           最新 VERSION_SERIES_LIMIT 個のバージョンが個別、残りは「その他」に合算
//           配列の順序 = 積み上げの下から上(その他 → 古い → 新しい)
// }
function buildVersionSeries() {
  const rows = state.versionSnapshots;

  // バージョンを公開日の新しい順に並べる(同じ公開日なら version_number の文字列比較で新しいほうを後ろに)
  const versionInfo = new Map();  // version_number → release_date
  for (const row of rows) {
    if (!versionInfo.has(row.version_number)) {
      versionInfo.set(row.version_number, row.release_date);
    }
  }
  const versionsNewestFirst = [...versionInfo.keys()].sort((a, b) => {
    const dateDiff = new Date(versionInfo.get(b)) - new Date(versionInfo.get(a));
    return dateDiff !== 0 ? dateDiff : b.localeCompare(a, undefined, { numeric: true });
  });

  const individual = versionsNewestFirst.slice(0, VERSION_SERIES_LIMIT);
  const grouped = new Set(versionsNewestFirst.slice(VERSION_SERIES_LIMIT));

  // 取得日時の一覧(古い順)
  const timeSet = new Set();
  for (const row of rows) {
    timeSet.add(new Date(row.captured_at).getTime());
  }
  const times = [...timeSet].sort((a, b) => a - b);

  // 系列ごとの値。色は新しいバージョンから順に series-1, series-2 ... を割り当てる
  const colorVars = ["--series-1", "--series-2", "--series-3", "--series-4"];
  const series = individual.map((versionNumber, index) => ({
    label: `v${versionNumber}`,
    color: cssVar(colorVars[index]),
    values: {},
  }));
  const otherSeries = { label: `その他(${grouped.size} バージョン)`, color: cssVar("--series-other"), values: {} };

  for (const row of rows) {
    const time = new Date(row.captured_at).getTime();
    const index = individual.indexOf(row.version_number);
    const target = index >= 0 ? series[index] : otherSeries;
    target.values[time] = (target.values[time] || 0) + row.download_count;
  }

  // 積み上げの順序: 下から「その他」→ 古いバージョン → 最新バージョン
  const ordered = [...series].reverse();
  if (grouped.size > 0) {
    ordered.unshift(otherSeries);
  }
  return { times, series: ordered };
}

function renderVersionsChart() {
  const { times, series } = buildVersionSeries();

  if (charts.versions) {
    charts.versions.destroy();
  }

  const datasets = series.map((s, index) => ({
    label: s.label,
    data: times.map((time) => ({ x: time, y: s.values[time] || 0 })),
    backgroundColor: s.color,
    borderColor: cssVar("--surface"),  // 系列の境目を背景色の線で区切る(塗り同士が接しないようにする)
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHoverBackgroundColor: s.color,
    pointHoverBorderColor: cssVar("--surface"),
    fill: index === 0 ? "origin" : "-1",  // 一番下は 0 から、それ以外は 1 つ下の系列まで塗る
    tension: 0,
  }));

  charts.versions = new Chart(el.versionsCanvas, {
    type: "line",
    data: { datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "top",
          align: "start",
          labels: { color: cssVar("--text-secondary"), boxWidth: 12, boxHeight: 12 },
        },
        tooltip: {
          callbacks: {
            title: (items) => formatDateTime(items[0].parsed.x),
            label: (item) => `${item.dataset.label}: ${formatNumber(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: timeAxisOptions(),
        y: { ...countAxisOptions(), stacked: true, beginAtZero: true },  // 積み上げは 0 から積む(下の系列が切れないように)
      },
    },
    plugins: [crosshairPlugin],
  });
}

// バージョン別の表(横に系列、縦に取得日時。新しい取得が上)
function renderVersionSnapshotTable() {
  const { times, series } = buildVersionSeries();
  clearTable(el.versionSnapshotTableHead);
  clearTable(el.versionSnapshotTableBody);

  // 見出し行
  const headRow = document.createElement("tr");
  const firstHead = document.createElement("th");
  firstHead.textContent = "取得日時";
  headRow.appendChild(firstHead);
  const columns = [...series].reverse();  // 表では新しいバージョンを左に
  for (const s of columns) {
    const th = document.createElement("th");
    th.textContent = s.label;
    th.className = "num";
    headRow.appendChild(th);
  }
  el.versionSnapshotTableHead.appendChild(headRow);

  if (times.length === 0) {
    appendEmptyRow(el.versionSnapshotTableBody, columns.length + 1, "この期間のデータはありません");
    return;
  }

  for (const time of [...times].reverse()) {
    const tr = document.createElement("tr");
    tr.appendChild(makeCell(formatDateTime(time)));
    for (const s of columns) {
      tr.appendChild(makeCell(formatNumber(s.values[time] || 0), "num"));
    }
    el.versionSnapshotTableBody.appendChild(tr);
  }
}

// バージョン履歴の表
// 公開前後の 1 日あたりの平均。7 日そろっていなければ日数を添える("7.7(6 日)")
function formatWindowAverage(window) {
  if (window.average === null) {
    return "–";
  }
  const days = window.days < 7 ? `(${window.days} 日)` : "";
  return `${formatNumber(window.average)}${days}`;
}

// 公開から n 日目の新しい版の割合("84.4%")。その日が無いか、割合が出せない日は "–"
function formatShareOnDay(release, day) {
  const point = release.share.find((s) => s.day === day);
  return point && point.share !== null ? `${point.share}%` : "–";
}

// 公開の前後の表(新しい公開が上)
function renderReleaseTable() {
  clearTable(el.releaseTableBody);
  if (state.releases.length === 0) {
    appendEmptyRow(el.releaseTableBody, 6, "記録を始めてから公開されたバージョンはまだありません");
    return;
  }
  for (const release of state.releases) {
    const tr = document.createElement("tr");
    tr.appendChild(makeCell(`v${release.version_number}`));
    tr.appendChild(makeCell(formatDate(`${release.first_day}T00:00:00Z`)));
    tr.appendChild(makeCell(formatWindowAverage(release.before), "num"));
    tr.appendChild(makeCell(formatWindowAverage(release.after), "num"));
    tr.appendChild(makeCell(formatSigned(release.change), "num"));
    tr.appendChild(makeCell(`${formatShareOnDay(release, 1)} / ${formatShareOnDay(release, 7)}`, "num"));
    el.releaseTableBody.appendChild(tr);
  }
}

// 公開から何日目かを横軸にした、新しい版の割合の折れ線(最新 4 回の公開を重ねて比べる)
function renderReleaseShareChart() {
  if (charts.releaseShare) {
    charts.releaseShare.destroy();
    charts.releaseShare = null;
  }
  // 比べられる公開が無ければ、空のグラフの枠だけが残らないように隠す
  el.releaseShareCanvas.parentElement.hidden = state.releases.length === 0;
  if (state.releases.length === 0) {
    return;
  }

  const releases = state.releases.slice(0, 4);
  const maxDay = Math.max(...releases.flatMap((r) => r.share.map((s) => s.day)));
  const labels = [];
  for (let day = 1; day <= maxDay; day++) {
    labels.push(`${day} 日目`);
  }
  const colors = ["--series-1", "--series-2", "--series-3", "--series-4"];

  charts.releaseShare = new Chart(el.releaseShareCanvas, {
    type: "line",
    data: {
      labels: labels,
      datasets: releases.map((release, i) => ({
        label: `v${release.version_number}`,
        // 日の抜けや割合が出せない日は null(線を切る)
        data: labels.map((_, index) => {
          const point = release.share.find((s) => s.day === index + 1);
          return point ? point.share : null;
        }),
        release: release,  // ツールチップで件数を出すために持たせておく
        borderColor: cssVar(colors[i]),
        backgroundColor: cssVar(colors[i]),
        borderWidth: 2,
        pointRadius: 3,
        spanGaps: false,
        tension: 0,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "top",
          align: "start",
          labels: { color: cssVar("--text-secondary"), boxWidth: 12, boxHeight: 12 },
        },
        tooltip: {
          callbacks: {
            title: (items) => `公開 ${items[0].dataIndex + 1} 日目`,
            label: (item) => {
              const point = item.dataset.release.share.find((s) => s.day === item.dataIndex + 1);
              return `${item.dataset.label}: ${point.share}%(${formatNumber(point.new_version)} / ${formatNumber(point.total)} 件)`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: cssVar("--text-muted"), maxRotation: 0, autoSkip: true },
          border: { color: cssVar("--grid") },
        },
        y: {
          // CDN の揺れで割合が 100% を超える日や 0% を下回る日もあるので、固定せず目安にとどめる
          suggestedMin: 0,
          suggestedMax: 100,
          grid: { color: cssVar("--grid") },
          ticks: { color: cssVar("--text-muted"), callback: (value) => `${value}%` },
          border: { display: false },
        },
      },
    },
  });
}

function renderVersionTable() {
  clearTable(el.versionTableBody);
  if (state.versions.length === 0) {
    appendEmptyRow(el.versionTableBody, 2, "バージョン情報はまだありません");
    return;
  }
  for (const version of state.versions) {
    const tr = document.createElement("tr");
    tr.appendChild(makeCell(`v${version.version_number}`));
    tr.appendChild(makeCell(version.release_date ? formatDate(version.release_date) : "–"));
    el.versionTableBody.appendChild(tr);
  }
}

// 取得ジョブの実行記録の表
function renderLogTable(logs) {
  clearTable(el.logTableBody);
  if (logs.length === 0) {
    appendEmptyRow(el.logTableBody, 4, "実行記録はまだありません");
    return;
  }
  for (const log of logs) {
    const tr = document.createElement("tr");
    tr.appendChild(makeCell(formatDateTime(log.run_at)));
    // platform 列がない古い記録は Thunderstore だけを取得していた頃のもの
    const platformLabel = PLATFORM_LABELS[log.platform];
    tr.appendChild(makeCell(platformLabel ? platformLabel.name : (log.platform || "Thunderstore")));
    // 結果は色だけでなく記号 + 文字で示す
    const isSuccess = log.status === "success";
    const statusCell = makeCell(isSuccess ? "✓ 成功" : "✕ 失敗", isSuccess ? "status-good" : "status-failed");
    if (!isSuccess && log.error_message) {
      statusCell.title = log.error_message;  // マウスを乗せるとエラー内容が見える
    }
    tr.appendChild(statusCell);
    tr.appendChild(makeCell(formatNumber(log.records_fetched), "num"));
    el.logTableBody.appendChild(tr);
  }
}

// 費用を "3.16 円" のように表示する(1 円未満が多いので小数第 2 位まで)
function formatCost(value) {
  if (value === null || value === undefined) {
    return "–";
  }
  const unit = state.costs.currency === "JPY" ? " 円" : ` ${state.costs.currency}`;
  return value.toFixed(2) + unit;
}

// "2026-09-24" → "9/24"
function shortDate(date) {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

// 期間中ずっと 0 円だったサービス(グラフに出しても見えないので、名前だけ説明文に出す)
function zeroCostServices() {
  return state.costs.services.filter((name) => state.costs.days.every((d) => !d.services[name]));
}

// 運用費用の 3 つの数字: 直近 7 日の平均、その 30 日換算、今月の合計
function renderCostTiles() {
  const days = state.costs.days;
  if (days.length === 0) {
    el.costAverageSub.textContent = "データがまだありません";
    return;
  }

  const recent = days.slice(-7);
  const average = recent.reduce((sum, d) => sum + d.total, 0) / recent.length;
  el.costAverage.textContent = formatCost(average);
  el.costAverageSub.textContent = `${shortDate(recent[0].date)}〜${shortDate(recent[recent.length - 1].date)}(${recent.length} 日)`;
  el.costMonthly.textContent = formatCost(average * 30);

  // 「今月」は確定した最後の日が入っている月
  const lastDate = days[days.length - 1].date;
  const monthDays = days.filter((d) => d.date.slice(0, 7) === lastDate.slice(0, 7));
  el.costMonthTotal.textContent = formatCost(monthDays.reduce((sum, d) => sum + d.total, 0));
  el.costMonthTotalSub.textContent = `${shortDate(monthDays[0].date)}〜${shortDate(lastDate)}`;

  const zero = zeroCostServices();
  el.costZeroNote.textContent = zero.length > 0
    ? ` ${zero.join("・")} は表示期間中ずっと 0 円のため、グラフには出していません。`
    : "";
}

// 日別の費用をサービスごとに積み上げた棒グラフ。
// 横軸は日付のラベルを並べるだけ(期間の選択は効かないので、時間軸の min などは要らない)
function renderCostChart() {
  const days = state.costs.days;
  const zero = zeroCostServices();
  const services = state.costs.services.filter((name) => !zero.includes(name));
  // サービスは期間合計の多い順に並んでいるので、多い順に系列の色を割り当てる
  const colors = ["--series-1", "--series-2", "--series-3", "--series-4"];

  if (charts.costs) {
    charts.costs.destroy();
  }

  charts.costs = new Chart(el.costCanvas, {
    type: "bar",
    data: {
      labels: days.map((d) => shortDate(d.date)),
      datasets: services.map((name, i) => ({
        label: name,
        data: days.map((d) => d.services[name] || 0),
        backgroundColor: cssVar(colors[i] || "--series-other"),
        maxBarThickness: 24,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "top",
          align: "start",
          labels: { color: cssVar("--text-secondary"), boxWidth: 12, boxHeight: 12 },
        },
        tooltip: {
          callbacks: {
            title: (items) => `${formatDate(`${days[items[0].dataIndex].date}T00:00:00Z`)} の費用`,
            label: (item) => `${item.dataset.label}: ${formatCost(item.parsed.y)}`,
            footer: (items) => `合計: ${formatCost(days[items[0].dataIndex].total)}`,
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { color: cssVar("--text-muted"), maxRotation: 0, autoSkip: true },
          border: { color: cssVar("--grid") },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: cssVar("--grid") },
          ticks: { color: cssVar("--text-muted"), callback: (value) => formatCost(value) },
          border: { display: false },
        },
      },
    },
  });
}

// 運用費用の表(新しい日が上)。内訳は 0 円でないサービスだけを並べる
function renderCostTable() {
  clearTable(el.costTableBody);
  const days = state.costs.days;
  if (days.length === 0) {
    appendEmptyRow(el.costTableBody, 3, "データがまだありません");
    return;
  }
  for (const d of [...days].reverse()) {
    const tr = document.createElement("tr");
    tr.appendChild(makeCell(formatDate(`${d.date}T00:00:00Z`)));
    tr.appendChild(makeCell(formatCost(d.total), "num"));
    const parts = state.costs.services
      .filter((name) => d.services[name])
      .map((name) => `${name} ${formatCost(d.services[name])}`);
    tr.appendChild(makeCell(parts.join(" / ") || "–"));
    el.costTableBody.appendChild(tr);
  }
}

// ============================================================
// 起動処理とイベント
// ============================================================

// 全部のグラフを今の state で描き直す(ダークモード切り替え時に色を読み直すため)
function rerenderAllCharts() {
  if (state.overview) {
    renderTotalsChart();
    renderDailyChart();
  }
  if (state.summary) {
    renderDownloadsChart();
    renderVersionsChart();
    renderReleaseShareChart();
  }
  if (state.costs && state.costs.days.length > 0) {
    renderCostChart();
  }
}

async function init() {
  // mod 一覧を取ってセレクトボックスに入れる
  try {
    state.mods = await fetchJson("/mods");
  } catch (err) {
    showError(`mod 一覧の取得に失敗しました(${err.message})`);
    return;
  }

  if (state.mods.length === 0) {
    showError("追跡中の mod がありません");
    return;
  }

  // URL の #mod=12 で最初に詳細を表示する mod を指定できる。
  // 指定された mod のプラットフォームを初期プラットフォームにする(指定が無ければ Thunderstore)
  const hashMatch = window.location.hash.match(/^#mod=(\d+)$/);
  const requestedId = hashMatch ? Number(hashMatch[1]) : null;
  const requestedMod = state.mods.find((m) => m.mod_id === requestedId) || null;
  const platformMod = requestedMod
    || state.mods.find((m) => m.platform === state.platform)
    || state.mods[0];
  state.platform = PLATFORM_LABELS[platformMod.platform] ? platformMod.platform : "thunderstore";
  for (const button of el.platformButtons) {
    button.classList.toggle("is-selected", button.dataset.platform === state.platform);
  }
  renderPlatformLabels();
  fillModSelect();

  // イベント登録
  el.modSelect.addEventListener("change", () => {
    selectMod(Number(el.modSelect.value));
  });

  el.eventImpactSelect.addEventListener("change", () => {
    state.eventImpactId = Number(el.eventImpactSelect.value);
    renderEventImpact();
  });

  for (const button of el.platformButtons) {
    button.addEventListener("click", () => {
      if (button.dataset.platform !== state.platform) {
        selectPlatform(button.dataset.platform);
      }
    });
  }

  for (const button of el.rangeButtons) {
    button.addEventListener("click", () => {
      for (const other of el.rangeButtons) {
        other.classList.remove("is-selected");
      }
      button.classList.add("is-selected");
      state.rangeDays = RANGE_PRESETS[button.dataset.days];
      updateRangeFrom();
      loadOverview();
      loadMod();
    });
  }

  // OS のダークモード切り替えに追従して色を読み直す
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerenderAllCharts);

  // 最初の描画
  updateRangeFrom();
  loadFetchLogs();
  loadCosts();
  loadEvents();
  loadEventImpacts();
  loadFacts();
  if (requestedMod) {
    // URL で指定された mod は、一覧を待たずに同時に取りに行く
    state.modId = requestedMod.mod_id;
    el.modSelect.value = String(state.modId);
    await Promise.all([loadOverview(), loadMod()]);
  } else {
    // 指定が無ければ、一覧(ダウンロード数の多い順)を取ってから、その先頭の mod を表示する
    await loadOverview();
    state.modId = defaultModId(state.platform);
    if (state.modId !== null) {
      el.modSelect.value = String(state.modId);
    }
    await loadMod();
  }
}

init();
