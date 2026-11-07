// 発表動画の各場面で共通に使う処理。
//
// 解決すること: 「日ごとの増加」のグラフは 1 の場面と 6 の場面の両方に出る。
//   同じグラフに見えないと「最初の話に戻った」ことが伝わらないので、描き方をここ 1 か所にまとめる。
// 入力: window.MI_DATA(assets/data.js)
// 出力: window.MI(数字の整形と、SVG のグラフを組み立てる関数)

(function () {
  const NS = "http://www.w3.org/2000/svg";

  // SVG の要素を作る
  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  // 3 桁区切り
  function fmt(n) {
    return Math.round(n).toLocaleString("en-US");
  }

  // "2026-10-28" → "10/28"
  function md(date) {
    const [, m, d] = date.split("-");
    return `${Number(m)}/${Number(d)}`;
  }

  // 日ごとの増加の棒グラフを svg の中に組み立てる。
  // 入力: svg 要素、幅と高さ、表示する日付の範囲
  // 出力: 棒・縦線・軸の要素(場面側がこれを GSAP で動かす)
  function drawDaily(svg, { width, height, from, to, maxValue = 1000 }) {
    const days = window.MI_DATA.daily.filter((d) => d.date >= from && d.date <= to);
    const pad = { left: 84, right: 24, top: 56, bottom: 56 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const band = plotW / days.length;
    const x = (i) => pad.left + band * i + band / 2;
    const y = (v) => pad.top + plotH * (1 - v / maxValue);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const grid = el("g", { class: "mi-grid" }, svg);
    for (let v = 0; v <= maxValue; v += 200) {
      el("line", { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }, grid);
      const t = el("text", { x: pad.left - 14, y: y(v) + 8, "text-anchor": "end", class: "mi-axis" }, grid);
      t.textContent = fmt(v);
    }
    const labels = el("g", {}, svg);
    days.forEach((d, i) => {
      if (i % 7 !== 0 && i !== days.length - 1) return;
      const t = el("text", { x: x(i), y: height - 14, "text-anchor": "middle", class: "mi-axis" }, labels);
      t.textContent = md(d.date);
    });

    // 棒は下端を基準に伸ばすので、transform-origin を下にしておく
    const bars = days.map((d, i) => {
      const h = Math.max(0, y(0) - y(d.value));
      const r = el(
        "rect",
        { x: x(i) - band * 0.36, y: y(0) - h, width: band * 0.72, height: h, rx: 3, class: "mi-bar" },
        svg,
      );
      r.dataset.date = d.date;
      r.style.transformOrigin = `0px ${y(0)}px`;
      r.style.transformBox = "view-box";
      return r;
    });

    // ゲームの大型アップデートは実線、パッチは破線(ダッシュボードと同じ)
    const events = window.MI_DATA.gameEvents
      .filter((e) => e.date >= from && e.date <= to)
      .map((e) => {
        const i = days.findIndex((d) => d.date === e.date);
        if (i < 0) return null;
        const g = el("g", { class: "mi-event" }, svg);
        const line = el(
          "line",
          {
            x1: x(i),
            x2: x(i),
            y1: pad.top - 8,
            y2: y(0),
            class: e.kind === "game_major" ? "mi-event-major" : "mi-event-patch",
          },
          g,
        );
        return { ...e, g, line, x: x(i) };
      })
      .filter(Boolean);

    return { days, bars, events, x, y, band, pad, plotW, plotH };
  }

  // よく使う出入りの動き(仕様: 登場はぼかしから 0.2 秒、退場はその半分強)
  function blurIn(tl, target, at, duration = 0.2) {
    tl.fromTo(
      target,
      { opacity: 0, filter: "blur(8px)" },
      { opacity: 1, filter: "blur(0px)", duration, ease: "power2.out" },
      at,
    );
  }
  function blurOut(tl, target, at, duration = 0.18) {
    tl.to(target, { opacity: 0, filter: "blur(8px)", duration, ease: "power3.in" }, at);
  }

  // 数字を 0 から数え上げる(1.4 秒で止める)。時刻だけで値が決まるので、どこに移動しても同じ表示になる
  function countUp(tl, node, to, at, { duration = 1.4, decimals = 0 } = {}) {
    const box = { v: 0 };
    const show = () => {
      node.textContent = decimals ? box.v.toFixed(decimals) : fmt(box.v);
    };
    show();
    tl.fromTo(box, { v: 0 }, { v: to, duration, ease: "power2.out", onUpdate: show }, at);
  }

  window.MI = { el, fmt, md, drawDaily, blurIn, blurOut, countUp, data: window.MI_DATA };
})();
