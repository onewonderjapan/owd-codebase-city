// 依赖解析层：按语言抽 import，解析成仓库内部路径。
// 只保留仓库内部的边 —— 把 react 画成一栋楼，整张图就只剩一个中心点。

const JS_EXT = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];
const PY_EXT = ["py", "pyi"];
const GO_EXT = ["go"];
const JAVA_EXT = ["java"];
const RUST_EXT = ["rs"];
const C_EXT = ["c", "h", "cc", "cpp", "cxx", "hpp", "hh"];
const RB_EXT = ["rb"];
const EXTRA_SRC = ["vue", "svelte", "scala", "kt", "kts", "swift", "cs", "php", "ex", "exs", "lua", "sh", "sql", "md"];

export const SRC_EXT = new Set([
  ...JS_EXT, ...PY_EXT, ...GO_EXT, ...JAVA_EXT, ...RUST_EXT, ...C_EXT, ...RB_EXT, ...EXTRA_SRC,
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor", ".next", ".nuxt",
  "coverage", "__pycache__", ".venv", "venv", "env", ".tox", "bin", "obj", ".idea",
  ".vscode", ".cache", ".gradle", ".mvn", "third_party", "external", "deps", "fixtures",
]);

const IGNORE_FILES = /(\.min\.(js|css)|\.lock$|package-lock\.json$|yarn\.lock$|pnpm-lock|\.snap$|\.map$|\.generated\.|\.pb\.go$|\.g\.ts$)/;

export function isSourceFile(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((p) => IGNORE_DIRS.has(p))) return false;
  const name = parts[parts.length - 1];
  if (IGNORE_FILES.test(name)) return false;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return SRC_EXT.has(ext);
}

function extOf(path: string): string {
  const n = path.split("/").pop()!;
  return n.includes(".") ? n.split(".").pop()!.toLowerCase() : "";
}

/** 去掉注释与字符串，避免把注释里的 import 当真的 */
function stripNoise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/'''[\s\S]*?'''/g, " ")
    .replace(/"""[\s\S]*?"""/g, " ");
}

