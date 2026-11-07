// 问题检测的回归测试（对应 issue #1 的 #3：giant/hub 在排序前读取 [0]）
import { describe, expect, it } from "vitest";
import { detectIssues, type GraphNode } from "./issues";

function node(path: string, loc: number, deps: string[], usedBy: string[]): GraphNode {
  return { path, loc, deps, usedBy };
}

describe("detectIssues · 巨大ファイル/ハブの代表ファイル", () => {
  it("detail 里的「最大のファイル」取的是 loc 最大的文件，不是数组第一个", () => {
    // a.ts 排在前面但只有 1500 行；b.ts 2000 行才是最大
    const files: GraphNode[] = [
      node("src/a.ts", 1500, [], []),
      node("src/b.ts", 2000, [], []),
      node("src/tiny.ts", 10, [], []),
    ];
    const issues = detectIssues(files, 2000, 0);
    const giant = issues.find((i) => i.type === "giant");
    expect(giant).toBeDefined();
    expect(giant!.detail).toContain("src/b.ts");
    expect(giant!.detail).not.toContain("src/a.ts");
    expect(giant!.files[0]).toBe("src/b.ts");
  });

  it("hub 的「最も参照されている」取 usedBy 最多的文件", () => {
    const files: GraphNode[] = [
      node("src/first.ts", 10, [], Array.from({ length: 9 }, (_, i) => `u${i}`)),
      node("src/most.ts", 10, [], Array.from({ length: 15 }, (_, i) => `v${i}`)),
      node("src/caller.ts", 10, ["src/first.ts", "src/most.ts"], []),
    ];
    const issues = detectIssues(files, 10, 15);
    const hub = issues.find((i) => i.type === "hub");
    expect(hub).toBeDefined();
    expect(hub!.detail).toContain("src/most.ts");
    expect(hub!.files[0]).toBe("src/most.ts");
  });
});
