# テストガイド

> [English](./testing.md) | 日本語

このドキュメントでは、dependabot-insight の開発中にテストを実行する方法を説明します。

## 前提条件

- Node.js 20+
- npm
- Dependabot PR が存在するリポジトリ（例: dependabot-insight を導入する対象リポジトリ）

## 1. ローカルでのスクリプト実行（DRY_RUN）

対象リポジトリに対してスクリプトを直接実行します。PR コメントの投稿はスキップされます。

### impact-analysis.ts

```bash
cd /path/to/対象リポジトリ

DEPENDENCY_NAMES=flatted \
UPDATE_TYPE=patch \
DRY_RUN=true \
  npx tsx /path/to/dependabot-insight/src/impact-analysis.ts
```

実行される処理:
- 対象リポジトリのソースファイルをスキャン
- import グラフを構築し、ページ/ルートへの影響到達を追跡
- 影響サマリーをコンソールに出力（PR コメントは投稿されない）

### test-recommendation.ts

まず `impact-analysis.ts` を `IMPACT_OUTPUT_PATH` 付きで実行し、解析結果を保存します:

```bash
cd /path/to/対象リポジトリ

DEPENDENCY_NAMES=flatted \
UPDATE_TYPE=patch \
DRY_RUN=true \
IMPACT_OUTPUT_PATH=/tmp/dependabot-impact-analysis.md \
  npx tsx /path/to/dependabot-insight/src/impact-analysis.ts
```

次にその出力を使って `test-recommendation.ts` を実行します:

```bash
ANTHROPIC_API_KEY=sk-ant-... \
IMPACT_OUTPUT_PATH=/tmp/dependabot-impact-analysis.md \
AI_MODEL=claude-sonnet-4-6 \
AI_LANGUAGE=ja \
DRY_RUN=true \
  npx tsx /path/to/dependabot-insight/src/test-recommendation.ts
```

実行される処理:
- 一時ファイルから影響解析結果を読み取り
- Claude API を呼び出して QA レポートを生成
- QA レポートをコンソールに出力（PR コメントは投稿されない）

### DRY_RUN がスキップする処理

| 動作 | DRY_RUN=true | 通常実行 |
|------|-------------|---------|
| 対象リポジトリのスキャン | 実行する | 実行する |
| import グラフの構築 | 実行する | 実行する |
| Claude API の呼び出し | 実行する（test-recommendation.ts のみ） | 実行する |
| PR コメントの投稿 | **スキップ**（コンソールに出力） | 実行する |

## 2. 統合テスト（ブランチ指定）

action.yml のオーケストレーションを含む Action パイプライン全体をテストするには、別リポジトリのワークフローから開発ブランチを参照します。

### ステップ 1: 開発ブランチをプッシュ

```bash
cd /path/to/dependabot-insight
git push origin feature/ブランチ名
```

### ステップ 2: 対象リポジトリにテスト用ワークフローを作成

対象リポジトリに `.github/workflows/test-dependabot-insight.yml` を作成します:

```yaml
name: Test Dependabot Insight

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  test:
    if: github.event.pull_request.user.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: nokki-y/dependabot-insight@feature/ブランチ名  # 開発ブランチを指定
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### ステップ 3: Dependabot PR でトリガー

対象リポジトリの Dependabot PR でワークフローが実行され、開発ブランチのコードで Action が動作します。

### 確認すべき項目

- [ ] Action がエラーなく完了する
- [ ] 影響解析コメントが PR に投稿され、依存区分が正しい
- [ ] QA レポートコメントが投稿される（`ANTHROPIC_API_KEY` 設定時）
- [ ] 影響が到達するページ/ルートが期待通り
- [ ] ワークフローログにシークレットが表示されていない

### クリーンアップ

テスト後、対象リポジトリからテスト用ワークフローを削除します:

```bash
git rm .github/workflows/test-dependabot-insight.yml
git commit -m "Remove dependabot-insight test workflow"
```

## 3. 型チェック

スクリプトを実行せずに TypeScript の型を検証します:

```bash
cd /path/to/dependabot-insight
npx tsc --noEmit
```
