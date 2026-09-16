const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertCommitOnDefaultBranch,
  assertReleaseVersionIsCurrent,
  assertReleaseSource,
  resolveNextNightlyVersion,
  shouldReleaseNightly,
} = require("./check-nightly-release.cjs");

const now = Date.parse("2026-09-05T12:00:00Z");
const hour = 60 * 60 * 1000;
const nightly = (hoursAgo, overrides = {}) => ({
  tag_name: "v1.0.1-nightly.20260905.123",
  draft: false,
  published_at: new Date(now - hoursAgo * hour).toISOString(),
  ...overrides,
});

const npmLatest = (version) => async () => ({
  ok: true,
  status: 200,
  async json() {
    return { version };
  },
});
const npmMissing = async () => ({ ok: false, status: 404 });

function releaseSourceFixture({
  comparisonStatus = "ahead",
  eventName = "workflow_dispatch",
  ref = "refs/heads/main",
  sha = "candidate",
} = {}) {
  const calls = [];
  return {
    calls,
    options: {
      context: {
        eventName,
        payload: { repository: { default_branch: "main" } },
        ref,
        repo: { owner: "example", repo: "app" },
        sha,
      },
      github: {
        rest: {
          repos: {
            async compareCommitsWithBasehead(params) {
              calls.push(params);
              return { data: { status: comparisonStatus } };
            },
          },
        },
      },
    },
  };
}

test("allows preview releases from any branch without consulting main", async () => {
  const { options, calls } = releaseSourceFixture({ ref: "refs/heads/feature" });
  await assertReleaseSource({ ...options, releaseChannel: "preview" });
  assert.equal(calls.length, 0);
});

for (const releaseChannel of ["stable", "nightly"]) {
  test(`rejects a manual ${releaseChannel} release from a feature branch`, async () => {
    const { options, calls } = releaseSourceFixture({ ref: "refs/heads/feature" });
    await assert.rejects(
      assertReleaseSource({ ...options, releaseChannel }),
      new RegExp(`${releaseChannel} releases must be dispatched from main`),
    );
    assert.equal(calls.length, 0);
  });

  test(`allows a manual ${releaseChannel} release from main`, async () => {
    const { options, calls } = releaseSourceFixture();
    await assertReleaseSource({ ...options, releaseChannel });
    assert.equal(calls[0].basehead, "candidate...main");
  });
}

for (const comparisonStatus of ["behind", "diverged"]) {
  test(`rejects a release commit that is ${comparisonStatus} from main`, async () => {
    const { options } = releaseSourceFixture({ comparisonStatus, eventName: "push" });
    await assert.rejects(
      assertCommitOnDefaultBranch({ ...options, sha: "release-commit" }),
      new RegExp(`not contained in main \\(${comparisonStatus}\\)`),
    );
  });
}

test("accepts a release commit already contained in main", async () => {
  for (const comparisonStatus of ["ahead", "identical"]) {
    const { options } = releaseSourceFixture({ comparisonStatus, eventName: "push" });
    await assertCommitOnDefaultBranch({ ...options, sha: "release-commit" });
  }
});

test("rejects suffixed tags from the stable channel", async () => {
  const { options, calls } = releaseSourceFixture({
    eventName: "push",
    ref: "refs/tags/v1.2.3-rc.1",
  });

  await assert.rejects(
    assertReleaseSource({ ...options, releaseChannel: "stable" }),
    /Stable release tags must match vX\.Y\.Z/,
  );
  assert.equal(calls.length, 0);
});

test("rejects stable promotion when its nightly is not newer than published stable", async () => {
  const { options } = fixture({ releases: [] });

  await assert.rejects(
    assertReleaseVersionIsCurrent({
      ...options,
      fetch: npmLatest("0.0.49"),
      releaseChannel: "stable",
      version: "0.0.41",
    }),
    /0\.0\.41.*not newer.*0\.0\.49/,
  );
});

test("accepts stable and nightly versions only when their core is ahead", async () => {
  const { options } = fixture({ releases: [] });
  const published = { ...options, fetch: npmLatest("0.0.49") };

  await assertReleaseVersionIsCurrent({
    ...published,
    releaseChannel: "stable",
    version: "0.0.50",
  });
  await assertReleaseVersionIsCurrent({
    ...published,
    releaseChannel: "nightly",
    version: "0.0.50-nightly.20260916.30",
  });
  await assert.rejects(
    assertReleaseVersionIsCurrent({
      ...published,
      releaseChannel: "nightly",
      version: "0.0.49-nightly.20260916.30",
    }),
    /not newer than published stable/,
  );
});

function fixture({ releases = [nightly(7)], comparisonStatus = "ahead" } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      now,
      fetch: npmMissing,
      context: { repo: { owner: "example", repo: "app" }, sha: "new" },
      core: { info() {} },
      github: {
        rest: {
          repos: {
            listReleases() {},
            async compareCommitsWithBasehead(params) {
              calls.push(params);
              return { data: { status: comparisonStatus } };
            },
          },
        },
        async paginate() {
          return releases;
        },
      },
    },
  };
}

