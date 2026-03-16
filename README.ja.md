# dependabot-insight

静的解析で Dependabot PR の影響範囲を特定し、AIによる品質保証レポートを自動生成する GitHub Action です。

> [English](./README.md) | 日本語

## 何ができるか

Dependabot が PR を作成すると、この Action が自動的に以下を実行します:

1. **パッケージの依存区分を判定** — ランタイム依存（dependencies）か、開発時依存（devDependencies）か、他パッケージの内部依存（transitive）かを特定
2. **影響が到達するページ・APIルートを追跡** — TypeScript AST 解析でimportグラフを辿り、更新パッケージから到達可能な Next.js のページ・APIルートを特定
3. **他パッケージ経由の影響を分析** — 直接 import がない場合、`package-lock.json` を解析して推移的依存関係を追跡
4. **AIによる品質保証レポートを生成** — Claude API を使い、リスク評価付きの具体的なテスト計画を作成

結果は PR コメントとして投稿され、レビュワーがマージ判断に必要な情報をすべて提供します。

### 出力例

<details>
<summary>影響解析コメント</summary>

> ## 影響解析
>
> ### パッケージの位置づけ
>
> | パッケージ | 依存区分 | 説明 |
> |---|---|---|
> | `dompurify` | **dependencies** | package.json の dependencies に記載。ランタイムで使用される |
>
> ### 影響サマリー
>
> | 項目 | 値 |
> |------|-----|
> | 更新種別 | `patch` |
> | ソースコードで直接 import しているファイル数 | 3 |
> | 影響が到達するページ数 | 5 |
> | 影響が到達するAPIルート数 | 0 |
>
> ### 影響が到達するページ
>
> - `/admin/surveys/:id/edit`
> - `/admin/reports/:id`
> - ...

</details>

<details>
<summary>AI 品質保証レポートコメント</summary>

> ## 品質保証レポート
>
> ### 1. パッケージの必要性
> `dompurify` は HTML サニタイズに使用されるランタイム依存です。削除すると XSS 対策が無効になります。
>
> ### 2. リスク評価
>
> | 評価軸 | スコア | 根拠 |
> |--------|--------|------|
> | 依存の種類 | 3/3 | ソースコードで直接 import されている |
> | ライブラリカテゴリ | 3/3 | セキュリティライブラリ（サニタイズ） |
> | 影響ページ数 | 2/3 | 5ページ |
> | 更新種別 | 0/3 | patch |
> | 機能の重要度 | 3/3 | セキュリティの中核機能 |
> | **合計** | **11/15** | **🔴 高** |
>
> ### 3. 品質保証計画
>
> | No. | 検証対象 | 確認方法 | 期待結果 |
> |-----|---------|---------|---------|
> | 1 | リッチテキストエディタ | `/admin/surveys/:id/edit` を開き、HTML コンテンツを入力 | コンテンツが正しくサニタイズされること |
> | ... | ... | ... | ... |

</details>

## セットアップ

### 1. シークレットの設定

リポジトリの **Settings > Secrets and variables > Actions** で以下を追加してください:

