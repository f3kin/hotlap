// @effect-diagnostics nodeBuiltinImport:off
// Sandbox-only coverage measurement: pinned read-only inputs, one private receipt, no writes elsewhere.
// Usage: measure-recovery-coverage.ts <store-id> <legacy.sqlite> <staging.sqlite> <pins.json> <receipt.json>
// Exit: 0 complete; 1 measured but incomplete; 2 pin or input failure.
import * as NodeFS from "node:fs";
import { runCoverageFromFiles } from "../src/persistence/legacyRecoveryCoverage.ts";

const [sourceStoreId, legacyPath, stagingPath, pinsPath, receiptPath] = process.argv.slice(2);
if (!sourceStoreId || !legacyPath || !stagingPath || !pinsPath || !receiptPath) {
  console.error("usage: <store-id> <legacy.sqlite> <staging.sqlite> <pins.json> <receipt.json>");
  process.exit(2);
}
const startedAt = new Date().toISOString();
const result = runCoverageFromFiles({
  legacyPath,
  stagingPath,
  pins: JSON.parse(NodeFS.readFileSync(pinsPath, "utf8")) as Record<string, string>,
  sourceStoreId,
});
// Exclusive create: an existing receipt is never overwritten.
NodeFS.writeFileSync(
  receiptPath,
  `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), ...result }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
// Stdout carries counts and reasons only, never source ids.
console.log(
  JSON.stringify({
    status: result.status,
    ...("summary" in result ? { summary: result.summary } : {}),
  }),
);
process.exit(result.status === "complete" ? 0 : result.status === "incomplete" ? 1 : 2);
