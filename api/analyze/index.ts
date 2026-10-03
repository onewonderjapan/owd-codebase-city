// 编排层：拉取 → 过滤 → 解析 → 构图 → 聚合 → 检测，产出 AnalysisResult。
import { TRPCError } from "@trpc/server";
import type { AnalysisResult, RepoFile } from "../../contracts/types";
import { fetchRepoFiles, fetchRepoInfo, parseRepoUrl, type RepoRef } from "./github";
import { extractSpecifiers, isSourceFile, Resolver } from "./extract";
import { detectIssues, isTest, type GraphNode } from "./issues";

const MAX_BUILDINGS = 900; // 超过就做目录聚合，否则楼小到点不中
const MAX_PARSE = 4000; // 参与依赖解析的文件数上限

const NOTE_RULES: [RegExp, string][] = [
  [/(^|\/)(main|index)\.[tj]sx?$/, "モジュール出口 / エントリ"],
  [/(^|\/)types?\.[tj]s$/, "型定義"],
  [/(^|\/)constants?\.[tj]s$/, "定数定義"],
  [/(^|\/)utils?\.[tj]s$/, "ユーティリティ関数"],
  [/(^|\/)config\.[tj]s$/, "設定"],
];

function guessNote(path: string, isT: boolean): string | undefined {
  if (isT) return "テストファイル";
  for (const [re, note] of NOTE_RULES) if (re.test(path)) return note;
  return undefined;
}

/** 依赖图：files 顺序稳定，edges 只含仓库内部 */
function buildGraph(entries: { path: string; text: string; loc: number }[]): GraphNode[] {
  const paths = entries.map((e) => e.path);
  const allTexts = new Map<string, string>();
  const resolver = new Resolver(paths, allTextsFor(entries));
  const byPath = new Map<string, GraphNode>();
  const nodes: GraphNode[] = entries.map((e) => {
    const n: GraphNode = {
      path: e.path,
      loc: e.loc,
      deps: [],
      usedBy: [],
      note: guessNote(e.path, isTest(e.path)),
    };
    byPath.set(e.path, n);
    return n;
  });

  for (let i = 0; i < entries.length; i++) {
    const specs = extractSpecifiers(entries[i].path, entries[i].text);
    const deps = new Set<string>();
    for (const s of specs) {
      for (const hit of resolver.resolve(entries[i].path, s)) {
        if (hit !== entries[i].path && byPath.has(hit)) deps.add(hit);
      }
    }
    nodes[i].deps = [...deps].sort();
  }
  for (const n of nodes) for (const d of n.deps) byPath.get(d)!.usedBy.push(n.path);
  for (const n of nodes) n.usedBy.sort();
  return nodes;

  function allTextsFor(es: { path: string; text: string }[]): Map<string, string> {
    for (const e of es) if (e.path === "go.mod") allTexts.set(e.path, e.text);
    return allTexts;
  }
}

/** 目录聚合：文件太多时，每个目录合成一栋「街区楼」 */
function aggregate(nodes: GraphNode[]): GraphNode[] {
  const groups = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const parts = n.path.split("/");
    const key = parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }
  const dirOf = (p: string) => {
    const parts = p.split("/");
    return parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0];
  };
  const out: GraphNode[] = [];
  const aggByDir = new Map<string, GraphNode>();
  for (const [dir, list] of groups) {
    const agg: GraphNode = {
      path: `${dir}/`,
      loc: list.reduce((a, n) => a + n.loc, 0),
      deps: [],
      usedBy: [],
      note: `${list.length} 個のファイルを集約したディレクトリ`,
    };
    out.push(agg);
    aggByDir.set(dir, agg);
  }
  for (const n of nodes) {
    const from = aggByDir.get(dirOf(n.path))!;
    for (const d of n.deps) {
      const to = aggByDir.get(dirOf(d))!;
      if (to !== from && !from.deps.includes(to.path)) from.deps.push(to.path);
    }
  }
  for (const a of out) for (const d of a.deps) aggByDir.get(d.slice(0, -1))?.usedBy.push(a.path);
  return out;
}

export async function analyzeRepo(input: string, token?: string): Promise<AnalysisResult> {
  const ref: RepoRef = parseRepoUrl(input);
  const info = await fetchRepoInfo(ref, token);
  const zipFiles = await fetchRepoFiles(ref, info, token);

  const src = zipFiles.filter((f) => isSourceFile(f.path));
  if (!src.length)
    throw new TRPCError({ code: "BAD_REQUEST", message: "リポジトリにソースファイルが見つかりませんでした（JS/TS・Python・Go・Java・Rust・C/C++・Ruby などに対応）" });
  if (src.length > MAX_PARSE)
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `ソースファイルが ${MAX_PARSE} 件を超えています。現状この規模は解析できません。サブディレクトリや単一パッケージを試してください`,
    });

  const entries = src.map((f) => ({
    path: f.path,
    text: f.text,
    loc: f.text.split("\n").length,
  }));
  // go.mod 需要参与 module 名解析，但它不是源码 —— 单独塞给 Resolver
  const goMod = zipFiles.find((f) => f.path === "go.mod");
  if (goMod && !entries.some((e) => e.path === "go.mod"))
    entries.push({ path: "go.mod", text: goMod.text, loc: goMod.text.split("\n").length });

  let graph = buildGraph(entries).filter((n) => n.path !== "go.mod");

  let truncated = false;
  if (graph.length > MAX_BUILDINGS) {
    truncated = true;
    graph = aggregate(graph);
  }

  const maxLoc = Math.max(1, ...graph.map((f) => f.loc));
  const maxFanIn = Math.max(1, ...graph.map((f) => f.usedBy.length));
  const issues = detectIssues(graph, maxLoc, maxFanIn);
  const edges = graph.reduce((a, f) => a + f.deps.length, 0);

  const files: RepoFile[] = graph.map((f) => ({
    path: f.path,
    loc: f.loc,
    deps: f.deps,
    ...(f.note ? { note: f.note } : {}),
  }));

  return {
    meta: {
      repo: `${ref.owner}/${ref.repo}`,
      branch: info.branch,
      commit: info.commit,
      truncated,
      totalSourceFiles: src.length,
      fromCache: false,
      analyzedAt: new Date().toISOString(),
    },
    stats: {
      files: files.length,
      loc: files.reduce((a, f) => a + f.loc, 0),
      edges,
      isolated: issues.find((i) => i.type === "isolated")?.files.length ?? 0,
      dead: issues.find((i) => i.type === "dead")?.files.length ?? 0,
      cycles: issues.filter((i) => i.type === "cycle").length,
    },
    files,
    issues,
  };
}
