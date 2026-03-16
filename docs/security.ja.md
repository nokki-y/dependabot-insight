# セキュリティ設計

> [English](./security.md) | 日本語

このドキュメントでは、dependabot-insight のセキュリティアーキテクチャについて説明します。データがどこに送信されるか、どのような保護機能が組み込まれているか、プライベートリポジトリで使用する際の注意事項を記載しています。

## 用語定義

- **対象リポジトリ**: dependabot-insight を導入し、Dependabot PR の解析を行うリポジトリ。つまり、この Action をワークフローに追加するリポジトリのこと。

## データフロー

```
┌─────────────────────────────────────────────────────────────┐
│  対象リポジトリ（この Action を導入する側）                   │
│                                                             │
│  読み取るファイルと目的:                                      │
│  ・package.json       … 依存区分の判定                       │
│                         （dependencies / devDependencies）   │
│  ・package-lock.json  … 推移的依存関係の追跡                  │
│  ・tsconfig.json      … パスエイリアスの解決                  │
│  ・src/**/*.ts(x)     … import/export 宣言の収集             │
│                         （AST 解析のため全文を読み取るが、    │
│                          PRコメントにも Claude API にも       │
│                          ソースコード本文は含めない）          │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ 静的解析（GitHub Actions ランナー上で実行）
                           ▼
              ┌──────────────────────────┐
              │  影響解析                 │
              │                          │
              │  抽出する情報:            │
              │  ・パッケージ名           │
              │  ・ファイルパス           │
              │  ・ルートパス             │
              │  ・ファイル数             │
              │                          │
              │  ※ ソースコード本文は     │
              │    PRコメントにも         │
              │    Claude API にも        │
              │    含めない               │
              └────────────┬─────────────┘
                           │
                ┌──────────┼──────────┐
                ▼                     ▼
      ┌────────────────────────┐  ┌─────────────────────────────┐
      │  GitHub PRコメント     │  │  Claude API                 │
      │  投稿                  │  │  （anthropic-api-key         │
      │                        │  │   設定時のみ送信）           │
      │  投稿する情報:         │  │                              │
      │  静的解析の結果を      │  │  送信する情報:               │
      │  PRコメントとして投稿  │  │                              │
      │  （影響サマリー）      │  │  ・影響サマリー              │
      │                        │  │   （PRコメントと同一内容）   │
      │                        │  │  ・QAレポートの出力形式を    │
      │                        │  │    指定するプロンプト        │
      │                        │  │                              │
      │                        │  │  返却される情報:             │
      │                        │  │  ・パッケージの必要性判断    │
      │                        │  │  ・テストケースと確認手順    │
      │                        │  │  （= QAレポート。            │
      │                        │  │    PRコメントとして投稿）    │
      └────────────────────────┘  └─────────────────────────────┘
```

### PRコメントに投稿される情報

レビュワーが「更新パッケージの影響がどのページに到達するか」を判断できるよう、以下の情報をPRコメントに含めます:

- **パッケージ名と依存区分** — 更新対象パッケージの特定と、dependencies / devDependencies / transitive の分類
- **相対ファイルパス**（例: `src/components/Button.tsx`）— 更新パッケージを直接 import しているファイルの特定
- **ルートパターン**（例: `/admin/users/:id`）— import グラフを辿った結果、影響が到達する Next.js ページ。レビュワーが動作確認すべき画面を示す
- **ファイル数・ページ数** — 影響範囲の規模の把握

### Claude API に送信される情報

`anthropic-api-key` が設定されている場合のみ送信されます。送信されるデータは影響解析サマリー（PRコメントに投稿される内容と同一）です:

- パッケージ名と依存区分
- 相対ファイルパス
- ルートパターン
- ファイル数・ページ数

**送信されないもの:**

- ソースコード本文（ファイルの中身は送信のために読み取られない）
- 環境変数やシークレット
- リポジトリの認証情報
- Git 履歴やコミットメッセージ

### ローカルに留まる情報（GitHub Actions ランナー内のみ）

- 対象リポジトリのソースコードファイル（AST 解析のために読み取られるが、PRコメントにも Claude API にもソースコード本文は含めない）
- 対象リポジトリの `package-lock.json` の内容（依存ツリー解析のためにローカルで解析）
- 対象リポジトリの `tsconfig.json` の内容（パスエイリアス解決のためにローカルで解析）
- すべてのトークン・APIキー（認証済みAPI呼び出しにのみ使用）

## この Action が扱う環境変数の一覧

dependabot-insight が使用する環境変数は以下の通りです。これ以外の環境変数は読み取りません。

| 環境変数 | 秘匿対象 | 用途 |
|---------|----------|------|
| `GITHUB_TOKEN` | **はい** | PRコメントの投稿・更新、PR情報の取得に使用 |
| `ANTHROPIC_API_KEY` | **はい** | Claude API への QA レポート生成リクエストに使用 |
| `BASE_URL` | **はい** | QA レポート内の GUI 確認用 URL のベース。社内 URL が含まれる可能性があるためマスキング対象 |
| `REPOSITORY` | いいえ | 対象リポジトリの `owner/repo`（GitHub Actions が自動設定。公開情報） |
| `PR_NUMBER` | いいえ | 解析対象の PR 番号 |
| `DEPENDENCY_NAMES` | いいえ | 更新対象のパッケージ名（カンマ区切り） |
| `UPDATE_TYPE` | いいえ | 更新種別（`patch` / `minor` / `major` / `unknown`） |
| `AI_MODEL` | いいえ | Claude API に送信するモデル名 |
| `AI_LANGUAGE` | いいえ | QA レポートの言語コード |
| `IMPACT_OUTPUT_PATH` | いいえ | 影響解析結果の一時ファイルパス（ランナー内のみ） |
| `DRY_RUN` | いいえ | `true` の場合、PRコメント投稿をスキップ |

