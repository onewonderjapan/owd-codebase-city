/* ═══════════════════════════════════════════════════════════════════════
   数据建模：REPO 数组 → 城市模型（地块布局、配色、高度映射、问题标记）
   ═══════════════════════════════════════════════════════════════════════ */
import type { Issue } from "@contracts/types";

export interface RepoFile {
  path: string;
  loc: number;
  deps: string[];
  note?: string;
}

export interface CityFile extends RepoFile {
  i: number;
  dir: string;
  top: string;
  name: string;
  usedBy: string[];
  x: number;
  z: number;
  h?: number;
  sx?: number;
  sy?: number;
  isolated: boolean; // 出度 0 且入度 0
  issueRank: number; // 0 无 · 1 low · 2 medium · 3 high
  issueTypes: string[];
}

export interface Plot {
  dir: string;
  x: number;
  z: number;
  w: number;
  h: number;
  files: CityFile[];
  cols: number;
}

export interface Model {
  files: CityFile[];
  FMAP: Record<string, CityFile>;
  edges: { from: CityFile; to: CityFile }[];
  TOPS: string[];
  dirs: string[];
  plots: Plot[];
  shadeOf: Map<string, number>;
  maxLoc: number;
  maxUse: number;
  totalLoc: number;
  setHeightMode: (v: string) => void;
  getHeightMode: () => string;
  hOf: (f: CityFile) => number;
  colorOf: (f: CityFile) => string;
}

export const KVARS = ["--k1", "--k2", "--k3", "--k4", "--k5", "--k6"];
export const CELL = 7.2;
export const STREET = 6;

