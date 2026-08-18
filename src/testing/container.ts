// A real container backend for a test, or the reason there is not one.
//
// The containment runtime cannot be proved by a mock: what it does is rewrite an argv so
// that a *daemon* isolates a process, and a fake backend would assert the string this
// file already asserts while proving nothing about whether a worker is actually contained.
// So the tests that matter here run a real container — and most machines that run this
// suite have no daemon, so they have to skip, with a reason that says which half is
// missing rather than a silent green.
//
// Two halves, because they fail differently and the fix is different. A backend CLI whose
// daemon is not running is `docker desktop start`; a daemon with none of the small images
// local is a `docker pull`, and it cannot be papered over by pulling one here — the
// runtime passes `--pull=never` on purpose, and a test that reached the network to get an
// image would be testing the opposite of the feature.
import { CONTAINER_BACKENDS, type Containment } from "../runtime/contained.js";
import { run } from "../runtime/sh.js";
import { containmentFor } from "../workers/availability.js";

/**
 * Images small enough that a developer plausibly has one, tried in order. Each must have
 * a shell at `/bin/sh`, which is all the contained tests ask of it.
 *
 * `ORCHESTRA_TEST_CONTAINER_IMAGE` overrides the list, and it is how these tests were
 * first run: the machine that wrote them could reach its daemon and not the registry, so
 * "pull alpine" was not available and any local image with a shell had to do. Nothing is
 * pulled here on purpose — the runtime passes `--pull=never`, and a test that reached the
 * network to fetch an image would be testing the opposite of the feature.
 */
const TEST_IMAGES: readonly string[] = process.env.ORCHESTRA_TEST_CONTAINER_IMAGE
  ? [process.env.ORCHESTRA_TEST_CONTAINER_IMAGE]
  : ["alpine", "busybox", "alpine:latest", "busybox:latest"];

const PROBE_TIMEOUT_MS = 15_000;

/**
 * A live backend and a local image, or a sentence naming what is missing.
 *
 * Returns the reason as a string rather than throwing, so a test file can hand it
 * straight to `node:test`'s `skip` option and the skipped line says why.
 */
export async function testContainment(): Promise<Containment | string> {
  const backend = await liveBackend();
  if (backend === undefined) {
    return `no container backend answering (${CONTAINER_BACKENDS.join(" / ")} daemon not running)`;
  }

  const image = await localImage(backend);
  if (image === undefined) {
    return `${backend} has none of ${TEST_IMAGES.join(", ")} pulled locally`;
  }

  // Built through the production path rather than as a literal, so a test that passes
  // here is evidence about `containmentFor` too — including that its `clientVars` are
  // enough for the backend CLI to find its own daemon. A hand-written literal with no
  // PATH fails as "docker not found on PATH", which is a true sentence about the wrong
  // thing and cost this file a debugging round.
  const contained = containmentFor({ containment: "container" }, {
    agents: [],
    containers: [backend],
    containerImage: image,
  });
  return contained ?? `containmentFor refused ${backend}/${image}`;
}

async function liveBackend(): Promise<string | undefined> {
  for (const backend of CONTAINER_BACKENDS) {
    if (await answers(backend)) return backend;
  }
  return undefined;
}

/**
 * Whether a backend's daemon is actually reachable.
 *
 * `version --format {{.Server.Version}}` rather than `info`, and that is not a style
 * choice: with the daemon stopped, `docker info` prints "Cannot connect to the Docker
 * daemon" and **exits 0**, so a probe reading the exit code alone would report a backend
 * that cannot start a container — defect 21's shape, one subsystem over. `version` exits
 * 1 in the same state. The non-empty check is the belt to that brace.
 */
async function answers(backend: string): Promise<boolean> {
  const result = await run(backend, ["version", "--format", "{{.Server.Version}}"], {
    timeoutMs: PROBE_TIMEOUT_MS,
  }).catch(() => undefined);
  return result?.code === 0 && result.stdout.trim() !== "";
}

async function localImage(backend: string): Promise<string | undefined> {
  for (const image of TEST_IMAGES) {
    const result = await run(backend, ["image", "inspect", image], {
      timeoutMs: PROBE_TIMEOUT_MS,
    }).catch(() => undefined);
    if (result?.code === 0) return image;
  }
  return undefined;
}
