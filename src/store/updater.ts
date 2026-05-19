// Thin wrapper around `@tauri-apps/plugin-updater` (and a small slice of
// `@tauri-apps/plugin-process` for relaunch). This module is the single
// source of truth for our auto-update state machine and the
// localStorage-backed user preferences that drive it.
//
// Snapshot shape:
//   localStorage["coco.updater.checkOnLaunch"] = "true" | "false"
//     - default ON; explicit "false" disables the launch-time check
//   localStorage["coco.updater.skipVersion"]    = "<version string>" | absent
//     - if equal to the latest version returned by check(), the launcher
//       suppresses the dialog (the user can still trigger Help → Check for
//       Updates manually)
//   localStorage["coco.updater.lastChecked"]    = ISO-8601 timestamp | absent
//     - written on every successful check() to support a "last checked at"
//       display in Settings
//   localStorage["coco.updater.channel"]        = "stable" | "beta"
//     - Phase 2: user-selected update channel. Currently informational
//       only — the Tauri plugin's `endpoints` array is single-valued and
//       baked at build time. Wiring beta to a separate manifest URL is
//       deferred to Phase 2.1 (would require either a build-time variant
//       or extending the plugin config with a second endpoint).
//   localStorage["coco.installationId"]         = uuid v4 | absent
//     - Stable per-installation random identifier used to bucket the
//       staged rollout deterministically. Generated lazily on first
//       read; never reset by us.
//
// All localStorage access is wrapped in try/catch because the renderer may
// run with storage disabled (private mode, sandboxed iframe in tests, etc.).
//
// Tauri-plugin imports are deferred to call-time so that unit tests and
// type-checking can import this module without the Tauri runtime shim.

export type UpdateChannel = "stable" | "beta";

export interface RolloutBucket {
  percent: number;
  seed: string;
}

export type UpdaterCheckResult =
  | { available: false }
  | {
      available: true;
      version: string;
      currentVersion: string;
      notes: string;
      pubDate: string | null;
      minRequiredVersion: string | null;
      isForced: boolean;
      rollout: RolloutBucket | null;
      channel: UpdateChannel;
    };

export type UpdaterState =
  | { kind: "idle" }
  | { kind: "checking" }
  | {
      kind: "available";
      version: string;
      currentVersion: string;
      notes: string;
      pubDate: string | null;
      minRequiredVersion: string | null;
      isForced: boolean;
      rollout: RolloutBucket | null;
      channel: UpdateChannel;
    }
  | {
      kind: "downloading";
      version: string;
      progress: number /* 0..1 */;
      downloaded: number;
      total: number | null;
    }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

export const SKIP_VERSION_KEY = "coco.updater.skipVersion";
export const CHECK_ON_LAUNCH_KEY = "coco.updater.checkOnLaunch";
export const LAST_CHECKED_KEY = "coco.updater.lastChecked";
export const CHANNEL_KEY = "coco.updater.channel";
export const INSTALLATION_ID_KEY = "coco.installationId";

// Manifest URL. Kept exported so test code can mock it via module-level
// replacement. Must mirror the `endpoints[0]` value in
// `src-tauri/tauri.conf.json` — runtime JS cannot read that file so we
// hard-code a duplicate here.
export const UPDATE_MANIFEST_URL =
  "https://github.com/abroadcrew02-spec/Coco/releases/latest/download/latest.json";

// ---------------------------------------------------------------------------
// localStorage helpers — sync, defensive (try/catch around every access).
// ---------------------------------------------------------------------------

function safeGet(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    /* swallow — private mode, quota, etc. */
  }
}

function safeRemove(key: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  } catch {
    /* swallow */
  }
}

/** Whether the launcher should check for updates at startup. Default ON. */
export function isAutoCheckEnabled(): boolean {
  return safeGet(CHECK_ON_LAUNCH_KEY) !== "false";
}

export function setAutoCheckEnabled(v: boolean): void {
  safeSet(CHECK_ON_LAUNCH_KEY, v ? "true" : "false");
}

export function getSkippedVersion(): string | null {
  return safeGet(SKIP_VERSION_KEY);
}

export function skipVersion(v: string): void {
  safeSet(SKIP_VERSION_KEY, v);
}

export function clearSkippedVersion(): void {
  safeRemove(SKIP_VERSION_KEY);
}

export function getLastCheckedAt(): string | null {
  return safeGet(LAST_CHECKED_KEY);
}

export function markCheckedNow(): void {
  safeSet(LAST_CHECKED_KEY, new Date().toISOString());
}