「秘匿対象」の環境変数は、ログへのマスキングとエラーメッセージのサニタイズの対象です（詳細は以下のセクションで説明）。

## 利用者向けの保護機能（Action 実行時）

この Action を導入したリポジトリで Dependabot PR が作成され、Action が実行される際に機能する保護です。

### 1. ログにおける `GITHUB_TOKEN` / `ANTHROPIC_API_KEY` / `BASE_URL` のマスキング

`GITHUB_TOKEN`、`ANTHROPIC_API_KEY`、`BASE_URL` は GitHub Actions の `::add-mask::` メカニズムに2段階で登録されます:

- **action.yml**: すべてのステップ実行前に上記3つの値をマスク登録
- **スクリプト**: 多層防御として、各スクリプト（`impact-analysis.ts`, `test-recommendation.ts`）が起動時に同じ値をマスク登録

マスク登録後、GitHub Actions はすべてのログ出力においてこれらの値を自動的に `***` に置換します。

### 2. エラーメッセージのサニタイズ

GitHub PRコメント投稿や Claude API 呼び出しが失敗した場合、エラーメッセージにトークンやキーが含まれる可能性があります。両スクリプトはログ出力前にエラーメッセージから以下のパターンを除去します:

- `Bearer <GITHUB_TOKEN の値>` → `Bearer ***`
- Anthropic API キーのパターン（`sk-ant-*`）→ `***`
- GitHub トークンのパターン（`ghp_*`, `gho_*`, `ghs_*`, `ghr_*`）→ `***`
- `GITHUB_TOKEN`、`ANTHROPIC_API_KEY`、`BASE_URL` の値そのものとの完全一致 → `***`

## 開発者向けの保護機能（dependabot-insight 自体の開発時）

dependabot-insight リポジトリにコントリビュートする開発者が、誤ってシークレットをコミットすることを防止する保護です。

### 3. gitleaks によるシークレットスキャン

[gitleaks](https://github.com/gitleaks/gitleaks) が2段階で構成されています:

- **CI**（`.github/workflows/gitleaks.yml`）: すべての push と PR でスキャン。800種類以上のシークレットパターンに対応
- **ローカル**（`.pre-commit-config.yaml`）: pre-commit フックとして利用可能。`pre-commit install` でインストール

### 4. `.gitignore` と `.env.example`

- `.env` およびすべての `.env.*` バリアントは gitignore 対象
- `.env.example` は空の値のテンプレートを提供（実際の認証情報は含まない）

## プライベートリポジトリでの注意事項

対象リポジトリがプライベートの場合、以下の情報がPRコメントおよび Claude API に送信されることに注意してください。

### PRコメント（リポジトリの全コラボレーターに公開）

- 内部のファイルパスとディレクトリ構造
- ルートパターン（機能名や内部URLが推測される可能性あり）
- パッケージ名と依存関係

### Claude API への送信（`anthropic-api-key` 設定時）

上記と同じ情報が Anthropic の API に送信されます。[Anthropic の API 利用規約](https://www.anthropic.com/api-terms) によると、API 入力はモデルの学習には使用されません。ただし、組織のセキュリティポリシーが内部メタデータの Anthropic API への送信を禁止している場合は、`anthropic-api-key` を省略してください。Claude API を呼び出すことなく、静的影響解析のみが PR コメントとして投稿されます。

### FAQ

**Q. Claude API にデータを送信したくない場合は？**

`anthropic-api-key` を省略してください。Claude API を呼び出さず、GitHub 内で完結する静的影響解析のみが PR コメントとして投稿されます。

**Q. PRコメントにファイルパスを表示したくない場合は？**

現時点では未対応です。代わりに `DRY_RUN=true` を設定してローカルで実行し、結果を手元で確認する方法を検討してください。

**Q. fork PR を経由した secrets 窃取攻撃は防げるか？**

この Action は以下の2つのイベントで実行されます:

- **Dependabot が PR を作成・更新した時**（GitHub Actions の `pull_request` イベント）— 自動実行
- **誰かが PR に `/dep-insight` とコメントした時**（GitHub Actions の `issue_comment` イベント）— 手動再実行

それぞれに対して、GitHub Actions の仕組みとこの Action の実装の2層で保護されています。

**Dependabot が PR を作成・更新した時（`pull_request` イベント）:**
- fork PR には secrets が渡されません（GitHub Actions の仕様）。fork PR から `GITHUB_TOKEN` や `ANTHROPIC_API_KEY` にアクセスすることはできません
- Dependabot 以外の PR で実行されるかどうかは、利用者のワークフロー側の `if` 条件で制御します（README の設定例では `dependabot[bot]` のみに限定）

**誰かが PR にコメントした時（`issue_comment` イベント）:**
- このイベントでは secrets が渡るため、この Action は PR 作成者が `dependabot[bot]` であることを GitHub API 経由で検証し、**Dependabot 以外が作成した PR では実行を拒否します**
- `dependabot[bot]` は GitHub が内部管理する bot アカウントであり、一般ユーザーが `[bot]` サフィックス付きのアカウントを作成することはできません。GitHub API の `author.login` は GitHub が認証した値を返すため、なりすましは不可能です
- 加えて、`/dep-insight` コマンドの実行権限を `MEMBER` / `OWNER` / `COLLABORATOR` に限定することを、利用者のワークフロー側で設定可能です（README の設定例を参照）
