// The failure mode: a scanner's output believed too easily. Two answers must never look
// alike — "the export could not be read" and "the code is clean" — because one of them
// ends a mission with a green light on work nobody checked. The other half is cost: the
// argv is what decides whether a gate scans four files or four thousand.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_MIN_SEVERITY, SCANNER_SEVERITIES } from "../domain/artifacts.js";
import {
  describeFindings,
  findingsAtOrAbove,
  parseScannerExport,
  scannerArgv,
} from "./scanner.js";

const finding = (patch: Record<string, unknown> = {}) => ({
  title: "[HIGH] Command injection in the deploy script",
  description: "…",
  ...patch,
  metadata: {
    filePath: "scripts/deploy.sh",
    severity: "HIGH",
    lineNumbers: [42, 43],
    vulnSlug: "command-injection",
    confidence: "high",
    ...((patch.metadata as Record<string, unknown>) ?? {}),
  },
});

describe("parseScannerExport", () => {
  test("reads the bare array deepsec writes, not a wrapper object", () => {
    const parsed = parseScannerExport(JSON.stringify([finding()]));

    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.findings.length, 1);
    assert.equal(parsed.ok && parsed.findings[0]!.metadata.filePath, "scripts/deploy.sh");
  });

  test("an empty export is a clean run, not a broken one", () => {
    const parsed = parseScannerExport("[]");

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.findings, []);
  });

  // The whole reason this is zod at the boundary rather than a cast: an export whose
  // shape moved under us has to be loud. Read as "no findings", a scanner upgrade would
  // silently pass every security criterion in the system.
  test("a wrapper object is refused rather than read as no findings", () => {
    const parsed = parseScannerExport(JSON.stringify({ findings: [finding()] }));

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.message, /bare array of findings/);
  });

  test("an unknown severity is refused and the message lists the real ones", () => {
    const parsed = parseScannerExport(
      JSON.stringify([finding({ metadata: { severity: "SPICY" } })]),
    );

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.message, /CRITICAL, HIGH, HIGH_BUG, MEDIUM, BUG, LOW/);
  });

  test("text that is not JSON at all names the fix instead of throwing", () => {
    const parsed = parseScannerExport("Scanning 4 files…\nDone.");

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.message, /orchestra doctor/);
  });

  // deepsec's export carries ownership, labels, run ids and a revalidation block this
  // gate has no opinion about. A schema that refused them would turn every upstream
  // addition into a mission that fails its own security check.
  test("fields this gate does not read are carried, not refused", () => {
    const parsed = parseScannerExport(
      JSON.stringify([
        finding({
          labels: ["severity:HIGH"],
          assignee: "nobody",
          metadata: { githubUrl: "https://example.invalid", owners: [] },
        }),
      ]),
    );

    assert.equal(parsed.ok, true);
  });
});

describe("scannerArgv", () => {
  const argv = (files: string[]) =>
    scannerArgv({ files, out: "/tmp/out.json", since: "2026-08-16T12:00:00.000Z" });

  // The cost control, and the reason it is a file list rather than a whole-repo scan:
  // deepsec's own figures put two thousand files at hundreds of dollars.
  test("scans the named files and nothing else, over stdin", () => {
    const a = argv(["src/a.ts", "src/b.ts"]);

    assert.deepEqual(a.scan, ["process", "--files-from", "-"]);
    assert.equal(a.filesInput, "src/a.ts\nsrc/b.ts\n");
  });

  // A comma is legal in a filename and `--files <csv>` would split one path into two that
  // do not exist — which arrives as "the scanner is broken", not "that name is odd".
  test("a comma in a filename does not become two paths", () => {
    assert.equal(argv(["src/a,b.ts"]).filesInput, "src/a,b.ts\n");
  });

  test("a path with a space stays one path", () => {
    assert.equal(argv(["src/my file.ts"]).filesInput, "src/my file.ts\n");
  });

  test("exports to a file, because stdout carries progress lines before the JSON", () => {
    assert.ok(argv(["src/a.ts"]).export.includes("--out"));
    assert.equal(argv(["src/a.ts"]).export.at(-1), "/tmp/out.json");
  });

  // deepsec's store persists in `.deepsec/` across rounds, so an unscoped export carries
  // findings a later round already fixed and the criterion could never go green again.
  test("the export is scoped to this scan", () => {
    const a = argv(["src/a.ts"]);
    const at = a.export.indexOf("--since");

    assert.ok(at >= 0);
    assert.equal(a.export[at + 1], "2026-08-16T12:00:00.000Z");
  });

  // Not `--min-severity`, and this is the load-bearing half. deepsec exits 1 both for a
  // finding and for a batch its agent could not run, so "exit 1 and an empty export" has
  // to mean "the scan broke" — which it only does if the export carried everything.
  test("the threshold is not deepsec's, so an empty export means nothing ran", () => {
    assert.ok(!argv(["src/a.ts"]).export.includes("--min-severity"));
    assert.ok(!argv(["src/a.ts"]).scan.includes("--agent"));
  });
});

describe("findingsAtOrAbove", () => {
  const at = (severity: string) => {
    const parsed = parseScannerExport(JSON.stringify([finding({ metadata: { severity } })]));
    assert.ok(parsed.ok);
    return parsed.findings[0]!;
  };

  // The ladder is not alphabetical and not guessable: `HIGH_BUG` sits *below* `HIGH` and
  // above `MEDIUM` in deepsec's own export sort. Read as a synonym for HIGH it would fail
  // missions on findings the threshold was chosen to let through.
  test("HIGH admits CRITICAL and HIGH, and HIGH_BUG is softer than both", () => {
    const all = SCANNER_SEVERITIES.map(at);

    assert.deepEqual(
      findingsAtOrAbove(all, "HIGH").map((f) => f.metadata.severity),
      ["CRITICAL", "HIGH"],
    );
    assert.deepEqual(
      findingsAtOrAbove(all, "HIGH_BUG").map((f) => f.metadata.severity),
      ["CRITICAL", "HIGH", "HIGH_BUG"],
    );
  });

  test("the default is HIGH", () => {
    const all = SCANNER_SEVERITIES.map(at);

    assert.deepEqual(findingsAtOrAbove(all), findingsAtOrAbove(all, DEFAULT_MIN_SEVERITY));
  });

  test("LOW admits everything and CRITICAL admits only itself", () => {
    const all = SCANNER_SEVERITIES.map(at);

    assert.equal(findingsAtOrAbove(all, "LOW").length, SCANNER_SEVERITIES.length);
    assert.deepEqual(
      findingsAtOrAbove(all, "CRITICAL").map((f) => f.metadata.severity),
      ["CRITICAL"],
    );
  });
});

describe("describeFindings", () => {
  test("one line each: severity, where, what, and which rule", () => {
    const parsed = parseScannerExport(JSON.stringify([finding()]));
    assert.ok(parsed.ok);

    const described = describeFindings(parsed.findings);

    assert.match(described, /^HIGH scripts\/deploy\.sh:42 — /);
    assert.match(described, /\(command-injection\)$/);
  });

  // The evidence rides in every progress call's context for the rest of the mission, so
  // it is the summary and the export on disk is the detail.
  test("the full description blob is not in it", () => {
    const parsed = parseScannerExport(
      JSON.stringify([finding({ description: "a very long markdown writeup" })]),
    );
    assert.ok(parsed.ok);

    assert.doesNotMatch(describeFindings(parsed.findings), /markdown writeup/);
  });
});
