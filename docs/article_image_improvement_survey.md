# X Post Capture Worker: アーティクル・画像対応 改善調査

**調査日**: 2026-03-19
**目的**: X のアーティクル（長文記事）や画像を含むポストの解析精度を改善する
**対象**: `platforms/claude_platform/x-post-capture-worker/`
**方針**: 案 B（FxEmbed API の Article 対応検証）を本命とする

---

## 1. 現状の問題点

### 1.1 アーティクル（長文記事）が取得できない

現在の `fetchTweetContent()` は FxTwitter API → Syndication API のフォールバック構成。
Worker の型定義 `FxTweetResponse` に article フィールドがなく、アーティクルを処理していない。

- FxTwitter API: `tweet.text` のみ使用。article フィールドの存在は未検証
- Syndication API: 通常テキストのみ

### 1.2 画像がフォールバック時に欠落する

- FxTwitter API: `tweet.media.all[]` で画像 URL・タイプ・サムネイルを取得可能 ✅
- Syndication API フォールバック時: メディア情報なし ❌（media マッピングが未実装）

### 1.3 非公式 API への依存リスク

- FxTwitter は 2023 年に一度 Twitter API 変更で壊れた（[Issue #333](https://github.com/FixTweet/FxTwitter/issues/333)）
- GraphQL API への移行で復旧済み
- Syndication API (`cdn.syndication.twimg.com`) も非公式

---

## 2. FxEmbed（FxTwitter 後継）の最新状況

### 2.1 プロジェクト統合

FxTwitter は **FxEmbed** に統合済み。`fxtwitter.com` / `fixupx.com` は同一 Cloudflare Worker。
リポジトリ: https://github.com/FxEmbed/FxEmbed
技術基盤: TypeScript + Cloudflare Workers + Hono

### 2.2 Article 対応状況 ← 最重要

- **Issue [#867](https://github.com/FixTweet/FxTwitter/issues/867)**: "Add support for Twitter Article" — Open
- **PR #1702**: "Twitter Article UI" — **2025年12月マージ**
- メンテナーが「API に full article text を自動展開して含めたい」と発言
- **API レスポンスに `article` フィールドが追加された可能性あり**:
  - 調査エージェントの報告: `article` フィールドで `created_at`, `modified_at`, `id`, `title`, `preview_text`, `cover_media`, `content`, `media_entities` を返却
  - **→ 実機検証が必要**（ドキュメントと実際の API レスポンスが乖離している可能性あり）

### 2.3 画像・動画対応

- 画像: `tweet.media.all[]` で URL・type・thumbnail_url・width・height・altText ✅
- 動画: mp4 直リンク + thumbnail_url + duration + formats ✅
- 複数画像: 対応 ✅
- モザイク画像: webp/jpeg で合成画像を生成 ✅
- 直接メディアアクセス: `d.fxtwitter.com/{user}/status/{id}.jpg` 形式 ✅

### 2.4 vxTwitter（代替）

- エンドポイント: `https://api.vxtwitter.com/{username}/status/{tweet_id}`
- Article: `title` + `preview_text` + `image` を返す（フルコンテンツなし）
- FxEmbed より簡素だがシンプル
- フォールバック候補として検討可能

---

## 3. X API v2 公式（バックアッププラン）

### 3.1 従量課金（Pay-Per-Use）への移行

2026年2月リニューアル。クレジットベースの従量課金に移行。

| 項目 | 詳細 |
|------|------|
| 課金モデル | クレジット前払い（最低 $5）、使った分だけ消費 |
| ツイート読み取り | **$0.005/件** |
| 24h dedup | 同一ツイートの 24h 内再リクエストはカウント外 |
| 失敗リクエスト | 課金されない |
| 月間上限 | 200万 Post reads（超過は Enterprise $42K+） |
| xAI 還元 | 月 $200+ 利用で 10-20% を xAI API クレジット還元 |

### 3.2 旧プラン（参考）

| Tier | 月額 | Read | Write |
|------|------|------|-------|
| Free | $0 | **0**（読み取り不可。実質廃止） | 1,500 |
| Basic | $200 | 15,000 | 50,000 |
| Pro | $5,000 | 1,000,000 | 300,000 |
| Enterprise | $42,000+ | Custom | Custom |

### 3.3 X API v2 エンドポイント別料金

| 操作 | 料金/件 |
|------|---------|
| Post read（ツイート取得） | $0.005 |
| User profile lookup | $0.010 |
| DM event read | $0.010 |
| Post create | $0.010 |
| DM interaction create | $0.015 |
| User interaction (follow/like/RT) | $0.015 |
| Lists/Spaces/Media/Analytics read | $0.005 |
| Management（削除等） | $0.005-$0.010 |

### 3.4 X API v2 で取得可能なフィールド

```bash
curl "https://api.x.com/2/tweets/{id}?\
tweet.fields=article,note_tweet,created_at,public_metrics,entities,attachments,lang,source&\
expansions=attachments.media_keys,author_id,article.cover_media,article.media_entities&\
media.fields=url,type,preview_image_url,alt_text,width,height,variants&\
user.fields=name,username,profile_image_url" \
  -H "Authorization: Bearer $BEARER_TOKEN"
```

| フィールド | 内容 | 備考 |
|-----------|------|------|
| `text` | ツイート本文（280字まで） | デフォルト返却 |
| `note_tweet.text` | 280字超の長文テキスト全文 | `tweet.fields=note_tweet` |
| `note_tweet.entities` | cashtags, hashtags, mentions, urls | 同上 |
| `article` | アーティクルメタデータ | `tweet.fields=article` |
| → `article.id`, `title`, `preview_text`, `content` | 記事本文含む | |
| → `article.cover_media`, `media_entities` | 記事内画像 | expansion 必要 |
| → `article.created_at`, `modified_at` | 作成・更新日時 | |
| `media` (expansion) | 画像 URL・サイズ・alt text・動画バリアント | `expansions=attachments.media_keys` |
| `public_metrics` | いいね・RT・返信・引用・ブックマーク | `tweet.fields=public_metrics` |

---

## 4. 改善案

### 案 B: FxEmbed API の Article 対応を検証・活用（★ 本命）

```
iOS Shortcut → CF Worker → FxEmbed API (article + media 対応を追加)
                          → Syndication (fallback)
                          → GitHub Issue
```

- **コスト: 無料**
- PR #1702 マージにより article データが返る可能性が高い
- 対応していれば Worker 側の型定義・整形ロジックを更新するだけ
- リスク: 非公式のため保証なし

### 案 A: X API v2 を Primary に追加

```
iOS Shortcut → CF Worker → X API v2 (primary)
                          → FxEmbed (fallback)
                          → Syndication (last resort)
                          → GitHub Issue
```

- コスト: $0.005/件 ≒ 1日10件で月 $1.5
- 最も確実。全データ公式に取得可能
- 必要: X Developer Account + Pay-Per-Use クレジット（最低 $5）+ Bearer Token

### 案 C: ハイブリッド（B + A フォールバック）

- 通常 → FxEmbed（無料）
- FxEmbed で article 取得失敗時 → X API v2（$0.005）
- コスト最適化しつつカバレッジ最大化

---

## 5. 検証結果（2026-03-19 実施）

### 検証対象

- URL: `https://x.com/trq212/status/2033949937936085378`
- 内容: Thariq (@trq212) による X Article「Lessons from Building Claude Code: How We Use Skills」
- エンドポイント: `api.fxtwitter.com/i/status/2033949937936085378`

### 結果: ✅ 案 B 実現可能（FxEmbed API がフルデータを返却）

| データ | 取得状況 | 内容 |
|--------|---------|------|
| `article.title` | ✅ | `"Lessons from Building Claude Code: How We Use Skills"` |
| `article.preview_text` | ✅ | 冒頭プレビューテキスト |
| `article.content.blocks` | ✅ | **全文テキスト** — Draft.js ブロック形式 |
| `article.content.entityMap` | ✅ | リンク（URL）+ インライン画像参照（mediaId） |
| `article.media_entities` | ✅ | **記事内画像 10枚** — `original_img_url` + width/height |
| `article.cover_media` | ✅ | カバー画像 — `original_img_url` (1920x768) |
| `article.created_at` | ✅ | `"2026-03-17T16:53:48.000Z"` |
| `article.modified_at` | ✅ | `"2026-03-17T16:53:48.000Z"` |
| `article.id` | ✅ | `"2033772621536591872"` |
| インラインスタイル | ✅ | Bold, header-one/two, unordered-list-item |

### Draft.js ブロック形式の詳細

`article.content.blocks` は Draft.js のブロック配列。各ブロック:

```json
{
  "key": "a55d1",
  "text": "What are Skills?",
  "type": "header-two",
  "inlineStyleRanges": [{ "offset": 0, "length": 16, "style": "Bold" }],
  "entityRanges": [{ "key": 0, "offset": 39, "length": 16 }],
  "data": {}
}
```

**ブロックタイプ**:
- `unstyled` — 通常段落
- `header-one` — H1 見出し
- `header-two` — H2 見出し
- `unordered-list-item` — 箇条書き
- `atomic` — メディア埋め込み（entityRanges で entityMap 参照）

**entityMap エントリタイプ**:
- `LINK` — `{ url: "https://..." }`
- `MEDIA` — `{ mediaItems: [{ mediaId: "...", mediaCategory: "DraftTweetImage" }] }`

### 画像データ（media_entities）

記事内の画像は `article.media_entities[]` で取得可能:

```json
{
  "media_id": "2033780836705964036",
  "media_info": {
    "__typename": "ApiImage",
    "original_img_url": "https://pbs.twimg.com/media/HDlw5ULbEAQOqtJ.jpg",
    "original_img_height": 460,
    "original_img_width": 1640
  }
}
```

### 通常ツイートフィールドの注意点

- `tweet.text` は空文字列 `""` — アーティクルポストはツイート本文を持たない
- `tweet.media` は `null` — メディアは `article.media_entities` に格納
- `tweet.is_note_tweet` は `false` — note_tweet とは別物

---

## 6. 実装方針

### 必要な変更

1. **`FxTweetResponse` 型に `article` フィールドを追加**
   - `article.title`, `preview_text`, `cover_media`, `content`, `media_entities`
   - `content.blocks[]` の型定義（Draft.js Block）

2. **Draft.js → Markdown 変換関数を追加**
   - `header-one` → `# text`
   - `header-two` → `## text`
   - `unstyled` → `text`
   - `unordered-list-item` → `- text`
   - `atomic` + MEDIA entity → `![media](url)`
   - `Bold` inline style → `**text**`
   - `LINK` entity → `[text](url)`

3. **`formatRichBody()` を拡張**
   - `tweet.article` が存在する場合、通常ツイート形式ではなくアーティクル形式で整形
   - カバー画像を Issue 冒頭に表示
   - 記事内画像を本文中の適切な位置に挿入

4. **Issue タイトルの改善**
   - アーティクルの場合: `[X Article] @screen_name: {article.title}`

### 通常ツイートへの影響

- `tweet.article` が `undefined`/`null` の場合は従来のロジックがそのまま動作
- 後方互換性に問題なし

---

## Sources

- [X API Pricing](https://docs.x.com/x-api/getting-started/pricing)
- [X API Pay-Per-Use Pilot](https://devcommunity.x.com/t/announcing-the-x-api-pay-per-use-pricing-pilot/250253)
- [X API Cost Details](https://www.getxapi.com/blogs/twitter-api-cost)
- [X API Pricing 2026 Comparison](https://zernio.com/blog/twitter-api-pricing)
- [X API Data Dictionary](https://docs.x.com/x-api/fundamentals/data-dictionary)
- [X API Fields Reference](https://docs.x.com/x-api/fundamentals/fields)
- [FxTwitter Article Support Issue #867](https://github.com/FixTweet/FxTwitter/issues/867)
- [FxEmbed GitHub](https://github.com/FxEmbed/FxEmbed)
- [FxEmbed API Wiki](https://github.com/FxEmbed/FxEmbed/wiki/API-Home)
- [FxTwitter Status Fetch API Docs](https://docs.fxtwitter.com/en/latest/api/status.html)
- [vxTwitter GitHub](https://github.com/dylanpdx/BetterTwitFix)
