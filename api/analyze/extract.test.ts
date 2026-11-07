// 依赖抽取与解析的回归测试（对应 issue #1 的 #2/#5/#6）
import { describe, expect, it } from "vitest";
import { extractSpecifiers, Resolver } from "./extract";

describe("extractSpecifiers · 注释剥离", () => {
  it("// 行注释里的 import 不产生幻影边", () => {
    const text = [
      "// import a from './old'",
      "import b from './real'; // import c from './also-old'",
      "const url = 'https://example.com/x'; import d from './keep';",
    ].join("\n");
    expect(extractSpecifiers("src/x.ts", text)).toEqual(["./real", "./keep"]);
  });

  it("Python 整行 # 注释里的 import 被剥掉，行内 // 是整除运算符不误伤", () => {
    const text = [
      "# from .old import thing",
      "import os  # from .inline import x",
      "y = total // 2",
      "import sys",
    ].join("\n");
    expect(extractSpecifiers("x.py", text)).toEqual(["os", "sys"]);
  });

  it("块注释与三引号字符串的既有行为保持不变", () => {
    const text = "/* import a from './block' */\n'''from .triple import y'''\nimport z from './z';";
    expect(extractSpecifiers("x.ts", text)).toEqual(["./z"]);
  });

  it("C 文件里注释掉的 #include 不算依赖", () => {
    const text = '// #include "old.h"\n#include "real.h"\n';
    expect(extractSpecifiers("main.c", text)).toEqual(["real.h"]);
  });
});

describe("Resolver.tryFile · 显式扩展名", () => {
  it('#include "foo.h" 在 foo.h 与 foo.c 并存时命中 foo.h', () => {
    const paths = ["foo.h", "foo.c", "main.c"];
    const resolver = new Resolver(paths, new Map());
    expect(resolver.resolve("main.c", "foo.h")).toEqual(["foo.h"]);
  });

  it("a.ts 与 a.tsx 并存时显式 ./a.tsx 命中 a.tsx", () => {
    const paths = ["src/a.ts", "src/a.tsx", "src/main.ts"];
    const resolver = new Resolver(paths, new Map());
    expect(resolver.resolve("src/main.ts", "./a.tsx")).toEqual(["src/a.tsx"]);
  });
});

describe("Resolver.resolve · Go 模块边界", () => {
  const paths = [
    "bar/c.go",
    "pkg/a.go",
    "pkg/sub/b.go",
    "main.go",
  ];
  const allFiles = new Map([["go.mod", "module github.com/x/foo\n"]]);

  it("模块前缀 github.com/x/foobar 不再被 github.com/x/foo 吞掉", () => {
    const resolver = new Resolver(paths, allFiles);
    expect(resolver.resolve("main.go", "github.com/x/foobar")).toEqual([]);
  });

  it("github.com/x/foo/pkg 只连 pkg 目录直下的 go 文件，不含子目录", () => {
    const resolver = new Resolver(paths, allFiles);
    expect(resolver.resolve("main.go", "github.com/x/foo/pkg")).toEqual(["pkg/a.go"]);
  });

  it("模块根本身没有目录，不产生边", () => {
    const resolver = new Resolver(paths, allFiles);
    expect(resolver.resolve("main.go", "github.com/x/foo")).toEqual([]);
  });
});
