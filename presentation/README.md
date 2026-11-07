# 発表資料

就職作品プレゼンテーション用の企画書(pptx)と発表動画(mp4)のソースです。
どちらも同じ原稿と同じデータから作るので、数字を取り直したら両方を作り直します。

| ファイル | 内容 |
|---|---|
| `script.md` | 発表原稿。動画の 9 つの場面と 1 対 1 で対応し、企画書の発表者ノートにも入る |
| `tools/fetch-data.mjs` | ダッシュボードの公開 API(GET のみ、Blob キャッシュから返る)から数字を取り、`video/assets/data.js` に書く |
| `tools/build-deck.mjs` | 企画書を作る(`deck/renders/` に出力) |
| `deck/images/` | 企画書に載せるダッシュボードの画面 |
| `video/` | 発表動画(HyperFrames: HTML と GSAP で場面を書き、mp4 に出力する)。演出の決めごとは `video/SPEC.md` |

## 作り直す手順

Node.js 22 以上と FFmpeg が必要です。

```
cd presentation/tools
npm install
npm run data     # 数字を取り直す(video/assets/data.js が変わる)
npm run deck     # 企画書を作る
cd ../video
npx hyperframes@0.9.19 check                       # 配置や文字の大きさの確認
npx hyperframes@0.9.19 render -o renders/draft.mp4 # 動画を出力する
```

数字を取り直したときは、原稿(`script.md`)の数字も合わせて直します。原稿の数字だけは手で書いているためです。

## 録音について

ナレーションは本人の録音を使います。録音ファイルはリポジトリに含めません(`video/assets/voice/` は Git の対象外)。
編集した録音は `video/assets/voice/narration-edited.wav` に置き、`video/index.html` の `<audio>` から読みます。
各場面の長さ(`video/index.html` の `data-duration`)と、場面の中で要素が出る時刻(各場面の先頭の `CUES`)は、この録音の声に合わせてあります。

録音ファイルが無いと `hyperframes lint` が `audio_src_not_found` を出し、出力した動画は声なしになります(場面の時刻は録音に合わせたまま)。
