// ============================================================
// assessment.js
//
// 互換性チェックの結果ファイル(JSON)を、event_mod_assessments テーブル(sql/005)に書く行に変える。
// scripts/import-assessment.js から使う。DB には触らない(読むのも書くのもスクリプトの役目)。
//
// なぜスクリプトではなくここに置くか:
//   ファイルの中身は外から来るので、書く前の確認を単体テストで確かめたい。
//   テスト(api/test/)と GitHub Actions のテストは api/ の中だけを見るので、確認の部分をここに置く。
//
// 結果ファイルの形(互換性チェックが出力する):
//   { "sweep": "1.0.2",
//     "mods": [ { "thunderstore": "SULFUR_Together", "nexus": 94, "needs_fix": true },
//               { "thunderstore": "GridWise", "nexus": null, "needs_fix": false } ] }
//   thunderstore  Thunderstore のパッケージ名(必須)
//   nexus         Nexus Mods の mod 番号(mod のページの URL の数字)。Nexus に無い mod は null か省略
//   needs_fix     true = 修正が必要だった、false = 確認して修正は不要だった
//   sweep         どのゲームのビルドに対するチェックか(表示するだけ。省略可)
//
// mod の見つけ方(mods テーブルの platform + external_id。取得ジョブが入れる値と同じ):
//   Thunderstore  platform 'thunderstore'、external_id 'ryuka_labs/<thunderstore>'
//   Nexus Mods    platform 'nexusmods'、  external_id 'sulfur/<nexus>'
// 更新(ゲームのお知らせ)の見つけ方: events の source 'steam'、external_id = Steam のお知らせの番号(gid)
// ============================================================

// Thunderstore の作者名と、Nexus Mods のゲームの名前(external_id の前半)
const THUNDERSTORE_OWNER = "ryuka_labs";
const NEXUS_GAME = "sulfur";

// 結果ファイルの mod 1 件に書いてよい項目(打ち間違えた項目を黙って無視しないため)
const ENTRY_KEYS = ["thunderstore", "nexus", "needs_fix"];

// 結果ファイルの中身を確かめる
// 入力: data(JSON.parse した結果。何が来るか分からない)
// 出力: { problems: [文字列, ...], sweep: 文字列 または null, entries: [{ thunderstore, nexus, needs_fix }, ...] }
//       problems が空でなければ entries は使わない。nexus は省略されていれば null にそろえる
function validateAssessmentFile(data) {
  const problems = [];
  const entries = [];

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { problems: ["ファイルの中身が JSON のオブジェクトではありません"], sweep: null, entries: [] };
  }
  if (data.sweep !== undefined && typeof data.sweep !== "string") {
    problems.push("sweep は文字列で書いてください");
  }
  if (!Array.isArray(data.mods) || data.mods.length === 0) {
    problems.push("mods が無いか、空の配列です");
    return { problems: problems, sweep: null, entries: [] };
  }

  const seenNames = new Set();
  const seenNexus = new Set();
  data.mods.forEach((entry, index) => {
    const where = `mods[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${where} がオブジェクトではありません`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.includes(key)) {
        problems.push(`${where} に知らない項目 "${key}" があります`);
      }
    }

    const name = entry.thunderstore;
    if (typeof name !== "string" || name.trim() === "") {
      problems.push(`${where} の thunderstore が空か、文字列ではありません`);
    } else if (seenNames.has(name)) {
      problems.push(`${where} の thunderstore "${name}" が 2 回以上出てきます`);
    } else {
      seenNames.add(name);
    }

    const nexus = entry.nexus === undefined ? null : entry.nexus;
    if (nexus !== null) {
      if (!Number.isInteger(nexus) || nexus <= 0) {
        problems.push(`${where} の nexus は正の整数か null で書いてください`);
      } else if (seenNexus.has(nexus)) {
        problems.push(`${where} の nexus ${nexus} が 2 回以上出てきます`);
      } else {
        seenNexus.add(nexus);
      }
    }

    if (typeof entry.needs_fix !== "boolean") {
      problems.push(`${where} の needs_fix は true か false で書いてください`);
    }

    entries.push({ thunderstore: name, nexus: nexus, needs_fix: entry.needs_fix });
  });

  return { problems: problems, sweep: data.sweep === undefined ? null : data.sweep, entries: entries };
}

