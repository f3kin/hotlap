// @effect-diagnostics nodeBuiltinImport:off - Verify the actual Node loader in an isolated unpatched npm fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

it("loads npm's import-only fff export through the real Node module loader", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hotlap-fff-import-"));
  try {
    const dependency = NodePath.join(root, "node_modules/@ff-labs/fff-node");
    await NodeFSP.mkdir(dependency, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
    await NodeFSP.writeFile(
      NodePath.join(dependency, "package.json"),
      JSON.stringify({
        type: "module",
        exports: { ".": { import: "./index.js" } },
      }),
    );
    await NodeFSP.writeFile(
      NodePath.join(dependency, "index.js"),
      "export class FileFinder { static loaded = true; }",
    );
    await NodeFSP.copyFile(
      new URL("./fffNode.ts", import.meta.url),
      NodePath.join(root, "fffNode.ts"),
    );
    const result = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { FileFinder } from "./fffNode.ts"; console.log(FileFinder.loaded);',
      ],
      {
        cwd: root,
        timeout: 10_000,
      },
    );
    expect(result.stdout.trim()).toBe("true");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
