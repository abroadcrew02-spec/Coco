#!/usr/bin/env node
// Generate `latest.json` for the Tauri updater. Tauri's updater plugin polls a
// static JSON endpoint that points at the signed installer .zip + its minisign
// signature; this script assembles that file from the signed bundle outputs
// produced by `tauri build`.
//
// Triggered from the Release workflow (.github/workflows/release.yml) after
// `tauri build`. Mirrors the style of pack-distbin.mjs: Node built-ins only,
// CLI flags via plain argv parsing, single-pass with clear error messages.
//
// Output schema (Tauri v2 updater "static" endpoint) — Phase 2 adds three
// optional top-level fields parsed by src/store/updater.ts:
//   {
//     "version": "0.1.0",
//     "notes": "release notes markdown ...",
//     "pub_date": "2026-05-19T00:00:00.000Z",
//     "min_required_version": "0.1.0",       // optional, forces upgrade
//     "rollout": { "percent": 25, "seed": "v0.1.0" },  // optional, staged
//     "channel": "beta",                      // optional, omitted for stable
//     "platforms": {
//       "windows-x86_64": {
//         "signature": "<minisign string from .sig file>",
//         "url": "https://github.com/<slug>/releases/download/v<ver>/<file>"
//       }
//     }
//   }

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Semver including optional pre-release (`-rc1`) and build metadata (`+build123`).
// Mirrors the relevant subset of semver.org's BNF — used for `--min-required-version`
// input validation only (not for cross-version comparison, which lives in updater.ts).
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

// -----------------------------------------------------------------------------
// CLI parsing — no extra deps. Phase 1 flags: --bundle-format, --out, --repo-slug.
// Phase 2 adds: --min-required-version, --rollout-percent, --rollout-seed, --channel.
// Plus --help.
// -----------------------------------------------------------------------------
function printHelp() {
  console.log(`Usage: node scripts/build-latest-json.mjs [options]

Generate latest.json for the Tauri updater from signed bundle outputs.

Options:
  --bundle-format <nsis|msi>      Installer format to look for (default: nsis)
  --out <path>                    Output path for latest.json (default: ./latest.json)
  --repo-slug <owner/repo>        GitHub repo slug for asset URLs
                                  (default: abroadcrew02-spec/Coco)
  --min-required-version <semver> Optional floor; clients below this are
                                  force-upgraded. Format: X.Y.Z[-pre][+build]
  --rollout-percent <0-100>       Optional staged rollout. Integer percent of
                                  installations that should be offered the
                                  update. 0 = paused, 100 = full rollout.
  --rollout-seed <string>         Override the rollout seed (default: v<pkg-version>).
                                  Only emitted when --rollout-percent is set.
  --channel <stable|beta>         Release channel. 'stable' is the default and
                                  is omitted from the manifest; 'beta' is emitted.
  --help                          Print this help and exit.
`);
}

