// @effect-diagnostics nodeBuiltinImport:off - Run real shell installers against disposable filesystem/process fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { afterEach, describe, expect, it } from "vite-plus/test";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

// oxlint-disable-next-line t3code/no-global-process-runtime -- The real host determines which shell executable exists for these isolated fixtures.
describe.skipIf(process.platform !== "win32")("Hotlap PowerShell installer", () => {
  it.each(["../escape", "1.2.3\n", "01.2.3", "1.2.3-01"])(
    "rejects invalid version %j without writing a profile",
    (version) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hotlap-install-"));
      roots.push(root);
      const home = NodePath.join(root, "hotlap");
      const result = NodeChildProcess.spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          NodePath.resolve(import.meta.dirname, "install.ps1"),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOTLAP_HOME: home,
            HOTLAP_VERSION: version,
            HOTLAP_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          },
          timeout: 10_000,
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("valid semantic version");
      expect(NodeFS.existsSync(home)).toBe(false);
    },
  );

  it("preserves an existing completed npm runtime and launcher", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hotlap-install-"));
    roots.push(root);
    const home = NodePath.join(root, "hotlap");
    const target = NodePath.join(home, "runtime/versions/1.2.3");
    const bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(NodePath.join(target, "node_modules/hotlap/dist"), { recursive: true });
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(NodePath.join(target, ".install-complete"), "1.2.3");
    NodeFS.writeFileSync(
      NodePath.join(target, "node_modules/hotlap/dist/bin.mjs"),
      "existing npm runtime",
    );
    NodeFS.writeFileSync(NodePath.join(bin, "hotlap.cmd"), "existing launcher");
    const result = NodeChildProcess.spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        NodePath.resolve(import.meta.dirname, "install.ps1"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOTLAP_HOME: home,
          HOTLAP_VERSION: "1.2.3",
          HOTLAP_INSTALL_BIN_DIR: bin,
          T3CODE_HOME: NodePath.join(root, "t3-profile"),
        },
        timeout: 10_000,
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("another or incomplete runtime layout");
    expect(
      NodeFS.readFileSync(NodePath.join(target, "node_modules/hotlap/dist/bin.mjs"), "utf8"),
    ).toBe("existing npm runtime");
    expect(NodeFS.readFileSync(NodePath.join(bin, "hotlap.cmd"), "utf8")).toBe("existing launcher");
    expect(NodeFS.existsSync(NodePath.join(root, "t3-profile"))).toBe(false);
  });
});

function installerFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hotlap-install-"));
  roots.push(root);
  const home = NodePath.join(root, "hotlap");
  const bin = NodePath.join(root, "bin");
  const tools = NodePath.join(root, "tools");
  const assets = NodePath.join(root, "assets");
  const stem = "hotlap-1.2.3-linux-x64";
  for (const dir of [home, bin, tools, assets, NodePath.join(root, stem)]) NodeFS.mkdirSync(dir);
  NodeFS.writeFileSync(NodePath.join(root, stem, "t3"), '#!/bin/sh\nprintf "Hotlap 1.2.3\\n"\n', {
    mode: 0o755,
  });
  const archive = NodePath.join(assets, `${stem}.tar.gz`);
  const packed = NodeChildProcess.spawnSync("tar", ["-czf", archive, "-C", root, stem], {
    encoding: "utf8",
  });
  expect(packed.status, packed.stderr).toBe(0);
  NodeFS.writeFileSync(
    NodePath.join(assets, "SHA256SUMS"),
    `${NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(archive)).digest("hex")}  ${stem}.tar.gz\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(tools, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n',
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(
    NodePath.join(tools, "curl"),
    `#!/bin/sh
set -eu
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -w) shift 2;;
    -o) output="$2"; shift 2;;
    -*) shift;;
    *) url="$1"; shift;;
  esac