/** Current update channel preference. Defaults to "stable". */
export function getChannel(): UpdateChannel {
  return safeGet(CHANNEL_KEY) === "beta" ? "beta" : "stable";
}

export function setChannel(c: UpdateChannel): void {
  safeSet(CHANNEL_KEY, c);
}

/**
 * Stable per-installation identifier (UUID v4). Generated on first call
 * and persisted to localStorage; subsequent calls return the same value.
 *
 * Used to deterministically bucket the device into the staged rollout
 * percent for a given release. NOT a privacy-sensitive ID — it never
 * leaves the device.
 */
export function getInstallationId(): string {
  const existing = safeGet(INSTALLATION_ID_KEY);
  if (existing && existing.length > 0) return existing;
  let id: string;
  try {
    // Prefer crypto.randomUUID when available (every modern browser + Tauri webview).
    id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : fallbackUuid();
  } catch {
    id = fallbackUuid();
  }
  safeSet(INSTALLATION_ID_KEY, id);
  return id;
}

function fallbackUuid(): string {
  // RFC4122-ish v4 fallback for environments without crypto.randomUUID.
  // Not cryptographically strong — only used to seed rollout bucketing.
  const rnd = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return (
    `${rnd()}${rnd()}-${rnd()}-4${rnd().slice(1)}-` +
    `${(Math.floor(Math.random() * 4) + 8).toString(16)}${rnd().slice(1)}-` +
    `${rnd()}${rnd()}${rnd()}`
  );
}

// ---------------------------------------------------------------------------
// Pure helpers — testable, no Tauri / DOM at call time (note:
// isInRolloutBucket reads getInstallationId, which touches localStorage;
// that is acceptable per spec — wrap-in-try/catch covers it).
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash. Deterministic, fast, no dependencies. We use it for
 * rollout bucket assignment — not security-sensitive.
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiplication via shifts to stay in int32 range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Whether this installation falls inside the staged rollout window for
 * the given (percent, seed). Deterministic per (installationId, seed)
 * — the same device + same release pin always returns the same bool.
 *
 * - `null` rollout → always true (no gating)
 * - `percent >= 100` → always true (fully rolled out)
 * - `percent <= 0`  → always false (paused / nobody)
 */
export function isInRolloutBucket(rollout: RolloutBucket | null): boolean {
  if (rollout == null) return true;
  if (rollout.percent >= 100) return true;
  if (rollout.percent <= 0) return false;
  const bucket = fnv1a32(`${getInstallationId()}::${rollout.seed}`) % 100;
  return bucket < rollout.percent;
}

/**
 * Compare two semver strings. Returns -1, 0, 1 for a<b, a==b, a>b.
 * Tolerates pre-release suffixes by stripping everything from `-`
 * onward (so `0.1.0-rc1` compares equal to `0.1.0`).
 */
