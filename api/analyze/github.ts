// GitHub 拉取层：解析仓库地址、取默认分支与最新 commit、下载 zipball。
import AdmZip from "adm-zip";
import { TRPCError } from "@trpc/server";

export interface RepoRef {
  owner: string;
  repo: string;
  branch?: string;
}

/** 接受 owner/repo、github.com/owner/repo、…/tree/branch、.git 后缀等写法 */
export function parseRepoUrl(input: string): RepoRef {
  let s = input.trim();
  if (!s) throw new TRPCError({ code: "BAD_REQUEST", message: "リポジトリの URL を入力してください" });
  s = s.replace(/^git@github\.com:/, "https://github.com/");
  s = s.replace(/\.git\/?$/, "");
  let m = s.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+)(?:\/tree\/([^/\s?#]+))?/);
  if (m) return { owner: m[1], repo: m[2], branch: m[3] || undefined };
  m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (m) return { owner: m[1], repo: m[2] };
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "リポジトリの URL を認識できません。owner/repo または github.com の完全なリンクを試してください",
  });
}

function ghHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "codebase-city",
    Accept: "application/vnd.github+json",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export interface RepoInfo {
  branch: string;
  commit: string;
  sizeKb: number;
}

/** 取默认分支（或指定分支）的最新 commit，用于缓存键 */
export async function fetchRepoInfo(ref: RepoRef, token?: string): Promise<RepoInfo> {
  const res = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, {
    headers: ghHeaders(token),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404)
    throw new TRPCError({ code: "NOT_FOUND", message: "リポジトリが存在しないか、プライベートリポジトリです（GitHub トークンを入力して再試行できます）" });
  if (res.status === 403)
    throw new TRPCError({ code: "FORBIDDEN", message: "GitHub のレート制限に達しました。トークンを入力するか、しばらく待って再試行してください" });
  if (!res.ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `GitHub が ${res.status} を返しました` });
  const meta = (await res.json()) as { default_branch: string; size: number };
  const branch = ref.branch || meta.default_branch;

  const br = await fetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(branch)}?per_page=1`,
    { headers: ghHeaders(token), signal: AbortSignal.timeout(15000) },
  );
  if (!br.ok)
    throw new TRPCError({ code: "NOT_FOUND", message: `ブランチ ${branch} が存在しません` });
  const c = (await br.json()) as { sha: string };
  return { branch, commit: c.sha, sizeKb: meta.size ?? 0 };
}

export interface ZipEntry {
  path: string; // 已去掉顶层 owner-repo-sha/ 前缀
  text: string;
}

const MAX_ZIP = 120 * 1024 * 1024; // 120MB，再大说明多半是带产物的仓库
const MAX_FILE = 512 * 1024;

/** 下载并解压 zipball，返回文本文件列表（二进制按 null 过滤） */
export async function fetchRepoFiles(ref: RepoRef, info: RepoInfo, token?: string): Promise<ZipEntry[]> {
  const url = `https://codeload.github.com/${ref.owner}/${ref.repo}/zip/${info.commit}`;
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}`, "User-Agent": "codebase-city" } : { "User-Agent": "codebase-city" },
    signal: AbortSignal.timeout(90000),
    redirect: "follow",
  });
  if (!res.ok)
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `リポジトリのダウンロードに失敗しました（${res.status}）` });
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_ZIP)
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "リポジトリのアーカイブが 120MB を超えています。現状これほど大きなリポジトリは解析できません" });

  let entries: AdmZip.IZipEntry[];
  try {
    entries = new AdmZip(Buffer.from(buf)).getEntries();
  } catch {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "アーカイブの解凍に失敗しました" });
  }

  const out: ZipEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const raw = entry.entryName;
    const data = entry.getData();
    if (!data.length) continue;
    const slash = raw.indexOf("/");
    if (slash < 0) continue;
    const path = raw.slice(slash + 1);
    if (!path || path.endsWith("/")) continue;
    if (data.length > MAX_FILE) continue;
    // 二进制粗判：前 8KB 里有 NUL 就跳过
    let bin = false;
    const probe = data.subarray(0, Math.min(8192, data.length));
    for (let i = 0; i < probe.length; i++) if (probe[i] === 0) { bin = true; break; }
    if (bin) continue;
    out.push({ path, text: new TextDecoder("utf-8", { fatal: false }).decode(data) });
  }
  return out;
}
