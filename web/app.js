// ============================================================
// app.js
//
// ダッシュボードの動作をすべて担当するファイル。
// フレームワークは使わず、素の JavaScript だけで書いている。
//
// 流れ:
//   1. 起動時に GET /api/mods で mod 一覧を取り、セレクトボックスに入れる
//   2. mod か期間が変わるたびに、その mod の
//        GET /api/mods/{id}/summary   (今の数字)
//        GET /api/mods/{id}/snapshots (時系列。期間は ?from= で絞る)
//        GET /api/mods/{id}/versions  (バージョン履歴)
//      を同時に取りに行き、揃ったら画面を描き直す
//   3. GET /api/fetch/logs は mod に関係ないので起動時に 1 回だけ取る
//
// 画面に出す文字列はすべて textContent で入れる(API から来た文字列を
// innerHTML に入れると、万一 HTML が混ざっていたときにそのまま実行されてしまうため)。
// ============================================================

const API_BASE = window.MOD_INSIGHT_CONFIG.apiBaseUrl;

// 表示期間ボタンの値(日数)。"all" は絞り込みなし
const RANGE_PRESETS = { "7": 7, "30": 30, "90": 90, "all": null };

// 今画面に表示している状態。描画関数はすべてここを見る
const state = {
  mods: [],          // mod 一覧
  modId: null,       // 選択中の mod_id
  rangeDays: 30,     // 選択中の期間(日数)。null なら全期間
  rangeFrom: null,   // 選択中の期間の開始時刻(ミリ秒)。全期間なら null。loadMod が設定する
  summary: null,     // summary API の結果
  snapshots: [],     // snapshots API の結果(古い順)
  versions: [],      // versions API の結果(新しい順)
};

// Chart.js のインスタンス。描き直すときは destroy してから作り直す
let chart = null;

// ---- 画面の要素をまとめて取得 ----
const el = {
  modSelect: document.getElementById("modSelect"),
  rangeButtons: document.querySelectorAll(".range-buttons button"),
  errorBox: document.getElementById("errorBox"),
  content: document.getElementById("content"),
  statDownloads: document.getElementById("statDownloads"),
  statCapturedAt: document.getElementById("statCapturedAt"),
  statDelta: document.getElementById("statDelta"),
  statDeltaSub: document.getElementById("statDeltaSub"),
  statRating: document.getElementById("statRating"),
  statVersion: document.getElementById("statVersion"),
  statVersionSub: document.getElementById("statVersionSub"),
  chartCanvas: document.getElementById("downloadsChart"),
  snapshotTableBody: document.querySelector("#snapshotTable tbody"),
  versionTableBody: document.querySelector("#versionTable tbody"),
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

// ============================================================
// データ取得
// ============================================================

// 選択中の mod と期間に合わせて 3 つの API を同時に呼び、state を更新して描画する
async function loadMod() {
  if (state.modId === null) {
    return;
  }

  // 期間 → snapshots API の ?from= に変換(全期間なら付けない)
  // 同じ日時をグラフの横軸の左端にも使う(state.rangeFrom)。こうすると
  // データがまだ無い期間も軸に含まれ、その間に公開されたバージョンの縦線が見える
  let query = "";
  state.rangeFrom = null;
  if (state.rangeDays !== null) {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - state.rangeDays);
    state.rangeFrom = from.getTime();
    query = `?from=${encodeURIComponent(from.toISOString())}`;
  }

  el.content.classList.add("is-loading");
  clearError();

  try {
    const [summary, snapshots, versions] = await Promise.all([
      fetchJson(`/mods/${state.modId}/summary`),
      fetchJson(`/mods/${state.modId}/snapshots${query}`),
      fetchJson(`/mods/${state.modId}/versions`),
    ]);
    state.summary = summary;
    state.snapshots = snapshots;
    state.versions = versions;

    renderStats();
    renderChart();
    renderSnapshotTable();
    renderVersionTable();
  } catch (err) {
    showError(`データの取得に失敗しました(${err.message})`);
  } finally {
    el.content.classList.remove("is-loading");
  }
}

