import {
  mysqlTable,
  serial,
  varchar,
  longtext,
  int,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

// 仓库分析结果缓存：以 repo + branch 为键，commit 变化时重新分析。
// payload 是完整的 AnalysisResult JSON（可能几 MB），用 longtext 存。
export const analyses = mysqlTable(
  "analyses",
  {
    id: serial("id").primaryKey(),
    repo: varchar("repo", { length: 255 }).notNull(), // owner/name
    branch: varchar("branch", { length: 255 }).notNull(),
    commit: varchar("commit", { length: 64 }).notNull(),
    fileCount: int("file_count").notNull(),
    totalLoc: int("total_loc").notNull(),
    issueCount: int("issue_count").notNull(),
    payload: longtext("payload").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [uniqueIndex("repo_branch").on(t.repo, t.branch)],
);