const cssv = (n: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const SEV_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

export function buildModel(REPO: RepoFile[], issues: Issue[] = []): Model {
  const rankOf = new Map<string, { rank: number; types: string[] }>();
  for (const iss of issues) {
    const r = SEV_RANK[iss.severity] ?? 1;
    for (const p of iss.files) {
      const cur = rankOf.get(p) ?? { rank: 0, types: [] };
      cur.rank = Math.max(cur.rank, r);
      if (!cur.types.includes(iss.type)) cur.types.push(iss.type);
      rankOf.set(p, cur);
    }
  }

  const DOC_RE = /\.(md|markdown|mdx|rst|txt|adoc)$/i;
  const files = REPO.map((f, i): CityFile => {
    const seg = f.path.split("/");
    return {
      ...f,
      i,
      dir: seg.slice(0, -1).join("/") || "(ルート)",
      top: seg.length > 1 ? seg[0] : "(ルート)",
      name: seg[seg.length - 1] || seg[seg.length - 2] || f.path,
      usedBy: [],
      x: 0,
      z: 0,
      isolated: false,
      issueRank: rankOf.get(f.path)?.rank ?? 0,
      issueTypes: rankOf.get(f.path)?.types ?? [],
    };
  });
  const FMAP = Object.fromEntries(files.map((f) => [f.path, f]));
  const edges: { from: CityFile; to: CityFile }[] = [];
  for (const f of files) {
    f.deps = f.deps.filter((d) => {
      if (!FMAP[d]) {
        console.warn("[city] 依赖对不上，已丢弃：", f.path, "→", d);
        return false;
      }
      return true;
    });
    for (const d of f.deps) {
      edges.push({ from: f, to: FMAP[d] });
      FMAP[d].usedBy.push(f.path);
    }
  }
  for (const f of files)
    f.isolated = f.deps.length === 0 && f.usedBy.length === 0 && !DOC_RE.test(f.path);

  const TOPS = [...new Set(files.map((f) => f.top))];
  const palette = KVARS.map(cssv);
  const colorOf = (f: CityFile) => palette[TOPS.indexOf(f.top) % palette.length];

  // 地块：每个目录一块地，按目录内文件数排成尽量方的网格；
  // 地块之间留一条街，否则相邻两个目录会看起来像同一个。
  const dirs = [...new Set(files.map((f) => f.dir))];
  const plots: Plot[] = [];
  {
    let row = 0,
      rowW = 0,
      rowH = 0;
    const MAXW = 74;
    for (const d of dirs) {
      const fs = files.filter((f) => f.dir === d);
      const n = Math.ceil(Math.sqrt(fs.length));
      const w = n * CELL + STREET,
        h = Math.ceil(fs.length / n) * CELL + STREET;
      if (rowW + w > MAXW && rowW > 0) {
        row += rowH;
        rowW = 0;
        rowH = 0;
      }
      plots.push({ dir: d, x: rowW, z: row, w, h, files: fs, cols: n });
      rowW += w;
      rowH = Math.max(rowH, h);
    }
    const maxX = Math.max(...plots.map((p) => p.x + p.w));
    const maxZ = Math.max(...plots.map((p) => p.z + p.h));
    for (const p of plots) {
      p.x -= maxX / 2;
      p.z -= maxZ / 2;
    }
  }
  for (const p of plots) {
    p.files.forEach((f, k) => {
      const cx = k % p.cols,
        cz = Math.floor(k / p.cols);
      f.x = p.x + STREET / 2 + cx * CELL + CELL / 2;
      f.z = p.z + STREET / 2 + cz * CELL + CELL / 2;
    });
  }

  const shadeOf = new Map<string, number>();
  for (const d of dirs) {
    const top = d.split("/")[0];
    const sibs = dirs.filter((x) => x.split("/")[0] === top);
    shadeOf.set(d, sibs.length > 1 ? sibs.indexOf(d) / (sibs.length - 1) : 0.5);
  }

  const maxLoc = Math.max(...files.map((f) => f.loc));
  const maxUse = Math.max(1, ...files.map((f) => f.usedBy.length));
  const totalLoc = files.reduce((a, f) => a + f.loc, 0);
  let heightMode = "loc";
  const hOf = (f: CityFile) =>
    heightMode === "loc" ? 1.5 + (f.loc / maxLoc) * 26 : 1.5 + (f.usedBy.length / maxUse) * 26;

  return {
    files,
    FMAP,
    edges,
    TOPS,
    dirs,
    plots,
    shadeOf,
    maxLoc,
    maxUse,
    totalLoc,
    setHeightMode: (v: string) => {
      heightMode = v;
    },
    getHeightMode: () => heightMode,
    hOf,
    colorOf,
  };
}

/* ── 内置示例仓库：首次打开时先有一座城可看 ── */
export const SAMPLE_REPO: RepoFile[] = [
  { path: "src/main.ts", loc: 142, deps: ["src/app/shell.ts", "src/core/store.ts", "src/core/log.ts"], note: "エントリ。やることは三つだけ：store 生成、shell マウント、グローバルエラーフックの登録。" },
  { path: "src/app/shell.ts", loc: 388, deps: ["src/app/router.ts", "src/ui/layout.ts", "src/core/store.ts"], note: "アプリの外殻。ルーティングとレイアウトの継ぎ目を担う。ページレベルの状態はすべてここに着地。" },
  { path: "src/app/router.ts", loc: 264, deps: ["src/core/store.ts"], note: "History API ベースの最小ルーター。静的セグメントとワイルドカード一つのみ対応。" },
  { path: "src/app/routes.ts", loc: 96, deps: ["src/app/router.ts", "src/views/home.ts", "src/views/detail.ts", "src/views/settings.ts"], note: "ルートテーブル。ページ追加はここだけ直せばよい。" },
  { path: "src/core/store.ts", loc: 512, deps: ["src/core/event.ts", "src/core/log.ts"], note: "リポジトリで最も依存されているファイル。購読可能な状態ツリー。変更前に依存元の一覧を確認すること。" },
  { path: "src/core/event.ts", loc: 186, deps: [], note: "Pub/Sub の最小実装。依存はなく、今後も持つべきではない。" },
  { path: "src/core/log.ts", loc: 124, deps: [], note: "構造化ログ。フィールド名を変えたら下流の収集ルールも同期して直すこと。" },
  { path: "src/core/http.ts", loc: 342, deps: ["src/core/log.ts", "src/core/retry.ts"], note: "タイムアウト・リトライ・キャンセル付きの fetch ラッパー。すべての通信はここを通る。" },
  { path: "src/core/retry.ts", loc: 98, deps: [], note: "指数バックオフ＋ジッター。ジッターは必須。ないとリトライが一斉に集中する。" },
  { path: "src/core/cache.ts", loc: 276, deps: ["src/core/event.ts", "src/core/log.ts"], note: "二段キャッシュ：メモリ LRU + IndexedDB。失効は key ではなくタグ単位。" },
  { path: "src/render/scene.ts", loc: 820, deps: ["src/render/shader.ts", "src/render/camera.ts", "src/core/store.ts"], note: "3D シーンの組み立て所。全リポジトリ最長のファイルで、分割すべき筆頭。" },
  { path: "src/render/shader.ts", loc: 604, deps: ["src/render/uniforms.ts"], note: "シェーダーソースとコンパイルキャッシュ。文字列連結部分は GLSL のバージョンプレフィックスに注意。" },
  { path: "src/render/uniforms.ts", loc: 188, deps: [], note: "uniform の型とデフォルト値。レンダリング層と UI 層の共通語彙。" },
  { path: "src/render/camera.ts", loc: 246, deps: ["src/core/event.ts"], note: "オービットカメラと減衰。操作感のすべてがこの百行に。" },
  { path: "src/render/picking.ts", loc: 164, deps: ["src/render/camera.ts"], note: "スクリーン空間ピッキング。点のサイズが可変なのでレイキャストより安定。" },
  { path: "src/ui/layout.ts", loc: 298, deps: ["src/ui/tokens.ts"], note: "グリッドとブレークポイント。三つだけ。四つ目を足す前に理由を考えること。" },
  { path: "src/ui/tokens.ts", loc: 132, deps: [], note: "デザイントークン。色・間隔・フォントサイズの唯一の出どころ。" },
  { path: "src/ui/table.ts", loc: 466, deps: ["src/ui/tokens.ts", "src/core/event.ts"], note: "仮想スクロールテーブル。ソートとフィルタはここ、ページングは呼び出し側。" },
  { path: "src/ui/chart.ts", loc: 534, deps: ["src/ui/tokens.ts", "src/core/store.ts"], note: "チャートのラッパー。テーマ変更時はインスタンス再生成が必要——既知の落とし穴。" },
  { path: "src/ui/dialog.ts", loc: 178, deps: ["src/ui/tokens.ts"], note: "ネイティブ dialog ベースのモーダル。フォーカストラップはブラウザ任せ。" },
  { path: "src/ui/toast.ts", loc: 112, deps: ["src/ui/tokens.ts", "src/core/event.ts"], note: "トーストキュー。同種のメッセージはマージされる。" },
  { path: "src/views/home.ts", loc: 352, deps: ["src/ui/chart.ts", "src/ui/table.ts", "src/core/http.ts"], note: "ホームダッシュボード。チャート三つと表一つ。データは同一の集約 API から。" },
  { path: "src/views/detail.ts", loc: 428, deps: ["src/render/scene.ts", "src/ui/dialog.ts", "src/core/http.ts", "src/core/cache.ts"], note: "詳細ページ。3D ビューを載せている唯一の場所。" },
  { path: "src/views/settings.ts", loc: 216, deps: ["src/ui/dialog.ts", "src/core/store.ts"], note: "設定ページ。バリデーションは送信時に一括。フィールドごとには行わない。" },
  { path: "server/index.ts", loc: 186, deps: ["server/routes.ts", "server/db.ts", "src/core/log.ts"], note: "サーバーエントリ。組み立てとグレースフルシャットダウンのみ担当。" },
  { path: "server/routes.ts", loc: 396, deps: ["server/handlers.ts", "server/auth.ts"], note: "ルート登録とミドルウェアの順序。順序自体がロジックなので軽々に変えないこと。" },
  { path: "server/handlers.ts", loc: 612, deps: ["server/db.ts", "server/schema.ts", "src/core/log.ts"], note: "業務処理。ドメイン別にファイル分割すべき。今は何でもここに詰め込まれている。" },
  { path: "server/auth.ts", loc: 288, deps: ["server/db.ts", "src/core/log.ts"], note: "認証ミドルウェア。トークン検証と権限判定——分離すべき二つの関心事。" },
  { path: "server/db.ts", loc: 344, deps: ["server/schema.ts", "src/core/retry.ts"], note: "コネクションプールとクエリビルダ。スロークエリログの閾値がここにハードコード。" },
  { path: "server/schema.ts", loc: 224, deps: [], note: "スキーマと型定義。フロント・バックエンド共有部分はここから生成。" },
  { path: "workers/ingest.ts", loc: 412, deps: ["server/db.ts", "server/schema.ts", "src/core/log.ts"], note: "データ取り込み。バッチ書き込み。バッチサイズは下流の遅延に適応。" },
  { path: "workers/report.ts", loc: 266, deps: ["server/db.ts", "src/core/log.ts"], note: "定期レポート。低負荷時間帯に実行。失敗時は次のウィンドウに再スケジュール。" },
  { path: "workers/cleanup.ts", loc: 148, deps: ["server/db.ts"], note: "期限切れデータの掃除。削除はソフトデリート。物理削除は四半期ごとの別タスク。" },
  { path: "tests/store.test.ts", loc: 284, deps: ["src/core/store.ts"], note: "" },
  { path: "tests/http.test.ts", loc: 198, deps: ["src/core/http.ts", "src/core/retry.ts"], note: "" },
  { path: "tests/render.test.ts", loc: 156, deps: ["src/render/scene.ts", "src/render/shader.ts"], note: "" },
  { path: "tests/api.test.ts", loc: 322, deps: ["server/routes.ts", "server/handlers.ts"], note: "" },
  { path: "docs/architecture.md", loc: 186, deps: [], note: "アーキテクチャ説明。コードと二バージョン分ズレている。変更前に突き合わせること。" },
  { path: "docs/runbook.md", loc: 142, deps: [], note: "当番ハンドブック。アラート項目と対処手順が一対一で対応。" },
  { path: "scripts/legacy-migrate.ts", loc: 210, deps: [], note: "前四半期のマイグレーションスクリプト。実行後、誰も触っていない。" },
];

export const SAMPLE_ISSUES: Issue[] = [
  {
    type: "isolated",
    severity: "low",
    title: "孤立ファイル 1 件",
    detail: "scripts/legacy-migrate.ts は何にも依存せず、誰からも依存されていません——使い捨てのまま忘れられたスクリプトのようです。",
    files: ["scripts/legacy-migrate.ts"],
  },
  {
    type: "giant",
    severity: "medium",
    title: "巨大ファイル 1 件",
    detail: "src/render/scene.ts は 820 行。全リポジトリ最長のファイルで、分割の第一候補です。",
    files: ["src/render/scene.ts"],
  },
  {
    type: "hub",
    severity: "low",
    title: "ハブファイル 2 件",
    detail: "src/core/store.ts は 6 箇所から参照されています。シグネチャの変更は街全体に波及します。",
    files: ["src/core/store.ts", "src/core/log.ts"],
  },
];
