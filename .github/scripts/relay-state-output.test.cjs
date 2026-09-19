const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

// Hotlap ships without a relay, so release.yml writes an empty tracing config
// instead of reading upstream's Alchemy state. Keep the step producing the
// same env-file shape the build jobs consume.
const workflow = readFileSync(join(__dirname, "../workflows/release.yml"), "utf8");
const step = workflow.match(
  /        name: Write empty relay tracing config\n[\s\S]*?        run: \|\n((?:          .*\n|\n)+)/,
);
assert.ok(step, "Could not find the empty relay tracing config step");
const script = step[1].replace(/^          /gm, "");

test("writes every relay tracing key as empty", () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "hotlap-relay-state-test-"));
  try {
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, RUNNER_TEMP: runnerTemp },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(runnerTemp, "relay-client-tracing.env"), "utf8"),
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL=\n" +
        "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET=\n" +
        "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN=\n",
    );
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});