function compareSemver(a: string, b: string): number {
  const norm = (v: string) =>
    v
      .trim()
      .split("-")[0]
      .split(".")
      .map((p) => {
        const n = parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const pa = norm(a);
  const pb = norm(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * Whether the installed `currentVersion` is below the manifest's
 * `minRequiredVersion` floor. Empty / null floor → never forced.
 */
export function isForcedUpgrade(
  currentVersion: string,
  minRequiredVersion: string | null,
): boolean {
  if (!minRequiredVersion) return false;
  return compareSemver(currentVersion, minRequiredVersion) < 0;
}

// ---------------------------------------------------------------------------
// Tauri-plugin wrappers — lazy-imported so this file is safe to import in
// node-side test runners and to type-check before the plugin is installed.
// ---------------------------------------------------------------------------

// Minimal shapes we need from the plugin so callers don't need to import its
// types. We rely on duck typing rather than `import type` so tsc does not
// require the package to be present at compile time.
interface UpdateHandleLike {
  version: string;
  currentVersion: string;
  body?: string | null;
  date?: string | null;
  downloadAndInstall: (
    onEvent: (event: DownloadEvent) => void,
  ) => Promise<void>;
}

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number | null } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

// Cache the last positive check() so downloadAndInstall() can reuse it
// without a second network round-trip. Cleared when the user dismisses or
// when a fresh check() runs.
let cachedUpdate: UpdateHandleLike | null = null;
// Companion cache for the custom manifest fields (rollout + forced flag)
// so downloadAndInstall() can gate without re-fetching.
let cachedRollout: RolloutBucket | null = null;
let cachedIsForced = false;

interface RawManifest {
  version?: unknown;
  notes?: unknown;
  pub_date?: unknown;
  min_required_version?: unknown;
  rollout?: unknown;
  channel?: unknown;
}

/**
 * Fetch the raw latest.json from the configured endpoint. Used purely to
 * pick up custom fields the plugin's `Update` object does not expose
 * (`min_required_version`, `rollout`, `channel`). Failures are tolerated
 * — callers get nulls.
 */
async function fetchRawManifest(): Promise<RawManifest | null> {
  try {
    const res = await fetch(UPDATE_MANIFEST_URL, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as RawManifest;
  } catch {
    return null;
  }
}

function parseRollout(raw: unknown): RolloutBucket | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as { percent?: unknown; seed?: unknown };
  const percent = typeof obj.percent === "number" ? obj.percent : null;
  const seed = typeof obj.seed === "string" ? obj.seed : null;
  if (percent == null || seed == null) return null;
  return { percent, seed };
}

function parseChannel(raw: unknown): UpdateChannel {
  return raw === "beta" ? "beta" : "stable";
}

/**
 * Probe GitHub Releases (via the configured updater endpoint) for a newer
 * version. On success records `lastChecked`. Caches the resulting Update
 * handle so the subsequent `downloadAndInstall()` call can reuse it.
 *
 * Throws on network failure, malformed manifest, or signature errors — the
 * caller is responsible for surfacing the message to the user.
 */
export async function checkForUpdate(): Promise<UpdaterCheckResult> {
  const mod = await import("@tauri-apps/plugin-updater");
  // The plugin exposes a free function `check()` that returns Update | null.
  const update = (await mod.check()) as unknown as UpdateHandleLike | null;
  markCheckedNow();
  if (!update) {
    cachedUpdate = null;
    cachedRollout = null;
    cachedIsForced = false;
    return { available: false };
  }
  cachedUpdate = update;

  // Plugin doesn't expose our custom fields — re-fetch the manifest for
  // them. CDN is hot from the call the plugin just made, response is
  // ~ 1 KB; tolerant of failure (nulls fall through).
  const raw = await fetchRawManifest();
  const minRequiredVersion =
    raw && typeof raw.min_required_version === "string" && raw.min_required_version.length > 0
      ? raw.min_required_version
      : null;
  const rollout = raw ? parseRollout(raw.rollout) : null;
  const channel = raw ? parseChannel(raw.channel) : "stable";
  const isForced = isForcedUpgrade(update.currentVersion, minRequiredVersion);

  cachedRollout = rollout;
  cachedIsForced = isForced;

  return {
    available: true,
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body ?? "",
    pubDate: update.date ?? null,
    minRequiredVersion,
    isForced,
    rollout,
    channel,
  };
}

/**
 * Download and stage the cached update. If no check() has run in this
 * session (or the cache was invalidated) we re-probe before installing.
 *
 * Progress callback fires repeatedly while bytes stream in; `total` is
 * `null` if the server omitted Content-Length.
 *
 * Staged-rollout gating: if the last check() recorded a non-trivial
 * `rollout` and the installation falls outside its bucket, this throws
 * unless `gateOverride` is true. Manual Settings invocations should
 * pass `true` to ignore the gate; the auto-launch flow leaves it false.
 * Forced upgrades always bypass the gate.
 */
export async function downloadAndInstall(
  onProgress: (state: { downloaded: number; total: number | null }) => void,
  gateOverride = false,
): Promise<void> {
  let update = cachedUpdate;
  if (!update) {
    const mod = await import("@tauri-apps/plugin-updater");
    update = (await mod.check()) as unknown as UpdateHandleLike | null;
    if (!update) {
      throw new Error("No update available to install.");
    }
    cachedUpdate = update;
  }

  // Rollout gate. Forced upgrades and explicit overrides bypass it.
  if (!gateOverride && !cachedIsForced && !isInRolloutBucket(cachedRollout)) {
    throw new Error("This release is still in staged rollout. Try again later.");
  }

  let downloaded = 0;
  let total: number | null = null;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total =
          typeof event.data.contentLength === "number"
            ? event.data.contentLength
            : null;
        onProgress({ downloaded, total });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress({ downloaded, total });
        break;
      case "Finished":
        onProgress({ downloaded, total });
        break;
    }
  });
}

/** Restart the application after a staged install. */
export async function relaunchApp(): Promise<void> {
  const mod = await import("@tauri-apps/plugin-process");
  await mod.relaunch();
}