// --events の値("123,456")を Steam のお知らせの番号の配列にする
// 入力: text(文字列 または undefined)
// 出力: { problems: [文字列, ...], gids: ["123", "456"] }
// 番号は数字だけ。桁が多く JavaScript の数値では正確に表せないので、文字列のまま扱う
function parseEventGids(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { problems: ["--events で、Steam のお知らせの番号を 1 つ以上指定してください"], gids: [] };
  }
  const problems = [];
  const gids = [];
  for (const part of text.split(",")) {
    const gid = part.trim();
    if (!/^\d+$/.test(gid)) {
      problems.push(`--events の "${gid}" は数字だけの番号ではありません`);
    } else if (gids.includes(gid)) {
      problems.push(`--events の ${gid} が 2 回以上出てきます`);
    } else {
      gids.push(gid);
    }
  }
  return { problems: problems, gids: gids };
}

// 確かめた中身を、DB の mod と更新に結びつけて、書く行の一覧にする
// 入力: {
//   entries:  validateAssessmentFile の entries
//   gids:     parseEventGids の gids
//   mods:     mods テーブルの行 [{ mod_id, name, platform, external_id }, ...]
//   events:   events テーブルの行 [{ event_id, title, source, external_id }, ...]
// }
// 出力: { problems: [文字列, ...],
//         rows: [{ event_id, event_title, mod_id, mod_name, platform, needs_fix }, ...] }
//       1 つでも見つからなければ problems に全部並べる(呼び出し側は rows を書かない)。
//       rows の並びは --events の順、その中は結果ファイルの順(Thunderstore、Nexus Mods の順)
function resolveAssessments({ entries, gids, mods, events }) {
  const problems = [];

  // platform + external_id → mod の行
  const modByKey = new Map();
  for (const mod of mods) {
    modByKey.set(`${mod.platform}|${mod.external_id}`, mod);
  }

  // 結果ファイルの mod ごとに、書く対象の mod の行(1 つか 2 つ)を集める
  const targets = [];
  for (const entry of entries) {
    const thunderstoreId = `${THUNDERSTORE_OWNER}/${entry.thunderstore}`;
    const thunderstoreMod = modByKey.get(`thunderstore|${thunderstoreId}`);
    if (thunderstoreMod) {
      targets.push({ mod: thunderstoreMod, needs_fix: entry.needs_fix });
    } else {
      problems.push(`Thunderstore の mod "${entry.thunderstore}" が mods にありません(external_id: ${thunderstoreId})`);
    }

    if (entry.nexus !== null) {
      const nexusId = `${NEXUS_GAME}/${entry.nexus}`;
      const nexusMod = modByKey.get(`nexusmods|${nexusId}`);
      if (nexusMod) {
        targets.push({ mod: nexusMod, needs_fix: entry.needs_fix });
      } else {
        problems.push(`Nexus Mods の mod ${entry.nexus}(${entry.thunderstore})が mods にありません(external_id: ${nexusId})`);
      }
    }
  }

  // 指定された更新を探す(Steam のお知らせだけ)
  const foundEvents = [];
  for (const gid of gids) {
    const event = events.find((e) => e.source === "steam" && e.external_id === gid);
    if (event) {
      foundEvents.push(event);
    } else {
      problems.push(`Steam のお知らせ ${gid} が events にありません`);
    }
  }

  if (problems.length > 0) {
    return { problems: problems, rows: [] };
  }

  const rows = [];
  for (const event of foundEvents) {
    for (const target of targets) {
      rows.push({
        event_id: event.event_id,
        event_title: event.title,
        mod_id: target.mod.mod_id,
        mod_name: target.mod.name,
        platform: target.mod.platform,
        needs_fix: target.needs_fix,
      });
    }
  }
  return { problems: [], rows: rows };
}

module.exports = { validateAssessmentFile, parseEventGids, resolveAssessments };
