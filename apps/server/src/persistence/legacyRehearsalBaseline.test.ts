import { expect, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import { captureLegacyBaseline } from "./legacyRehearsalBaseline.ts";
import { compareHistory } from "./legacyRehearsalCheck.ts";

it("retains the original baseline when a copied legacy message is changed during migration", () => {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE projection_threads(thread_id,project_id,title,branch,worktree_path,created_at,updated_at);
      CREATE TABLE projection_thread_messages(thread_id,message_id,role,text,created_at,updated_at,attachments_json,context_json,is_streaming);
      INSERT INTO projection_threads VALUES('thread','project','Title',NULL,NULL,'2026-01-01','2026-01-01');
      INSERT INTO projection_thread_messages VALUES('thread','message','user','original','2026-01-01','2026-01-01',NULL,NULL,0);`);
    const baseline = captureLegacyBaseline(database);
    database.exec("UPDATE projection_thread_messages SET text='migration changed it'");
    const changed = captureLegacyBaseline(database);
    const normalise = (rows: typeof baseline.messages) =>
      rows.map((row) => ({
        id: row.message_id,
        role: row.role,
        text: row.text,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        attachments: row.attachments_json,
        context: row.context_json,
      }));
    expect(baseline.messages[0]?.text).toBe("original");
    expect(compareHistory(normalise(baseline.messages), normalise(changed.messages)).equal).toBe(
      false,
    );
  } finally {
    database.close();
  }
});
