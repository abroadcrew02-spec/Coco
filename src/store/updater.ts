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
//   localStorage["coco.updater.installationId"] = uuid v4 | absent
//     - Stable per-installation random identifier used to bucket the
//       staged rollout deterministically. Generated lazily on first
//       read; never reset by us. Legacy key was `coco.installationId`
//       (unnamespaced) — migrated once at module load.
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
export const INSTALLATION_ID_KEY = "coco.updater.installationId";
// Legacy key — migrated to INSTALLATION_ID_KEY once at module load below.
const LEGACY_INSTALLATION_ID_KEY = "coco.installationId";

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
 * One-time migration: copy the legacy `coco.installationId` value to the
 * new namespaced `coco.updater.installationId` key and delete the old
 * key. Safe to call repeatedly — a no-op once the new key exists.
 *
 * Module-load invocation below ensures every importing surface (renderer
 * boot, dialog, settings page) sees the migrated key without needing an
 * explicit call.
 */
function migrateInstallationIdKey(): void {
  const newKey = safeGet(INSTALLATION_ID_KEY);
  if (newKey && newKey.length > 0) return;
  const legacy = safeGet(LEGACY_INSTALLATION_ID_KEY);
  if (legacy && legacy.length > 0) {
    safeSet(INSTALLATION_ID_KEY, legacy);
    safeRemove(LEGACY_INSTALLATION_ID_KEY);
  }
}

