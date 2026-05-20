#!/usr/bin/env node
// Stage Tauri's signed/unsigned release artifacts into ./distbin/ so the
// user has a single, obvious place to find the installer + raw .exe after a
// release build. Run via `npm run pack` (defined in package.json).
//
// Tauri v2 writes outputs to src-tauri/target/release/{bundle/<format>/, Coco.exe}
// on Windows and similar tree elsewhere. We scan a small allow-list of
// expected paths and copy whatever exists into ./distbin/, computing SHA-256
// alongside each binary for distribution per requirements.md §5.6.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriTargetRoot = join(root, "src-tauri", "target", "release");
const distBin = join(root, "distbin");

// Read the current package version so we can filter stale bundle artifacts
// left from prior builds (#59). Bundles whose filename doesn't contain the
// current version OR whose mtime predates the latest binary are excluded.
const pkgVersion = (() => {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
})();

const candidates = [
  // Raw executable next to target/release/.
  { src: join(tauriTargetRoot, "coco.exe"), label: "exe" },
  { src: join(tauriTargetRoot, "Coco.exe"), label: "exe" },
  { src: join(tauriTargetRoot, "coco"), label: "binary" },
  { src: join(tauriTargetRoot, "Coco"), label: "binary" },
];

const bundleDir = join(tauriTargetRoot, "bundle");

// Pick the freshest mtime among the raw release binaries — used as a floor for
// bundle freshness. If the user's `tauri build` just produced Coco.exe, any
// bundle older than that exe is definitely a stale artifact from a prior run.
function latestBinaryMtime() {
  let latest = 0;
  for (const c of candidates) {
    if (!existsSync(c.src)) continue;
    const m = statSync(c.src).mtimeMs;
    if (m > latest) latest = m;
  }
  return latest;
}

// Discover Tauri bundle outputs (msi, nsis, deb, dmg, app, AppImage, rpm).
// Each bundler writes to its own subdir; just walk one level deep.
//
// #59: filter on (version-in-name OR mtime >= latest binary mtime - 5min). The
// 5-minute slack absorbs clock skew and ordering between binary + bundle writes
// inside a single `tauri build` invocation.
function discoverBundles() {
  if (!existsSync(bundleDir)) return [];
  const freshFloor = latestBinaryMtime() - 5 * 60 * 1000;
  const out = [];
  for (const sub of readdirSync(bundleDir)) {
    const subPath = join(bundleDir, sub);
    if (!statSync(subPath).isDirectory()) continue;
    for (const entry of readdirSync(subPath)) {
      const entryPath = join(subPath, entry);
      // Skip .app on macOS (it's a directory bundle), keep the .dmg sibling.
      if (entry.endsWith(".app") || !statSync(entryPath).isFile()) continue;
      const mtime = statSync(entryPath).mtimeMs;
      const matchesVersion = pkgVersion ? entry.includes(pkgVersion) : false;
      if (!matchesVersion && mtime < freshFloor) {
        console.warn(
          `[pack-distbin] skip stale bundle ${sub}/${entry} (version != ${pkgVersion}, mtime older than current build)`,
        );
        continue;
      }
      out.push({ src: entryPath, label: sub });
    }
  }
  return out;
}

function sha256(filePath) {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function staged(name) {
  return join(distBin, name);
}

function clearDistBin() {
  if (!existsSync(distBin)) return;
  rmSync(distBin, { recursive: true, force: true });
}

function copyArtifact(src) {
  const dst = staged(basename(src));
  copyFileSync(src, dst);
  return dst;
}

const allCandidates = [...candidates, ...discoverBundles()].filter((c) =>
  existsSync(c.src),
);

if (allCandidates.length === 0) {
  console.error(
    "[pack-distbin] No build artifacts found.\n" +
      `  Looked under: ${tauriTargetRoot}\n` +
      "  Run `npm run tauri build` first.",
  );
  process.exit(1);
}

clearDistBin();
mkdirSync(distBin, { recursive: true });

const manifest = [];
for (const c of allCandidates) {
  const dst = copyArtifact(c.src);
  const sum = sha256(dst);
  manifest.push({ file: basename(dst), kind: c.label, sha256: sum, bytes: statSync(dst).size });
  console.log(`[pack-distbin] ${c.label.padEnd(8)} ${basename(dst)}  (${sum.slice(0, 12)}…)`);
}

writeFileSync(
  join(distBin, "SHA256SUMS.txt"),
  manifest.map((m) => `${m.sha256}  ${m.file}`).join("\n") + "\n",
);
writeFileSync(
  join(distBin, "manifest.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), artifacts: manifest }, null, 2) + "\n",
);

// Regenerate distbin/README.md from the template so installer notes always
// accompany the artifacts (requirements.md §5.6: distribution materials).
const readmeTemplate = join(root, "docs", "DISTBIN_README_TEMPLATE.md");
if (existsSync(readmeTemplate)) {
  copyFileSync(readmeTemplate, join(distBin, "README.md"));
  console.log(`[pack-distbin] readme    README.md  (from docs/DISTBIN_README_TEMPLATE.md)`);
} else {
  console.warn(
    `[pack-distbin] WARN: ${readmeTemplate} not found; distbin/README.md not generated.`,
  );
}

console.log(`[pack-distbin] Staged ${manifest.length} artifact(s) in ${distBin}`);
