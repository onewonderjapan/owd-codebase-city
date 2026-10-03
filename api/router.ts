import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { analyses } from "../db/schema";
import { analyzeRepo } from "./analyze";
import { parseRepoUrl, fetchRepoInfo } from "./analyze/github";
import type { AnalysisResult } from "../contracts/types";

const analyzeInput = z.object({
  url: z.string().min(3).max(300),
  token: z.string().max(100).optional(),
  force: z.boolean().optional(),
});

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),

  repo: createRouter({
    /** 分析一个 GitHub 仓库；commit 未变时直接命中缓存 */
    analyze: publicQuery.input(analyzeInput).mutation(async ({ input }) => {
      const ref = parseRepoUrl(input.url);
      const repoKey = `${ref.owner}/${ref.repo}`;
      const info = await fetchRepoInfo(ref, input.token);
      const db = getDb();

      if (!input.force) {
        const rows = await db
          .select()
          .from(analyses)
          .where(eq(analyses.repo, repoKey))
          .limit(5);
        const hit = rows.find((r) => r.branch === info.branch && r.commit === info.commit);
        if (hit) {
          const cached = JSON.parse(hit.payload) as AnalysisResult;
          cached.meta.fromCache = true;
          return cached;
        }
      }

      let result: AnalysisResult;
      try {
        result = await analyzeRepo(input.url, input.token);
      } catch (e) {
        if (e instanceof TRPCError) throw e;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "解析に失敗しました",
        });
      }

      // 缓存：同一 repo+branch 覆盖写
      const existing = await db
        .select({ id: analyses.id })
        .from(analyses)
        .where(eq(analyses.repo, repoKey))
        .limit(5);
      const sameBranch = existing; // repo+branch 有唯一索引，直接 upsert
      void sameBranch;
      await db
        .insert(analyses)
        .values({
          repo: repoKey,
          branch: info.branch,
          commit: info.commit,
          fileCount: result.stats.files,
          totalLoc: result.stats.loc,
          issueCount: result.issues.length,
          payload: JSON.stringify(result),
        })
        .onDuplicateKeyUpdate({
          set: {
            commit: info.commit,
            fileCount: result.stats.files,
            totalLoc: result.stats.loc,
            issueCount: result.issues.length,
            payload: JSON.stringify(result),
          },
        });
      return result;
    }),

    /** 最近分析过的仓库（给首页做历史入口） */
    recent: publicQuery.query(async () => {
      const db = getDb();
      const rows = await db
        .select({
          repo: analyses.repo,
          branch: analyses.branch,
          fileCount: analyses.fileCount,
          totalLoc: analyses.totalLoc,
          issueCount: analyses.issueCount,
          updatedAt: analyses.updatedAt,
        })
        .from(analyses)
        .orderBy(analyses.updatedAt)
        .limit(12);
      return rows.reverse();
    }),
  }),
});

export type AppRouter = typeof appRouter;
