# AGENTS.md — owd-codebase-city

本プロジェクトで作業する AI / 人のための入口。

## 統一標準の参照（正本）

このリポジトリ固有のルールに先立ち、以下の組織統一ルールを正本として参照すること（いずれもプライベート、組織メンバーのみアクセス可）：

- **`ai-ops/AI_RULES.md`** — 全社 AI 助手の統一グローバルルール（唯一の正本）。文字コード規律（UTF-8 無 BOM・LF）、QC バジェット、知識庫プロトコル、セキュリティ red line など。
- **`onewonderjapan/default-workspace`** — 共有ワークフロー・テンプレートの入口。`workflows/task-to-delivery.md`（タスクから交付まで）、`scripts/check_workspace.py`（ワークスペース事前チェック）。
- **`onewonderjapan/knowledge-base`** — 再利用可能な知識の正本。入库は `AGENTS.md` の四步（search → new → verify → submit）に従う。

## プロジェクト固有のルール

- スタック: React 19 + TypeScript + Vite / Hono + tRPC 11 / Drizzle ORM + MySQL / three.js
- 検証: 変更後は `npm run check`（型チェック）と `npm run build` を両方通すこと
- コミット前に凭据・`.env`・ビルド产物（`dist/`）が入っていないことを確認（`.gitignore` 済みだが再確認）
- このリポジトリは公開を前提とする: 組織内部のパス・凭据・顧客情報を一切書かない
- 解析ロジック（`api/analyze/`）を変えたら、実在の公開リポジトリで再解析して誤検出が増えていないか確認する