// Run the migration once at module load. Wrapped in try/catch because
// localStorage access can throw in sandboxed contexts even with our
// safe* helpers (e.g. if typeof localStorage check passes but the
// getter itself throws on access).
try {
  migrateInstallationIdKey();
} catch {
  /* swallow — migration is best-effort; getInstallationId() still works. */
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
 * - non-finite percent (NaN, Infinity) → true (fail open: better to
 *   ship an update than silently block every device on a malformed
 *   manifest field)
 * - `percent >= 100` → always true (fully rolled out)
 * - `percent <= 0`  → always false (paused / nobody)
 */
export function isInRolloutBucket(rollout: RolloutBucket | null): boolean {
  if (rollout == null) return true;
  if (!Number.isFinite(rollout.percent)) return true; // fail open
  if (rollout.percent >= 100) return true;
  if (rollout.percent <= 0) return false;
  const bucket = fnv1a32(`${getInstallationId()}::${rollout.seed}`) % 100;
  return bucket < rollout.percent;
}

/**
 * Sentinel returned by compareSemver when either input contains a
 * non-integer numeric component (e.g. "abc", "1.x.0"). Callers that
 * care (isForcedUpgrade) should treat this as "cannot compare" rather
 * than coerce to an ordering.
 */
const SEMVER_INVALID = Number.NaN;

const INT_RE = /^\d+$/;

/**
 * Split a SemVer string into [coreNumbers, prereleaseIdentifiers].
 * Returns null if any core component is not a clean integer.
 * Prerelease identifiers are dot-separated strings; numeric-looking
 * ones are returned as numbers, the rest as strings (per SemVer 2.0.0).
 */
function parseSemver(
  v: string,
): { core: number[]; pre: Array<number | string> } | null {
  const trimmed = v.trim();
  // Strip build metadata (+...) — irrelevant to precedence per spec.
  const noBuild = trimmed.split("+")[0];
  const dashIdx = noBuild.indexOf("-");
  const corePart = dashIdx === -1 ? noBuild : noBuild.slice(0, dashIdx);
  const prePart = dashIdx === -1 ? "" : noBuild.slice(dashIdx + 1);

  const coreTokens = corePart.split(".");
  const core: number[] = [];
  for (const tok of coreTokens) {
    if (!INT_RE.test(tok)) return null;
    core.push(parseInt(tok, 10));
  }

  const pre: Array<number | string> =
    prePart.length === 0
      ? []
      : prePart.split(".").map((id) => (INT_RE.test(id) ? parseInt(id, 10) : id));
  return { core, pre };
}

/**
 * Compare two SemVer 2.0.0 version strings. Returns -1, 0, 1 for a<b,
 * a==b, a>b. Returns NaN (SEMVER_INVALID) if either input has a
 * non-integer numeric component — callers must check via
 * `Number.isNaN`.
 *
 * Pre-release precedence rules (SemVer 2.0.0 §11):
 *   - A version with a pre-release tag is LESS than the same X.Y.Z
 *     without one (e.g. 0.1.0-rc1 < 0.1.0).
 *   - When both have pre-release tags, dot-separated identifiers are
 *     compared left-to-right: numeric < non-numeric; numerics
 *     compared numerically; non-numerics lexicographically; a shorter
 *     set with equal prefix is lower precedence.
 *
 * Inline test cases (verified by reading; no test file per spec):
 *   compareSemver("0.1.0", "0.1.0")             === 0
 *   compareSemver("0.1.0-rc1", "0.1.0")         === -1
 *   compareSemver("0.1.0", "0.1.0-rc1")         === 1
 *   compareSemver("0.1.0-rc1", "0.1.0-rc2")     === -1
 *   compareSemver("0.1.10", "0.1.9")            === 1
 *   compareSemver("0.10.0", "0.9.0")            === 1
 *   Number.isNaN(compareSemver("abc", "0.1.0")) === true
 *   Number.isNaN(compareSemver("0.1.0", "x.y")) === true
 */
function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) return SEMVER_INVALID;

  // 1) Compare core (major.minor.patch...) numerically.
  const coreLen = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < coreLen; i++) {
    const av = pa.core[i] ?? 0;
    const bv = pb.core[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }

  // 2) Core equal — apply pre-release precedence.
  const aHasPre = pa.pre.length > 0;
  const bHasPre = pb.pre.length > 0;
  if (!aHasPre && !bHasPre) return 0;
  if (!aHasPre && bHasPre) return 1; // A is the released X.Y.Z; B is a pre
  if (aHasPre && !bHasPre) return -1; // A is a pre; B is released X.Y.Z

  // 3) Both have pre-release: compare identifier-by-identifier.
  const preLen = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < preLen; i++) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    const aIsNum = typeof ai === "number";
    const bIsNum = typeof bi === "number";
    if (aIsNum && bIsNum) {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    } else if (aIsNum && !bIsNum) {
      return -1; // numeric < non-numeric
    } else if (!aIsNum && bIsNum) {
      return 1;
    } else {
      // both strings — lexicographic
      const as = ai as string;
      const bs = bi as string;
      if (as < bs) return -1;
      if (as > bs) return 1;
    }
  }
  // Longer prerelease list with otherwise-equal prefix is higher precedence.
  if (pa.pre.length < pb.pre.length) return -1;
  if (pa.pre.length > pb.pre.length) return 1;
  return 0;
}

/**
 * Whether the installed `currentVersion` is below the manifest's
 * `minRequiredVersion` floor. Empty / null floor → never forced.
 *
 * If either string is malformed (compareSemver returns NaN) we
 * fail-open — return false and warn rather than lock the user out
 * because of a corrupt local version string.
 */
