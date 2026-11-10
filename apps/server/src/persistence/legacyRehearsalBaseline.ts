import type * as NodeSqlite from "node:sqlite";

export interface LegacyBaselineMessage {
  thread_id: string;
  message_id: string;
  role: string;
  text: string;
  created_at: string;
  updated_at: string;
  attachments_json: string | null;
  context_json: string | null;
  is_streaming: number;
}

export interface LegacyBaselineThread {
  thread_id: string;
  project_id: string;
  title: string;
  branch: string | null;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
}

/** Capture from the original read-only input before any destination is migrated. */
export function captureLegacyBaseline(input: NodeSqlite.DatabaseSync) {
  return {
    threads: input
      .prepare(
        "SELECT thread_id,project_id,title,branch,worktree_path,created_at,updated_at FROM projection_threads ORDER BY thread_id",
      )
      .all() as unknown as LegacyBaselineThread[],
    messages: input
      .prepare(
        "SELECT thread_id,message_id,role,text,created_at,updated_at,attachments_json,context_json,is_streaming FROM projection_thread_messages ORDER BY thread_id,created_at,message_id",
      )
      .all() as unknown as LegacyBaselineMessage[],
  };
}
