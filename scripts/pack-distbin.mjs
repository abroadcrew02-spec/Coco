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

const candidates = [
  // Raw executable next to target/release/.
  { src: join(tauriTargetRoot, "coco.exe"), label: "exe" },
  { src: join(tauriTargetRoot, "Coco.exe"), label: "exe" },
  { src: join(tauriTargetRoot, "coco"), label: "binary" },
  { src: join(tauriTargetRoot, "Coco"), label: "binary" },
];

const bundleDir = join(tauriTargetRoot, "bundle");

// Discover Tauri bundle outputs (msi, nsis, deb, dmg, app, AppImage, rpm).
// Each bundler writes to its own subdir; just walk one level deep.
function discoverBundles() {
  if (!existsSync(bundleDir)) return [];
  const out = [];
  for (const sub of readdirSync(bundleDir)) {
    const subPath = join(bundleDir, sub);
    if (!statSync(subPath).isDirectory()) continue;
    for (const entry of readdirSync(subPath)) {
      const entryPath = join(subPath, entry);
      // Skip .app on macOS (it's a directory bundle), keep the .dmg sibling.
      if (entry.endsWith(".app") || !statSync(entryPath).isFile()) continue;
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

console.log(`[pack-distbin] Staged ${manifest.length} artifact(s) in ${distBin}`);