function parseArgs(argv) {
  const out = {
    bundleFormat: "nsis",
    outPath: join(root, "latest.json"),
    repoSlug: "abroadcrew02-spec/Coco",
    minRequiredVersion: null,
    rolloutPercent: null,
    rolloutSeed: null,
    channel: "stable",
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--bundle-format") {
      if (next !== "nsis" && next !== "msi") {
        console.error(`[build-latest-json] --bundle-format must be 'nsis' or 'msi' (got ${next})`);
        process.exit(1);
      }
      out.bundleFormat = next;
      i++;
    } else if (arg === "--out") {
      if (!next) {
        console.error("[build-latest-json] --out requires a path argument");
        process.exit(1);
      }
      out.outPath = resolve(next);
      i++;
    } else if (arg === "--repo-slug") {
      if (!next) {
        console.error("[build-latest-json] --repo-slug requires a value");
        process.exit(1);
      }
      out.repoSlug = next;
      i++;
    } else if (arg === "--min-required-version") {
      if (!next || !SEMVER_RE.test(next)) {
        console.error(
          `[build-latest-json] --min-required-version must be a valid semver (got ${next ?? "<none>"})\n` +
            `  Expected: X.Y.Z, optionally with -pre and/or +build (e.g. 1.0.0-rc1+build123)`,
        );
        process.exit(1);
      }
      out.minRequiredVersion = next;
      i++;
    } else if (arg === "--rollout-percent") {
      // Reject NaN, negatives, > 100, and non-integers. Accept 0 (paused).
      const n = Number(next);
      if (
        next === undefined ||
        !Number.isFinite(n) ||
        !Number.isInteger(n) ||
        n < 0 ||
        n > 100
      ) {
        console.error(
          `[build-latest-json] --rollout-percent must be an integer 0..100 (got ${next ?? "<none>"})`,
        );
        process.exit(1);
      }
      out.rolloutPercent = n;
      i++;
    } else if (arg === "--rollout-seed") {
      if (!next) {
        console.error("[build-latest-json] --rollout-seed requires a value");
        process.exit(1);
      }
      out.rolloutSeed = next;
      i++;
    } else if (arg === "--channel") {
      if (next !== "stable" && next !== "beta") {
        console.error(
          `[build-latest-json] --channel must be 'stable' or 'beta' (got ${next ?? "<none>"})`,
        );
        process.exit(1);
      }
      out.channel = next;
      i++;
    } else {
      console.error(`[build-latest-json] unknown arg: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  return out;
}

const {
  bundleFormat,
  outPath,
  repoSlug,
  minRequiredVersion,
  rolloutPercent,
  rolloutSeed,
  channel,
} = parseArgs(process.argv);

// -----------------------------------------------------------------------------
// Version from package.json (single source of truth, matches Tauri's bundle
// filename — `Coco_<version>_x64-setup.nsis.zip`).
// -----------------------------------------------------------------------------
const pkgVersion = (() => {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  } catch (err) {
    console.error("[build-latest-json] failed to read package.json:", err.message);
    process.exit(1);
  }
})();

// -----------------------------------------------------------------------------
// Locate the signed updater bundle + .sig sibling. Tauri writes these to
// src-tauri/target/release/bundle/<format>/. The .zip is the updater payload
// (Tauri unpacks it to perform the in-place update); the .sig is the minisign
// signature over that zip.
// -----------------------------------------------------------------------------
const bundleDir = join(root, "src-tauri", "target", "release", "bundle", bundleFormat);

if (!existsSync(bundleDir)) {
  console.error(
    `[build-latest-json] bundle dir not found: ${bundleDir}\n` +
      `  Did 'tauri build' run with bundles.${bundleFormat}.* configured?`,
  );
  process.exit(1);
}

// Tauri v2 emits the installer itself as the updater artifact (no .zip):
// NSIS -> *-setup.exe, MSI -> *.msi. Each is signed -> *.sig sibling.
const artifactSuffix = bundleFormat === "nsis" ? "-setup.exe" : ".msi";

function findUpdaterArtifact() {
  const entries = readdirSync(bundleDir);
  // Prefer the file whose name contains the package version (filters stale
  // bundles from prior versioned builds, same rationale as pack-distbin.mjs #59).
  const versioned = entries.filter((e) => e.endsWith(artifactSuffix) && e.includes(pkgVersion));
  if (versioned.length > 0) return versioned[0];
  const any = entries.filter((e) => e.endsWith(artifactSuffix));
  if (any.length > 0) return any[0];
  return null;
}

const artifactName = findUpdaterArtifact();
if (!artifactName) {
  console.error(
    `[build-latest-json] no *${artifactSuffix} found in ${bundleDir}\n` +
      `  'tauri build' must run with bundle.createUpdaterArtifacts = true and\n` +
      `  TAURI_SIGNING_PRIVATE_KEY set so the signed installer is emitted.`,
  );
  process.exit(1);
}

const sigName = artifactName + ".sig";
const sigPath = join(bundleDir, sigName);
if (!existsSync(sigPath)) {
  console.error(
    `[build-latest-json] signature file missing: ${sigPath}\n` +
      `  Set TAURI_SIGNING_PRIVATE_KEY (+ password) before 'tauri build' so the\n` +
      `  bundler emits ${sigName} alongside the zip.`,
  );
  process.exit(1);
}

// Minisign signature is plain text — two lines: untrusted-comment + base64 sig.
// Tauri's updater consumes this verbatim as the "signature" field.
const signature = readFileSync(sigPath, "utf8").trim();

// -----------------------------------------------------------------------------
// Release notes — prefer CHANGELOG/v<version>.md (per-tag file), else extract
// the matching section from root CHANGELOG.md, else empty string.
// -----------------------------------------------------------------------------
function readNotes(version) {
  const perTag = join(root, "CHANGELOG", `v${version}.md`);
  if (existsSync(perTag)) return readFileSync(perTag, "utf8").trim();

  const rootChangelog = join(root, "CHANGELOG.md");
  if (!existsSync(rootChangelog)) return "";

  const text = readFileSync(rootChangelog, "utf8");
  // Match either Keep a Changelog style `## [0.1.0]` or plain `## v0.1.0`.
  // Capture from the heading to the next `## ` heading (non-greedy across
  // lines), or end-of-string. The leading anchor `^` is multi-line.
  //
  // BUG FIX: the previous version used `\Z` to anchor end-of-input, but JS
  // regex has no `\Z` — it matched the literal characters `\` and `Z`, so the
  // last section of the changelog (no trailing `## ` heading) was never
  // captured. Replaced with `$` under the `m` flag — combined with the
  // non-greedy capture, this terminates at the next heading OR end-of-string.
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^##\\s*(?:\\[${escaped}\\]|v${escaped})[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    "m",
  );
  const m = text.match(re);
  if (m) return m[1].trim();
  return "";
}

const notes = readNotes(pkgVersion);

// -----------------------------------------------------------------------------
// Build URL + assemble JSON.
//
// Key ordering matters for diff readability and matches what src/store/updater.ts
// expects to read out: version, notes, pub_date, min_required_version, rollout,
// channel, platforms. V8 preserves insertion order for string keys, so we just
// add fields in that order conditionally.
// -----------------------------------------------------------------------------
const url = `https://github.com/${repoSlug}/releases/download/v${pkgVersion}/${basename(artifactName)}`;

const latest = {};
latest.version = pkgVersion;
latest.notes = notes;
latest.pub_date = new Date().toISOString();
if (minRequiredVersion !== null) {
  latest.min_required_version = minRequiredVersion;
}
if (rolloutPercent !== null) {
  latest.rollout = {
    percent: rolloutPercent,
    seed: rolloutSeed ?? `v${pkgVersion}`,
  };
}
if (channel !== "stable") {
  latest.channel = channel;
}
latest.platforms = {
  "windows-x86_64": {
    signature,
    url,
  },
};

writeFileSync(outPath, JSON.stringify(latest, null, 2) + "\n");

const extras = [];
if (minRequiredVersion !== null) extras.push(`min=${minRequiredVersion}`);
if (rolloutPercent !== null) extras.push(`rollout=${rolloutPercent}%`);
if (channel !== "stable") extras.push(`channel=${channel}`);
const extrasStr = extras.length ? `, ${extras.join(", ")}` : "";
console.log(
  `[build-latest-json] wrote ${basename(outPath)} (version=${pkgVersion}, signature=${signature.length} bytes${extrasStr})`,
);