/** 抽出原始 import 说明符 */
export function extractSpecifiers(path: string, text: string): string[] {
  const ext = extOf(path);
  const src = stripNoise(text);
  const out: string[] = [];
  const push = (s?: string) => { if (s) out.push(s); };

  if (JS_EXT.includes(ext) || ext === "vue" || ext === "svelte") {
    const body = ext === "vue" || ext === "svelte"
      ? (src.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || []).join("\n")
      : src;
    const res = [
      /import\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g,
      /export\s+[^'"()]*?\s+from\s+['"]([^'"]+)['"]/g,
      /require\(\s*['"]([^'"]+)['"]\s*\)/g,
      /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const re of res) for (const m of body.matchAll(re)) push(m[1]);
  } else if (PY_EXT.includes(ext)) {
    for (const line of src.split("\n")) {
      let m = line.match(/^\s*from\s+([.\w]+)\s+import\b/);
      if (m) { push(m[1]); continue; }
      m = line.match(/^\s*import\s+([.\w]+(?:\s*,\s*[.\w]+)*)/);
      if (m) for (const part of m[1].split(",")) push(part.trim());
    }
  } else if (GO_EXT.includes(ext)) {
    for (const m of src.matchAll(/import\s*\(([\s\S]*?)\)/g))
      for (const q of m[1].matchAll(/"([^"]+)"/g)) push(q[1]);
    for (const m of src.matchAll(/import\s+(?:\w+\s+)?"([^"]+)"/g)) push(m[1]);
  } else if (JAVA_EXT.includes(ext)) {
    for (const m of src.matchAll(/import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/g)) push(m[1]);
  } else if (RUST_EXT.includes(ext)) {
    for (const m of src.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) push("mod:" + m[1]);
    for (const m of src.matchAll(/^\s*use\s+(crate::[\w:]+)/gm)) push(m[1]);
  } else if (C_EXT.includes(ext)) {
    for (const m of src.matchAll(/#\s*include\s+"([^"]+)"/g)) push(m[1]);
  } else if (ext === "rb") {
    for (const m of src.matchAll(/require_relative\s+['"]([^'"]+)['"]/g)) push(m[1]);
  }
  return out;
}

/** 路径解析器：把说明符映射到仓库内部文件 */
export class Resolver {
  private byExtless = new Map<string, string>(); // 无扩展名路径 → 完整路径
  private goModule = "";
  private hasGoMod = false;

  constructor(private paths: string[], allFiles: Map<string, string>) {
    for (const p of paths) {
      const ext = extOf(p);
      if (ext) this.byExtless.set(p.slice(0, -(ext.length + 1)), p);
    }
    const goMod = allFiles.get("go.mod");
    if (goMod) {
      this.hasGoMod = true;
      const m = goMod.match(/^module\s+(\S+)/m);
      if (m) this.goModule = m[1];
    }
  }

  private norm(p: string): string {
    const out: string[] = [];
    for (const seg of p.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return out.join("/");
  }

  private tryFile(base: string): string | null {
    if (!base) return null;
    // TS 的 ESM 导入常写成 ./x.js 而实际文件是 x.ts —— 显式扩展名先剥掉
    const m = base.match(/\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|py|pyi|go|java|rs|rb|vue|svelte|h|c|hpp|hh|cpp|cc|cxx)$/i);
    if (m) base = base.slice(0, -m[0].length);
    const direct = this.byExtless.get(base);
    if (direct) return direct;
    // index / __init__ / mod.rs
    for (const idx of ["index", "__init__", "mod"]) {
      const hit = this.byExtless.get(`${base}/${idx}`);
      if (hit) return hit;
    }
    return null;
  }

  /** 非相对说明符：按后缀匹配（tsconfig paths / 包导入都能覆盖一部分） */
  private trySuffix(spec: string): string | null {
    const direct = this.tryFile(spec);
    if (direct) return direct;
    const withSrc = this.tryFile(`src/${spec}`);
    if (withSrc) return withSrc;
    const needle = `/${spec}`;
    for (const [extless, full] of this.byExtless) {
      if (extless.endsWith(needle)) return full;
    }
    return null;
  }

  resolve(importer: string, spec: string): string[] {
    const dir = importer.split("/").slice(0, -1).join("/");
    const ext = extOf(importer);

    if (JS_EXT.includes(ext) || ext === "vue" || ext === "svelte") {
      if (spec.startsWith(".")) {
        const hit = this.tryFile(this.norm(`${dir}/${spec}`));
        return hit ? [hit] : [];
      }
      if (spec.startsWith("@/") || spec.startsWith("~/")) {
        const hit = this.tryFile(this.norm(`src/${spec.slice(2)}`)) || this.tryFile(this.norm(spec.slice(2)));
        return hit ? [hit] : [];
      }
      // 裸说明符：先排除明显的外部包（@scope/x、react、无斜杠短名）
      if (spec.startsWith("@") || !spec.includes("/")) return [];
      const hit = this.trySuffix(spec);
      return hit ? [hit] : [];
    }

    if (PY_EXT.includes(ext)) {
      const dots = spec.match(/^\.+/)?.[0].length ?? 0;
      const mod = spec.slice(dots).replace(/\./g, "/");
      if (!mod) return [];
      if (dots > 0) {
        let base = dir;
        for (let i = 1; i < dots; i++) base = base.split("/").slice(0, -1).join("/");
        const hit = this.tryFile(this.norm(base ? `${base}/${mod}` : mod));
        return hit ? [hit] : [];
      }
      const hit = this.tryFile(mod) || this.trySuffix(mod) ||
        this.tryFile(this.norm(`${dir}/${mod}`));
      return hit ? [hit] : [];
    }

    if (GO_EXT.includes(ext)) {
      if (!this.hasGoMod || !this.goModule || !spec.startsWith(this.goModule)) return [];
      const rel = spec.slice(this.goModule.length).replace(/^\//, "");
      if (!rel) return [];
      // 包级依赖：连到目标目录下所有 go 文件（封顶，避免一只包连出几百条边）
      const prefix = rel.endsWith("/") ? rel : rel + "/";
      const hits = this.paths.filter((p) => p.startsWith(prefix) && p.endsWith(".go"));
      return hits.slice(0, 12);
    }

    if (JAVA_EXT.includes(ext)) {
      const p = spec.replace(/\./g, "/");
      const hit = this.byExtless.get(p) || this.trySuffix(p);
      return hit ? [hit] : [];
    }

    if (RUST_EXT.includes(ext)) {
      if (spec.startsWith("mod:")) {
        const name = spec.slice(4);
        const hit =
          this.tryFile(this.norm(`${dir}/${name}`)) ||
          this.tryFile(this.norm(`${dir}/${name}/mod`));
        return hit ? [hit] : [];
      }
      const rel = spec.replace(/^crate::/, "").replace(/::/g, "/");
      const hit = this.tryFile(this.norm(`src/${rel}`));
      return hit ? [hit] : [];
    }

    if (C_EXT.includes(ext)) {
      const hit = this.tryFile(this.norm(`${dir}/${spec}`)) || this.trySuffix(spec.replace(/\.[^.]+$/, ""));
      return hit ? [hit] : [];
    }

    if (ext === "rb") {
      const hit = this.tryFile(this.norm(`${dir}/${spec}`));
      return hit ? [hit] : [];
    }

    return [];
  }
}