export function isForcedUpgrade(
  currentVersion: string,
  minRequiredVersion: string | null,
): boolean {
  if (!minRequiredVersion) return false;
  const cmp = compareSemver(currentVersion, minRequiredVersion);
  if (Number.isNaN(cmp)) {
    console.warn(
      `[updater] isForcedUpgrade: unparseable version(s); skipping force gate. ` +
        `current=${JSON.stringify(currentVersion)} min=${JSON.stringify(minRequiredVersion)}`,
    );
    return false;
  }
  return cmp < 0;
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

// Plugin versions differ slightly on the field names for the total
// content length and per-chunk size, so we accept several shapes
// defensively (see downloadAndInstall progress handling).
type DownloadEvent =
  | {
      event: "Started";
      data: {
        contentLength?: number | null;
        total?: number | null;
      };
    }
  | {
      event: "Progress";
      data: {
        chunkLength?: number | null;
        chunk_length?: number | null;
      };
    }
  | { event: "Finished" };

// Cache the last positive check() so downloadAndInstall() can reuse it
// without a second network round-trip. Cleared when the user dismisses or
// when a fresh check() runs.
let cachedUpdate: UpdateHandleLike | null = null;
// Companion cache for the custom manifest fields (rollout + forced flag)
// so downloadAndInstall() can gate without re-fetching.
let cachedRollout: RolloutBucket | null = null;
let cachedIsForced = false;

/**
 * Clear all module-level cached update state. Called:
 *   - at the start of every `checkForUpdate()` (fresh slate per check)
 *   - inside the `downloadAndInstall()` catch block (don't strand
 *     gating state after a failed download)
 *   - implicitly when `check()` returns null (no update) — handled
 *     inside `checkForUpdate()` by the leading clear
 *
 * Exposed so callers (e.g. a manual "cancel" button) can reset state
 * without triggering a network call.
 */
export function clearUpdateCache(): void {
  cachedUpdate = null;
  cachedRollout = null;
  cachedIsForced = false;
}

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
  // Every check starts with a clean slate so a previous run's stale
  // cache cannot influence gating after a cancellation / error.
  clearUpdateCache();
  const mod = await import("@tauri-apps/plugin-updater");
  // The plugin exposes a free function `check()` that returns Update | null.
  const update = (await mod.check()) as unknown as UpdateHandleLike | null;
  markCheckedNow();
  if (!update) {
    // Cache was already cleared above; this branch confirms the
    // "no update returned" path leaves all three fields null/false.
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
  try {
    let update = cachedUpdate;
    let installedVersion: string | null = null;
    if (!update) {
      const mod = await import("@tauri-apps/plugin-updater");
      update = (await mod.check()) as unknown as UpdateHandleLike | null;
      if (!update) {
        throw new Error("No update available to install.");
      }
      cachedUpdate = update;
    }
    installedVersion = update.version;

    // Rollout gate. Forced upgrades and explicit overrides bypass it.
    if (!gateOverride && !cachedIsForced && !isInRolloutBucket(cachedRollout)) {
      throw new Error("This release is still in staged rollout. Try again later.");
    }

    let downloaded = 0;
    let total: number | null = null;

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started": {
          // Different plugin versions emit `contentLength` or `total`.
          // When neither is a finite number, treat as indeterminate
          // (total stays null and the UI can render an indeterminate
          // progress bar).
          const raw =
            typeof event.data.contentLength === "number"
              ? event.data.contentLength
              : typeof event.data.total === "number"
                ? event.data.total
                : null;
          total = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
          onProgress({ downloaded, total });
          break;
        }
        case "Progress": {
          // Accept both camelCase and snake_case naming. If neither is
          // a finite number, skip the event entirely rather than add
          // `undefined`/NaN to `downloaded` (which would corrupt the
          // accumulator and break the UI bar).
          const chunk =
            typeof event.data.chunkLength === "number"
              ? event.data.chunkLength
              : typeof event.data.chunk_length === "number"
                ? event.data.chunk_length
                : null;
          if (chunk == null || !Number.isFinite(chunk)) {
            // No usable chunk size — drop the event silently.
            break;
          }
          downloaded += chunk;
          onProgress({ downloaded, total });
          break;
        }
        case "Finished":
          onProgress({ downloaded, total });
          break;
      }
    });

    // Install completed successfully. If the user previously skipped
    // *this exact version* (e.g. clicked "Skip" then later accepted
    // via Help → Check for Updates), clear the stale skip record so
    // post-install state inspection doesn't show contradictory data.
    // We only clear on an exact match to avoid wiping a deliberate
    // skip of some other release.
    if (installedVersion && getSkippedVersion() === installedVersion) {
      clearSkippedVersion();
    }
  } catch (err) {
    // Any failure leaves potentially-stale gating state in the cache
    // (e.g. cachedIsForced from a check that succeeded earlier this
    // session). A subsequent manual retry should re-probe from
    // scratch, so wipe the cache before rethrowing.
    clearUpdateCache();
    throw err;
  }
}

/** Restart the application after a staged install. */
export async function relaunchApp(): Promise<void> {
  const mod = await import("@tauri-apps/plugin-process");
  await mod.relaunch();
}