test("puts nightly on the release after the newest stable version", async () => {
  const { options } = fixture({
    releases: [
      nightly(1, { tag_name: "v0.0.41-nightly.20260915.29" }),
      nightly(2, { tag_name: "v0.0.49", prerelease: false }),
    ],
  });

  assert.equal(await resolveNextNightlyVersion(options), "0.0.50");
});

test("puts nightly after npm stable when GitHub release publication failed", async () => {
  const { options } = fixture({
    releases: [nightly(1, { tag_name: "v0.0.41-nightly.20260915.29" })],
  });

  assert.equal(
    await resolveNextNightlyVersion({ ...options, fetch: npmLatest("0.0.49") }),
    "0.0.50",
  );
});

test("never moves nightly back from a higher existing release line", async () => {
  const { options } = fixture({
    releases: [
      nightly(1, { tag_name: "v0.0.60-nightly.20260915.29" }),
      nightly(2, { tag_name: "v0.0.49", prerelease: false }),
    ],
  });

  assert.equal(await resolveNextNightlyVersion(options), "0.0.60");
});

test("continues an existing nightly line before the first stable release", async () => {
  const { options } = fixture({
    releases: [nightly(1, { tag_name: "v0.0.41-nightly.20260915.29" })],
  });

  assert.equal(await resolveNextNightlyVersion(options), "0.0.41");
});

test("falls back to the desktop package version before any release exists", async () => {
  const { options } = fixture({ releases: [] });

  assert.equal(await resolveNextNightlyVersion(options), undefined);
});

test("releases the first nightly when no nightly is published", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tag_name: "v1.0.0" }), nightly(0, { draft: true })],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("waits six hours after publication, including manual nightlies", async () => {
  for (const age of [0, 3, 6 - 1 / 3600]) {
    const { options, calls } = fixture({ releases: [nightly(age)] });
    assert.equal(await shouldReleaseNightly(options), false);
    assert.equal(calls.length, 0);
  }
});

test("releases new commits at six hours and after an idle period", async () => {
  for (const age of [6, 7, 24]) {
    const { options } = fixture({ releases: [nightly(age)] });
    assert.equal(await shouldReleaseNightly(options), true);
  }
});

test("skips unchanged commits after the gap", async () => {
  const { options } = fixture({ comparisonStatus: "identical" });
  assert.equal(await shouldReleaseNightly(options), false);
});

test("uses publication time, not release order or the tagged commit date", async () => {
  const { options } = fixture({
    releases: [nightly(10), nightly(1), nightly(20, { tag_name: "nightly-v0.9.0" })],
  });
  assert.equal(await shouldReleaseNightly(options), false);
});

test("ignores stable releases and drafts when checking the gap", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tag_name: "v1.0.0" }), nightly(0, { draft: true }), nightly(7)],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("compares against the published tag, including legacy nightly tags", async () => {
  const tag = "nightly-v0.9.0";
  const { options, calls } = fixture({ releases: [nightly(7, { tag_name: tag })] });
  assert.equal(await shouldReleaseNightly(options), true);
  assert.equal(calls[0].basehead, `${tag}...new`);
});

test("fails instead of releasing when GitHub cannot supply release state", async () => {
  const { options } = fixture();
  options.github.paginate = async () => {
    throw new Error("GitHub unavailable");
  };
  await assert.rejects(shouldReleaseNightly(options), /GitHub unavailable/);
});

for (const status of ["behind", "diverged"]) {
  test(`skips a candidate commit that is ${status} relative to the last nightly`, async () => {
    const { options } = fixture({ comparisonStatus: status });
    assert.equal(await shouldReleaseNightly(options), false);
  });
}

const { resolveLatestNightlyCommit } = require("./check-nightly-release.cjs");

function nightlyCommitFixture({ releases, commitSha = "abc123" }) {
  const refs = [];
  const { options } = fixture({ releases });
  options.github.rest.repos.getCommit = async ({ ref }) => {
    refs.push(ref);
    return { data: { sha: commitSha } };
  };
  return { options, refs };
}

test("stable releases resolve the commit of the newest published nightly", async () => {
  const { options, refs } = nightlyCommitFixture({
    releases: [
      nightly(10, { tag_name: "v1.0.1-nightly.20260905.100" }),
      nightly(1, { tag_name: "v1.0.1-nightly.20260905.123" }),
      nightly(0, { tag_name: "v1.0.0" }),
      nightly(0, { draft: true, tag_name: "v1.0.1-nightly.20260905.999" }),
    ],
    commitSha: "deadbeef",
  });
  assert.deepEqual(await resolveLatestNightlyCommit(options), {
    tag: "v1.0.1-nightly.20260905.123",
    sha: "deadbeef",
    version: "1.0.1",
  });
  assert.deepEqual(refs, ["v1.0.1-nightly.20260905.123"]);
});

test("stable releases derive the version from legacy nightly tags", async () => {
  const { options } = nightlyCommitFixture({
    releases: [nightly(1, { tag_name: "nightly-v0.9.0-nightly.20260905.5" })],
  });
  assert.equal((await resolveLatestNightlyCommit(options)).version, "0.9.0");
});

test("stable releases fail without a published nightly", async () => {
  const { options } = nightlyCommitFixture({ releases: [nightly(0, { tag_name: "v1.0.0" })] });
  await assert.rejects(resolveLatestNightlyCommit(options), /No published nightly/);
});
