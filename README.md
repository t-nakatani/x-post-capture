# X Post Capture Worker

X (Twitter) の投稿を iOS ショートカットの 2 タップでこのリポジトリの GitHub Issue に保存する。

## アーキテクチャ

```
[X app] → Share Sheet → [iOS Shortcut] → POST → [CF Worker] → FxTwitter → GitHub Issue
```

- **FxEmbed（旧 FxTwitter）**: ツイート内容・アーティクル・画像を無料で取得（best-effort）
- **GitHub Issues**: `x-capture` ラベル付きで inbox として蓄積
- **重複防止**: tweet_id で既存 Issue を検索してから作成
- **対応コンテンツ**: 通常ツイート / X Article（長文記事）/ 画像・動画付きツイート

## セットアップ

### 1. Cloudflare Workers

```bash
cd platforms/claude_platform/x-post-capture-worker
bun install

# Cloudflare にログイン
bunx wrangler login

# シークレットを設定
bunx wrangler secret put GITHUB_TOKEN   # Fine-grained PAT (Issues: write)
bunx wrangler secret put API_KEY         # 任意の文字列（iOS Shortcut の認証用）

# デプロイ
bun run deploy
```

デプロイ後、`https://x-post-capture.<your-subdomain>.workers.dev` が発行される。

### 2. GitHub PAT（Fine-grained）

1. https://github.com/settings/personal-access-tokens/new
2. Repository access: **Only select repositories** → `bot_platform_2026`
3. Permissions:
   - **Issues**: Read and write
   - **Metadata**: Read（自動付与）
4. 有効期限: 90 日推奨（期限前に再発行）

### 3. GitHub Label

リポジトリに `x-capture` ラベルを作成:

```bash
gh label create x-capture --description "X post captures from iOS Shortcut" --color "1DA1F2"
```

### 4. iOS ショートカット

iPhone の「ショートカット」アプリで新規作成:

#### アクション構成（全 5 ステップ）

1. **Receive** `URLs` from Share Sheet
   - Details → "Show in Share Sheet" をオン
   - Input を "URLs" に限定

2. **URL**
   - `https://x-post-capture.<your-subdomain>.workers.dev`

3. **Get Contents of URL**
   - Method: `POST`
   - Headers:
     - `Content-Type`: `application/json`
     - `X-API-Key`: `<API_KEY と同じ値>`
   - Request Body: **JSON**
     - Key: `url`, Value: `Shortcut Input`

4. **Get Value for Key** `status`

5. **Show Notification**
   - Title: `X Capture`
   - Body: `Dictionary Value`（= "ok" or "duplicate"）

#### Share Sheet に固定

- Share Sheet 下部の「Edit Actions」→ ショートカットを Favorites に追加
- 上位にドラッグ → 2 タップ目で最上部に表示される

### 使い方

1. X アプリでツイートの **共有ボタン** (↑) をタップ
2. Share Sheet で **ショートカット名** をタップ
3. 通知で "ok" が出れば完了

## Issue フォーマット

### 通常ツイート

```
タイトル: [X] @screen_name: ツイート本文（60文字まで）...
ラベル: x-capture

> ツイート本文
>
— **Author Name** (@screen_name) · Wed Oct 28 03:49:11 +0000 2022

### Engagement
Likes: 2203353 · RT: 300086 · Replies: 122922 · Bookmarks: 8211

### Media
![media](https://...)

---
**URL**: https://x.com/...
**Tweet ID**: 1585841080431321088
**Lang**: en · **Source**: Twitter for iPhone
```

### X Article（長文記事）

```
タイトル: [X Article] @screen_name: 記事タイトル（60文字まで）...
ラベル: x-capture

![cover](https://pbs.twimg.com/media/...)

**Author Name** (@screen_name) · 2026-03-17T16:53:48.000Z

記事本文（Markdown 変換済み）
- 見出し（H1/H2）、太字、リンク、箇条書きを保持
- 記事内画像は本文中に挿入

---
### Engagement
Likes: 14331 · RT: 1931 · Replies: 321 · Bookmarks: 40004

**URL**: https://x.com/...
**Tweet ID**: ...
**Article ID**: ...
```

