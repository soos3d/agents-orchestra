// PLAN-NEXT 3.1. The failure modes a containment runtime fails at quietly: a worker that
// is "contained" but still on the open network, a secret copied into the argv where `ps`
// can read it, a mount path remapped so the escape checks compare a tree the worker never
// touched, and root-owned files left in a mounted worktree that git can then neither
// stage nor remove.
//
// The argv assertions run everywhere; the live ones need a daemon and a local image and
// skip with the reason when there is none (`testing/container.ts`).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { testContainment } from "../testing/container.js";
import { bindMount, containerArgv, runContained, type Containment } from "./contained.js";

const docker: Containment = { backend: "docker", image: "orchestra/worker:test" };
const where = { cwd: "/w/task-3" };

const flagValue = (argv: readonly string[], flag: string): string | undefined =>
  argv[argv.indexOf(flag) + 1];

describe("containerArgv", () => {
  test("denies the network unless the operator named one", () => {
    assert.equal(flagValue(containerArgv(docker, where, [], "claude", []), "--network"), "none");
    assert.equal(
      flagValue(containerArgv({ ...docker, network: "registries" }, where, [], "claude", []), "--network"),
      "registries",
    );
  });

  // The whole point of the runtime, and the one flag whose absence is invisible: a
  // container with the default bridge network looks identical from above.
  test("never pulls at dispatch — a missing image fails, it does not fetch", () => {
    assert.ok(containerArgv(docker, where, [], "claude", []).includes("--pull=never"));
  });

  // Identity of paths is what makes containment invisible to `detectEscape`, the `owns`
  // lease check and the artifact directory in the worker's prompt. A tidy `/workspace`
  // would make every one of those compare the wrong tree while looking right.
  test("mounts the worktree at the same path inside and out, and makes it the workdir", () => {
    const argv = containerArgv(docker, where, [], "claude", []);

    assert.ok(argv.includes("type=bind,src=/w/task-3,dst=/w/task-3"));
    assert.equal(flagValue(argv, "--workdir"), "/w/task-3");
  });

  test("mounts the artifact directory too, and nothing else", () => {
    const argv = containerArgv(
      docker,
      { cwd: "/w/task-3", mounts: ["/state/artifacts/task-3"] },
      [],
      "claude",
      [],
    );

    const mounted = argv.filter((_, i) => argv[i - 1] === "--mount");
    assert.deepEqual(mounted, [
      "type=bind,src=/w/task-3,dst=/w/task-3",
      "type=bind,src=/state/artifacts/task-3,dst=/state/artifacts/task-3",
    ]);
  });

  // `-v host:container` would split a path with a colon into three fields and mount
  // something else entirely. Refusing loudly beats mounting the wrong directory.
  test("refuses a path it cannot express in a --mount argument", () => {
    assert.throws(() => bindMount("/w/task,3"), /cannot be expressed/);
    assert.throws(() => bindMount("/w/a=b"), /cannot be expressed/);
    assert.doesNotThrow(() => bindMount("/w/task:3"));
  });

  // A value in the argv is readable by every process on the machine. `--env NAME` copies
  // it from the backend CLI's own environment instead.
  test("passes environment variable names, never their values", () => {
    const argv = containerArgv(docker, where, ["ANTHROPIC_API_KEY", "PATH"], "claude", ["-p"]);

    assert.deepEqual(
      argv.filter((_, i) => argv[i - 1] === "--env"),
      ["ANTHROPIC_API_KEY", "PATH"],
    );
    // `--env NAME=VALUE` is the shape this must never take: an argv is world-readable.
    assert.ok(!argv.some((arg) => arg.startsWith("ANTHROPIC_API_KEY=")));
  });

  // An image with its own ENTRYPOINT would otherwise treat `claude` as an argument to
  // whatever it was built to run — and start it, and return its output as the worker's
  // report. Nothing about that failure is loud.
  test("runs the command as the entrypoint, whatever the image was built to run", () => {
    const argv = containerArgv(docker, where, [], "claude", ["-p", "--model", "sonnet"]);
    const image = argv.indexOf("orchestra/worker:test");

    assert.equal(argv[image - 2], "--entrypoint");
    assert.equal(argv[image - 1], "claude");
    assert.deepEqual(argv.slice(image), ["orchestra/worker:test", "-p", "--model", "sonnet"]);
  });

  test("runs as the operator when the platform has a uid, so files stay theirs", () => {
    assert.equal(flagValue(containerArgv({ ...docker, user: "501:20" }, where, [], "sh", []), "--user"), "501:20");
    assert.ok(!containerArgv(docker, where, [], "sh", []).includes("--user"));
  });
});

const live = await testContainment();
const skip = typeof live === "string" ? live : false;

describe("runContained, against a real backend", { skip }, () => {
  const containment = live as Containment;

  test("runs the command inside the container, in the mounted directory", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "contained-"));

    const result = await runContained(containment, { cwd: dir }, "/bin/sh", ["-c", "pwd"], {
      timeoutMs: 60_000,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The done-when clause: a contained worker that reaches for the open network fails
  // loudly rather than quietly succeeding.
  test("has no network", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "contained-"));

    const result = await runContained(
      containment,
      { cwd: dir },
      "/bin/sh",
      ["-c", "getent hosts registry.npmjs.org || nslookup registry.npmjs.org"],
      { timeoutMs: 60_000 },
    );

    assert.notEqual(result.code, 0, `resolved a host with --network none: ${result.stdout}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a file the contained process writes is the operator's, in the mounted directory", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "contained-"));

    const result = await runContained(
      containment,
      { cwd: dir },
      "/bin/sh",
      ["-c", "printf built > made-here.txt"],
      { timeoutMs: 60_000 },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(dir, "made-here.txt"), "utf8"), "built");
    // Removable by this process, which is the half that breaks when the container runs
    // as root: `removeWorktree` and `git` both fail on a file they cannot touch.
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the container's environment is what was constructed, and nothing of the parent's", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "contained-"));

    const result = await runContained(containment, { cwd: dir }, "/bin/sh", ["-c", "echo $GRANTED-$SECRET"], {
      timeoutMs: 60_000,
      env: { GRANTED: "yes" },
    });

    assert.equal(result.stdout.trim(), "yes-");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
