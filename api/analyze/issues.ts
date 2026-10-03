// 問題検出レイヤー：依存グラフから孤立コード・循環依存・巨大ファイル・ハブ・高結合を見つける。
import type { Issue, RepoFile } from "../../contracts/types";

export interface GraphNode extends RepoFile {
  usedBy: string[];
}

const ENTRY_RE = /(^|\/)(main|index|app|App|server|cli|mod|manage|wsgi|asgi|__main__|setup)\.[a-z]+$/;
const TEST_RE = /(^|\/)(test_|.*[-_.](test|spec|tests)\.[a-z]+$|__tests__\/)/;

export function isEntry(path: string): boolean {
  const top = path.split("/").length <= 2;
  return (top && ENTRY_RE.test(path)) || path.endsWith("/__main__.py");
}
export function isTest(path: string): boolean {
  return TEST_RE.test(path) || /(^|\/)tests?\//.test(path);
}
/** ドキュメント類：import されるのが前提ではないので孤立・デッドコードに含めない */
export function isDoc(path: string): boolean {
  return /\.(md|markdown|mdx|rst|txt|adoc)$/.test(path);
}
/** ツールチェーンの設定ファイル：import されなくて当然なので孤立・デッドコードに含めない */
export function isToolchain(path: string): boolean {
  return /(^|\/)[^/]*\.config\.[a-z0-9]+$/.test(path);
}

/** Tarjan の SCC。size>1 の強連結成分をすべて返す */
export function findCycles(files: GraphNode[]): string[][] {
  const idx = new Map(files.map((f, i) => [f.path, i]));
  const low = new Array(files.length).fill(0);
  const num = new Array(files.length).fill(-1);
  const onStack = new Array(files.length).fill(false);
  const stack: number[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  for (let s = 0; s < files.length; s++) {
    if (num[s] >= 0) continue;
    const work: [number, number][] = [[s, 0]];
    while (work.length) {
      const [v, ci] = work[work.length - 1];
      if (ci === 0) {
        num[v] = low[v] = counter++;
        stack.push(v);
        onStack[v] = true;
      }
      const deps = files[v].deps;
      if (ci < deps.length) {
        work[work.length - 1][1] = ci + 1;
        const w = idx.get(deps[ci]);
        if (w === undefined) continue;
        if (num[w] < 0) work.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v], num[w]);
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1][0];
          low[p] = Math.min(low[p], low[v]);
        }
        if (low[v] === num[v]) {
          const scc: string[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = false;
            scc.push(files[w].path);
          } while (w !== v);
          if (scc.length > 1) sccs.push(scc);
        }
      }
    }
  }
  return sccs;
}

/**
 * @param scriptRefs package.json の scripts から直接参照されているファイルの集合。
 *   esbuild エントリや seed スクリプトなど、import ではなくコマンド経由で起動される
 *   ファイルを孤立・デッドコードの誤検出から外すために使う。
 */
export function detectIssues(files: GraphNode[], maxLoc: number, maxFanIn: number, scriptRefs: Set<string> = new Set()): Issue[] {
  const issues: Issue[] = [];
  const exempt = (p: string) => isTest(p) || isEntry(p) || isDoc(p) || isToolchain(p) || scriptRefs.has(p);

  // 孤立ファイル：出次数 0 かつ入次数 0 —— 依存グラフから完全に切れている
  const isolated = files.filter((f) => f.deps.length === 0 && f.usedBy.length === 0 && !exempt(f.path));
  if (isolated.length) {
    issues.push({
      type: "isolated",
      severity: isolated.length > files.length * 0.15 ? "medium" : "low",
      title: `孤立ファイル ${isolated.length} 件`,
      detail: "リポジトリ内の何も import せず、どこからも import されていないファイルです（*.config.* や package.json の scripts から起動されるファイルは除外済み）。忘れ去られた旧コード、配線漏れのモジュール、あるいは規約ベースで外部から読み込まれるファイルの可能性があります。1 件ずつ確認する価値があります。",
      files: isolated.map((f) => f.path).sort(),
    });
  }

  // デッドコード疑惑：入次数 0・出次数あり・エントリでもテストでもない
  const dead = files.filter((f) => f.usedBy.length === 0 && f.deps.length > 0 && !exempt(f.path));
  if (dead.length) {
    issues.push({
      type: "dead",
      severity: dead.length > files.length * 0.1 ? "high" : "medium",
      title: `デッドコード疑惑 ${dead.length} 件`,
      detail: "他のモジュールに依存しているのに、リポジトリ内のどこからも参照されておらず、ファイル名もエントリポイントらしくありません。リファクタリングの残滓の可能性が高いです。削除前に動的参照を一応 grep してください。",
      files: dead.map((f) => f.path).sort(),
    });
  }

  // 循環依存
  const cycles = findCycles(files);
  for (const scc of cycles.sort((a, b) => b.length - a.length).slice(0, 8)) {
    issues.push({
      type: "cycle",
      severity: scc.length >= 4 ? "high" : "medium",
      title: `循環依存 · ${scc.length} ファイルが絡み合っています`,
      detail: `${scc.slice(0, 4).join(" → ")}${scc.length > 4 ? " …" : ""} が環を構成しています。環の中の変更はビルド時・実行時に初期化順序の問題を引き起こしかねません。共通の下位モジュールを切り出して環を断ち切るのがおすすめです。`,
      files: scc.sort(),
    });
  }

  // 巨大ファイル
  const giantThreshold = Math.max(600, maxLoc * 0.7);
  const giants = files.filter((f) => f.loc >= giantThreshold);
  if (giants.length) {
    issues.push({
      type: "giant",
      severity: giants.some((f) => f.loc >= 1500) ? "high" : "medium",
      title: `巨大ファイル ${giants.length} 件`,
      detail: `最大のファイル ${giants[0]?.path ?? ""} は ${maxLoc} 行あります。ファイルが大きいほどレビューが難しくコンフリクトも起きやすい。分割の第一候補です。`,
      files: giants.sort((a, b) => b.loc - a.loc).map((f) => f.path),
    });
  }

  // ハブファイル：大量に依存されている —— 変更の影響範囲が甚大
  const hubThreshold = Math.max(8, Math.ceil(maxFanIn * 0.6));
  const hubs = files.filter((f) => f.usedBy.length >= hubThreshold);
  if (hubs.length) {
    issues.push({
      type: "hub",
      severity: hubs.some((f) => f.usedBy.length >= 20) ? "medium" : "low",
      title: `ハブファイル ${hubs.length} 件`,
      detail: `最も参照されている ${hubs[0]?.path ?? ""} は ${maxFanIn} 箇所から import されています。必ずしも悪ではありませんが、シグネチャの変更は街全体に波及します。変更前に依存元の一覧を確認してください。`,
      files: hubs.sort((a, b) => b.usedBy.length - a.usedBy.length).map((f) => f.path),
    });
  }

  // 高結合：出次数が異常に大きい —— 何でも import するファイルはテストしにくい
  const coupled = files.filter((f) => f.deps.length >= 12);
  if (coupled.length) {
    issues.push({
      type: "coupled",
      severity: "low",
      title: `高結合ファイル ${coupled.length} 件`,
      detail: "12 個以上の内部モジュールを import しているファイルです。何でも詰め込まれる集散所になりがちで、依存が多いほど壊れやすい。責務ごとの分割を検討してください。",
      files: coupled.sort((a, b) => b.deps.length - a.deps.length).map((f) => f.path),
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