// 取得ジョブの実行記録(mod に依存しないので起動時に 1 回だけ)
async function loadFetchLogs() {
  try {
    const logs = await fetchJson("/fetch/logs?limit=10");
    renderLogTable(logs);
  } catch (err) {
    clearTable(el.logTableBody);
    appendEmptyRow(el.logTableBody, 3, `取得できませんでした(${err.message})`);
  }
}

// ============================================================
// 描画
// ============================================================

// サマリータイル
function renderStats() {
  const latest = state.summary.latest_snapshot;

  // 総ダウンロード数(最新スナップショット)
  el.statDownloads.textContent = latest ? formatNumber(latest.download_count) : "–";
  el.statCapturedAt.textContent = latest ? `${formatDateTime(latest.captured_at)} 時点` : "まだ取得データがありません";

  // 期間内の増加 = 期間内の最後のスナップショット − 最初のスナップショット
  el.statDelta.classList.remove("is-up");
  if (state.snapshots.length >= 2) {
    const first = state.snapshots[0];
    const last = state.snapshots[state.snapshots.length - 1];
    const delta = last.download_count - first.download_count;
    el.statDelta.textContent = formatSigned(delta);
    if (delta > 0) {
      el.statDelta.classList.add("is-up");
    }
    el.statDeltaSub.textContent = `${formatDate(first.captured_at)} 〜 ${formatDate(last.captured_at)}`;
  } else {
    el.statDelta.textContent = "–";
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

// 折れ線グラフ
function renderChart() {
  const points = state.snapshots.map((s) => ({
    x: new Date(s.captured_at).getTime(),
    y: s.download_count,
  }));

  if (chart) {
    chart.destroy();
  }

  chart = new Chart(el.chartCanvas, {
    type: "line",
    data: {
      datasets: [{
        label: "ダウンロード数",
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
      }],
    },
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
      },
      scales: {
        x: {
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
        },
        y: {
          grid: { color: cssVar("--grid") },
          ticks: {
            color: cssVar("--text-muted"),
            precision: 0,  // ダウンロード数は整数なので 476.8 のような目盛りを出さない
            callback: (value) => formatNumber(value),
          },
          border: { display: false },
        },
      },
    },
    plugins: [versionMarkerPlugin, crosshairPlugin],
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

// バージョン履歴の表
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
    appendEmptyRow(el.logTableBody, 3, "実行記録はまだありません");
    return;
  }
  for (const log of logs) {
    const tr = document.createElement("tr");
    tr.appendChild(makeCell(formatDateTime(log.run_at)));
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

// ============================================================
// 起動処理とイベント
// ============================================================

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

  for (const mod of state.mods) {
    const option = document.createElement("option");
    option.value = String(mod.mod_id);
    option.textContent = mod.name;
    el.modSelect.appendChild(option);
  }

  // URL の #mod=12 で初期選択を指定できる(なければ先頭の mod)
  const hashMatch = window.location.hash.match(/^#mod=(\d+)$/);
  const requestedId = hashMatch ? Number(hashMatch[1]) : null;
  const initialMod = state.mods.find((m) => m.mod_id === requestedId) || state.mods[0];
  state.modId = initialMod.mod_id;
  el.modSelect.value = String(state.modId);

  // イベント登録
  el.modSelect.addEventListener("change", () => {
    state.modId = Number(el.modSelect.value);
    window.location.hash = `mod=${state.modId}`;
    loadMod();
  });

  for (const button of el.rangeButtons) {
    button.addEventListener("click", () => {
      for (const other of el.rangeButtons) {
        other.classList.remove("is-selected");
      }
      button.classList.add("is-selected");
      state.rangeDays = RANGE_PRESETS[button.dataset.days];
      loadMod();
    });
  }

  // OS のダークモード切り替えに追従して色を読み直す
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.summary) {
      renderChart();
    }
  });

  // 最初の描画
  loadFetchLogs();
  await loadMod();
}

init();
