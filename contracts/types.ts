// 前后端共享的分析结果结构

export interface RepoFile {
  path: string;
  loc: number;
  deps: string[];
  note?: string;
}

export type IssueType =
  | "isolated" // 孤立文件：既不 import 别人，也没人 import 它
  | "dead" // 疑似死代码：没有任何文件引用它（入口除外）
  | "cycle" // 循环依赖（SCC）
  | "giant" // 巨型文件：行数异常大
  | "hub" // 枢纽/上帝文件：被大量文件依赖
  | "coupled"; // 高耦合：依赖过多的文件

export type Severity = "high" | "medium" | "low";

export interface Issue {
  type: IssueType;
  severity: Severity;
  title: string;
  detail: string;
  files: string[]; // 涉及的文件路径
}

export interface AnalysisMeta {
  repo: string; // owner/name
  branch: string;
  commit: string;
  truncated: boolean; // 文件过多时做了目录聚合
  totalSourceFiles: number; // 聚合前的源码文件数
  fromCache: boolean;
  analyzedAt: string;
}

export interface AnalysisStats {
  files: number;
  loc: number;
  edges: number;
  isolated: number;
  dead: number;
  cycles: number;
}

export interface AnalysisResult {
  meta: AnalysisMeta;
  stats: AnalysisStats;
  files: RepoFile[];
  issues: Issue[];
}

export const ISSUE_LABEL: Record<IssueType, string> = {
  isolated: "孤立コード",
  dead: "デッドコード疑惑",
  cycle: "循環依存",
  giant: "巨大ファイル",
  hub: "ハブファイル",
  coupled: "高結合",
};