| シークレット | 必須 | 説明 |
|------------|------|------|
| `ANTHROPIC_API_KEY` | No | [Anthropic Console](https://console.anthropic.com/) から取得した API キー。AI 品質保証レポートの生成に必要。省略時は静的解析のみ投稿 |

> `GITHUB_TOKEN` は GitHub Actions が自動提供するため、手動設定は不要です。

### 2. ワークフローファイルの作成

`.github/workflows/dependabot-insight.yml` を作成してください:

```yaml
name: Dependabot Insight

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  analyze:
    if: |
      (github.event_name == 'pull_request' && github.event.pull_request.user.login == 'dependabot[bot]') ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request && contains(github.event.comment.body, '/dep-insight'))
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: nokki-y/dependabot-insight@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          ai-language: ja
```

### コメントでトリガー

Dependabot PR に `/dep-insight` とコメントすると、手動で解析を実行できます。

### 入力パラメータ

| パラメータ | 必須 | デフォルト | 説明 |
|-----------|------|-----------|------|
| `github-token` | Yes | — | PR コメント投稿用の GitHub トークン |
| `anthropic-api-key` | No | — | AI 品質保証レポート生成用の Anthropic API キー。省略時は静的解析のみ投稿 |
| `ai-model` | No | `claude-sonnet-4-20250514` | QA レポート生成に使用する Claude モデル |
| `ai-language` | No | `en` | AI レポートの言語（`en`, `ja` 等） |
| `base-url` | No | — | GUI 確認用リンクのベース URL（例: Vercel プレビュー URL） |

## 仕組み

```
Dependabot PR 作成
        │
        ▼
┌──────────────────────────────┐
│  パッケージの依存区分を判定    │  package.json → dependencies / devDependencies / transitive
└───────────┬──────────────────┘
            │
            ▼
┌──────────────────────────────┐
│  import を AST 解析          │  TypeScript AST → import/require/export 宣言を収集
└───────────┬──────────────────┘
            │
            ▼
┌──────────────────────────────┐
│  import グラフを構築          │  ファイル A → B → C の依存関係を有向グラフ化
└───────────┬──────────────────┘
            │
            ▼
┌──────────────────────────────┐
│  BFS でページ到達性を探索     │  逆方向に探索 → page.tsx / route.ts に到達するか判定
└───────────┬──────────────────┘
            │
     ┌──────┴──────┐
     │ ページなし？ │
     └──────┬──────┘
            │ Yes
            ▼
┌──────────────────────────────┐
│  他パッケージ経由の影響を分析  │  package-lock.json → どのパッケージが更新対象に依存しているか
└───────────┬──────────────────┘
            │
            ▼
┌──────────────────────────────┐
│  影響解析コメントを投稿       │  → PR コメント（影響サマリー）
└───────────┬──────────────────┘
            │
            ▼
┌──────────────────────────────┐
│  AI 品質保証レポートを生成    │  Claude API → リスク評価 + テスト計画
└───────────┬──────────────────┘
            │
            ▼
┌──────────────────────────────┐
│  QA レポートコメントを投稿    │  → PR コメント（品質保証レポート）
└──────────────────────────────┘
```

## 前提条件

- **npm** — 推移的依存関係の解析に `package-lock.json` を使用します。yarn・pnpm には未対応です。
- **Next.js App Router** — App Router の規約に基づき `page.tsx` / `route.ts` への影響到達を追跡します。

### Next.js App Router 対応状況

- `page.tsx` / `page.ts` をページとして検出
- `app/api/` 配下の `route.ts` を API ルートとして検出
- `tsconfig.json` のパスエイリアスを解決
- Route Groups `(group)`、Dynamic Segments `[id]`、Catch-all `[...slug]` に対応

> 他のパッケージマネージャー（yarn、pnpm）やフレームワーク（Pages Router、Remix、SvelteKit 等）は今後のリリースで対応予定です。

## セキュリティ

### 外部に送信されるデータ

| 送信先 | 送信される情報 | 送信されない情報 |
|--------|--------------|----------------|
| **GitHub API** | PRコメント（影響サマリー、QAレポート） | ソースコード、トークン |
| **Claude API** | 影響解析サマリー（パッケージ名、ルートパス、ファイル数） | ソースコード本文、トークン、認証情報 |

### 組み込みの保護機能

- **シークレットマスキング** — `GITHUB_TOKEN` と `ANTHROPIC_API_KEY` を起動時に `::add-mask::` で登録。GitHub Actions のログ出力から自動的に秘匿される
- **エラーサニタイズ** — APIエラーメッセージからトークンやキーを除去してからログ出力
- **ソースコード非送信** — Claude API には影響解析のメタデータ（パッケージ名、ファイルパス、ルートパターン）のみを送信。ソースコード本文は読み取りも送信もしない
- **最小権限** — Action に必要な権限は `contents: read`、`pull-requests: write`、`issues: write` のみ

### プライベートリポジトリでの使用

プライベートリポジトリで使用する場合、以下の情報が PR コメント（リポジトリアクセス権を持つ全員に公開）および Claude API に送信されることに注意してください:

- パッケージ名とバージョン
- ファイルパス（プロジェクトルートからの相対パス）
- ルートパターン（例: `/admin/users/:id`）

これが懸念される場合は、`anthropic-api-key` を省略することで AI QA レポートを無効化できます。その場合、GitHub 内で完結する静的影響解析のみが投稿されます。

## 開発

```bash
git clone https://github.com/nokki-y/dependabot-insight.git
cd dependabot-insight
npm install    # prepare スクリプトで pre-commit hook が自動設定されます
```

`npm install` により、シークレット（APIキー、トークン等）を含むコミットをブロックする pre-commit hook（`.githooks/pre-commit`）が自動設定されます。

### ローカル実行

環境変数テンプレートをコピーして値を設定してください:

```bash
cp .env.example .env
# .env に認証情報を記入（このファイルは絶対にコミットしないこと）
```

```bash
# 環境変数を設定
export GITHUB_TOKEN="..."
export ANTHROPIC_API_KEY="..."
export REPOSITORY="owner/repo"
export PR_NUMBER="123"
export DEPENDENCY_NAMES="package-name"
export UPDATE_TYPE="patch"
export DRY_RUN="true"

# 影響解析を実行
npx tsx src/impact-analysis.ts

# AI 品質保証レポートを生成
npx tsx src/test-recommendation.ts
```

## ライセンス

MIT