### 内容取得失敗時（URL のみ）

```
タイトル: [X] 1585841080431321088
ラベル: x-capture

*(FxTwitter で内容を取得できませんでした)*

**URL**: https://x.com/...
**Tweet ID**: 1585841080431321088
```

## 開発

```bash
# ローカル開発
bun run dev

# テスト（curl）
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-key" \
  -d '{"url": "https://x.com/elonmusk/status/1585841080431321088"}'

# ログ
bun run tail
```

## トラブルシュート

| 症状 | 原因 | 対処 |
|------|------|------|
| 401 Unauthorized | API_KEY 不一致 | Shortcut の X-API-Key と `wrangler secret put API_KEY` の値を確認 |
| 502 GitHub API error | PAT 期限切れ or 権限不足 | PAT を再発行して `wrangler secret put GITHUB_TOKEN` |
| "duplicate" 返却 | 同じツイートを再キャプチャ | 正常動作。重複防止が機能している |
| FxEmbed 失敗 | FxEmbed サービスダウン | Syndication API にフォールバック → それも失敗なら URL のみで Issue 作成 |
| Article 本文が空 | FxEmbed が article フィールドを返さない | 通常ツイートとして処理される（フォールバック動作） |

## データ取得の仕組み

本 Worker は X の公式 Developer API (v2) を使わず、以下の非公式 API でツイート内容を取得している。

### フォールバックチェーン

```
FxEmbed API (primary) → Syndication API (fallback) → URL のみ保存 (last resort)
```

### FxEmbed（旧 FxTwitter）

- **仕組み**: X のウェブクライアント（x.com）が使う**内部 GraphQL API** をリバースエンジニアリングして、同じリクエストを Cloudflare Worker から送信している
- **認証**: X のウェブサイトは未ログインでも公開ツイートを表示できる。その際に発行される「ゲストトークン」を取得して内部 API にアクセスする
- **提供データ**: ツイート本文、著者、エンゲージメント、メディア、**X Article 全文**（Draft.js 形式）
- **リスク**: X が内部 API のエンドポイントやゲストトークンの仕様を変更すると壊れる。2023年に実際に一度壊れ、GraphQL エンドポイントへの移行で復旧した経緯がある（[Issue #333](https://github.com/FixTweet/FxTwitter/issues/333)）
- **X が塞げない理由**: この GraphQL API は X 自身のウェブサイトが動作するために必要であり、完全にブロックすると x.com 自体が動かなくなる

### Syndication API

- **仕組み**: X が公式に提供している**ツイート埋め込み（embed）用インフラ**のバックエンド。ブログやニュースサイトの「ツイートを埋め込む」機能がこの API に依存している
- **エンドポイント**: `cdn.syndication.twimg.com/tweet-result?id={id}&token=0`
- **提供データ**: ツイート本文、著者、いいね数など（メディアやアーティクルは含まれない）
- **リスク**: 非公式だがドキュメント化はされていない。X がこの API を塞ぐと世界中のサイトのツイート埋め込みが壊れるため、比較的安定している
- **制約**: FxEmbed より返却データが貧弱（メディア・アーティクル・RT 数なし）

### X 公式 API v2（未使用・バックアッププラン）

2026年2月に従量課金（Pay-Per-Use）に移行。ツイート読み取り $0.005/件、最低購入 $5。
FxEmbed が恒久的に壊れた場合の切り替え先として検討。詳細は `.laboratory/x-post-capture/article_image_improvement_survey.md` を参照。

### 安定性の比較

| 手段 | 根拠 | 安定性 | コスト |
|------|------|--------|--------|
| X API v2（公式） | 契約・課金に基づくアクセス権 | 最も安定 | $0.005/件 |
| FxEmbed | 内部 GraphQL API のリバースエンジニアリング | X の変更で壊れうる | 無料 |
| Syndication API | 公式 embed 用インフラ（ドキュメントなし） | 比較的安定 | 無料 |
