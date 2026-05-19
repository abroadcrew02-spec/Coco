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
// Output schema (Tauri v2 updater "static" endpoint):
//   {
//     "version": "0.1.0",
//     "notes": "release notes markdown ...",
//     "pub_date": "2026-05-19T00:00:00.000Z",
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

// -----------------------------------------------------------------------------
// CLI parsing — no extra deps. Flags: --bundle-format, --out, --repo-slug.
// -----------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    bundleFormat: "nsis",
    outPath: join(root, "latest.json"),
    repoSlug: "abroadcrew02-spec/Coco",
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--bundle-format") {
      if (next !== "nsis" && next !== "msi") {
        console.error(`[build-latest-json] --bundle-format must be 'nsis' or 'msi' (got ${next})`);
        process.exit(1);
      }
      out.bundleFormat = next;
      i++;
    } else if (arg === "--out") {
      out.outPath = resolve(next);
      i++;
    } else if (arg === "--repo-slug") {
      out.repoSlug = next;
      i++;
    } else {
      console.error(`[build-latest-json] unknown arg: ${arg}`);
      process.exit(1);
    }
  }
  return out;
}

const { bundleFormat, outPath, repoSlug } = parseArgs(process.argv);

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

// NSIS produces *.nsis.zip; MSI produces *.msi.zip. Match either.
const zipSuffix = bundleFormat === "nsis" ? ".nsis.zip" : ".msi.zip";

function findUpdaterZip() {
  const entries = readdirSync(bundleDir);
  // Prefer the file whose name contains the package version (filters stale
  // bundles from prior versioned builds, same rationale as pack-distbin.mjs #59).
  const versioned = entries.filter((e) => e.endsWith(zipSuffix) && e.includes(pkgVersion));
  if (versioned.length > 0) return versioned[0];
  const any = entries.filter((e) => e.endsWith(zipSuffix));
  if (any.length > 0) return any[0];
  return null;
}

const zipName = findUpdaterZip();
if (!zipName) {
  console.error(
    `[build-latest-json] no *${zipSuffix} found in ${bundleDir}\n` +
      `  Tauri's updater needs the zipped installer artifact. Check\n` +
      `  src-tauri/tauri.conf.json -> bundle.${bundleFormat}.updater = true.`,
  );
  process.exit(1);
}

const sigName = zipName + ".sig";
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
  // lines). The leading anchor `^` is multi-line.
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s*(?:\\[${escaped}\\]|v${escaped})[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|\\Z)`, "m");
  const m = text.match(re);
  if (m) return m[1].trim();
  return "";
}

const notes = readNotes(pkgVersion);

// -----------------------------------------------------------------------------
// Build URL + assemble JSON.
// -----------------------------------------------------------------------------
const url = `https://github.com/${repoSlug}/releases/download/v${pkgVersion}/${basename(zipName)}`;

const latest = {
  version: pkgVersion,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url,
    },
  },
};

writeFileSync(outPath, JSON.stringify(latest, null, 2) + "\n");

console.log(
  `[build-latest-json] wrote ${basename(outPath)} (version=${pkgVersion}, signature=${signature.length} bytes)`,
);