done
printf '%s\\n' "$url" >> "$HOTLAP_TEST_ROOT/requests"
asset="$HOTLAP_TEST_ROOT/assets/\${url##*/}"
if [ -f "$asset" ]; then cp "$asset" "$output"; printf 200; else printf 404; fi
`,
    { mode: 0o755 },
  );
  return {
    root,
    home,
    bin,
    assets,
    tools,
    run: (version = "1.2.3") =>
      NodeChildProcess.spawnSync("sh", [NodePath.resolve(import.meta.dirname, "install.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tools}:${process.env.PATH}`,
          HOTLAP_HOME: home,
          HOTLAP_INSTALL_BIN_DIR: bin,
          HOTLAP_VERSION: version,
          HOTLAP_TEST_ROOT: root,
          // A T3 installation must never be selected by Hotlap's standalone installer.
          T3CODE_HOME: NodePath.join(root, "t3-profile"),
          T3CODE_VERSION: "1.2.3",
          T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "t3-bin"),
        },
        timeout: 10_000,
      }),
  };
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- The real host determines which shell executable exists for these isolated fixtures.
describe.skipIf(process.platform === "win32")("Hotlap standalone installer", () => {
  it("directs Intel Macs to npm without attempting an unsupported archive", () => {
    const fixture = installerFixture();
    NodeFS.writeFileSync(
      NodePath.join(fixture.tools, "uname"),
      '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo x86_64;; esac\n',
      { mode: 0o755 },
    );
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm install -g hotlap@1.2.3");
    expect(NodeFS.existsSync(NodePath.join(fixture.home, "runtime"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(fixture.root, "requests"))).toBe(false);
  });

  it("refuses to replace an existing completed npm runtime", () => {
    const fixture = installerFixture();
    const target = NodePath.join(fixture.home, "runtime/versions/1.2.3");
    NodeFS.mkdirSync(NodePath.join(target, "node_modules/hotlap/dist"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(target, ".install-complete"), "1.2.3\n");
    NodeFS.writeFileSync(
      NodePath.join(target, "node_modules/hotlap/dist/bin.mjs"),
      "existing npm runtime",
    );
    NodeFS.writeFileSync(NodePath.join(fixture.bin, "hotlap"), "existing command");
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("another or incomplete runtime layout");
    expect(
      NodeFS.readFileSync(NodePath.join(target, "node_modules/hotlap/dist/bin.mjs"), "utf8"),
    ).toBe("existing npm runtime");
    expect(NodeFS.readFileSync(NodePath.join(fixture.bin, "hotlap"), "utf8")).toBe(
      "existing command",
    );
    expect(NodeFS.existsSync(NodePath.join(fixture.root, "requests"))).toBe(false);
  });

  it("leaves the existing launcher and runtime intact after a checksum failure", () => {
    const fixture = installerFixture();
    const previous = NodePath.join(fixture.home, "runtime/versions/1.2.2");
    NodeFS.mkdirSync(previous, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(previous, "t3"), "existing runtime");
    NodeFS.writeFileSync(NodePath.join(fixture.bin, "hotlap"), "existing command");
    NodeFS.writeFileSync(
      NodePath.join(fixture.assets, "SHA256SUMS"),
      `${"0".repeat(64)}  hotlap-1.2.3-linux-x64.tar.gz\n`,
    );
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
    expect(NodeFS.readFileSync(NodePath.join(fixture.bin, "hotlap"), "utf8")).toBe(
      "existing command",
    );
    expect(NodeFS.readFileSync(NodePath.join(previous, "t3"), "utf8")).toBe("existing runtime");
    expect(NodeFS.existsSync(NodePath.join(fixture.home, "runtime/versions/1.2.3"))).toBe(false);
  });

  it.each([
    "../escape",
    "1.2.3/../../escape",
    "01.2.3",
    "1.2.3-01",
    "1.2.3\n../../escape",
    "1.2.3\n",
  ])("rejects invalid version %j before creating runtime paths", (version) => {
    const fixture = installerFixture();
    const result = fixture.run(version);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("valid semantic version");
    expect(NodeFS.existsSync(NodePath.join(fixture.home, "runtime"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(fixture.root, "requests"))).toBe(false);
  });

  it("downloads Hotlap assets and installs a Hotlap command without touching T3", () => {
    const fixture = installerFixture();
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    const command = NodeChildProcess.spawnSync(
      NodePath.join(fixture.bin, "hotlap"),
      ["--version"],
      { encoding: "utf8" },
    );
    expect(command.status, command.stderr).toBe(0);
    expect(command.stdout).toContain("Hotlap 1.2.3");
    expect(NodeFS.readFileSync(NodePath.join(fixture.root, "requests"), "utf8")).toBe(
      "https://github.com/shwarmadev/hotlap/releases/download/v1.2.3/SHA256SUMS\n" +
        "https://github.com/shwarmadev/hotlap/releases/download/v1.2.3/hotlap-1.2.3-linux-x64.tar.gz\n",
    );
    expect(NodeFS.existsSync(NodePath.join(fixture.root, "t3-profile"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(fixture.root, "t3-bin"))).toBe(false);
    const repeated = fixture.run();
    expect(repeated.status, repeated.stderr).toBe(0);
    // Progress lines go to stderr so `curl ... | sh` output stays clean.
    expect(repeated.stderr).toContain("already downloaded");
    expect(
      NodeFS.readFileSync(NodePath.join(fixture.root, "requests"), "utf8").trim().split("\n"),
    ).toHaveLength(2);
  });
});
