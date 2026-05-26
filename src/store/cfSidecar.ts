// #241 CF live re-paint — sidecar map foundation.
//
// PR #211 reverted in v0.4.4 because facade writes (`setBackground`,
// `setValue`) pollute the canonical snapshot. The next `computeCfRepaint`
// then sees the polluted snapshot as its BASE and either (a) bakes glyphs
// into iconSet cells permanently or (b) thinks CF was already cleared and
// no-ops the actual removal.
//
// Root cause: there is no separation between "user-authored cell state" and
// "CF-painted cell state". The snapshot conflates both.
//
// Fix design (from docs/designs/241-cf-live-render.md):
//
//   The sidecar map remembers, per (sheetId, row, col):
//     - baseStyle: the cell's style BEFORE any CF ever touched it
//     - cfStyle:   the style CF last painted on top of base
//     - ruleIds:   which rules contributed to the current cfStyle
//
//   When CF wants to re-paint cell (s,r,c):
//     1. Look up sidecar entry for (s,r,c).
//     2. If absent — record current snapshot.cellData[s].s as baseStyle.
//     3. Compute the new cfStyle from current rules.
//     4. Write (baseStyle ∪ cfStyle) to the facade.
//     5. Persist sidecar entry.
//
//   When CF wants to REMOVE itself from a cell:
//     1. Look up sidecar entry.
//     2. Write baseStyle to the facade (no cfStyle merge).
//     3. Drop the sidecar entry.
//
//   When a rule is deleted:
//     `clearRule(ruleId)` returns every cell that had that rule contributing
//     and the UI calls "remove" on each.
//
//   The sidecar lives in memory (NOT serialized into the workbook snapshot)
//   because cfStyle is derivable from rules + base on every reload. Storing
//   only baseStyle makes reload cheap and avoids polluting xlsx round-trip.

export type CellKey = `${string}:${number}:${number}`;

/** Build a stable key from a triple. Exported so tests + integration share it. */
export function makeCellKey(sheetId: string, row: number, col: number): CellKey {
  return `${sheetId}:${row}:${col}` as CellKey;
}

/**
 * Style payload tracked per cell. Mirrors the subset of Univer's cell-style
 * shape that CF rules actually touch — bg / cl / bl / number-format / iconSet
 * glyph value. Other keys (font, border, alignment) are not in the CF
 * surface and should not appear here.
 */
export interface CellStyleSlice {
  /** Background color (#RRGGBB). */
  bg?: string;
  /** Font color (#RRGGBB). */
  cl?: string;
  /** Bold flag. */
  bl?: 0 | 1;
  /** Italic flag. */
  it?: 0 | 1;
  /** Underline flag. */
  ul?: 0 | 1;
  /**
   * For iconSet rules: the rendered cell value (the formatted "↑ 42" string).
   * Stored separately so we can roll back to base.v without re-parsing.
   */
  iconValue?: string;
}

export interface CfSidecarEntry {
  /** Cell style BEFORE any CF touched it. Restored on rule removal. */
  baseStyle: CellStyleSlice;
  /** Style currently overlaid by CF. Last-write-wins per key. */
  cfStyle: CellStyleSlice;
  /**
   * Rule ids whose evaluation contributed to the current cfStyle. When the
   * last rule clears, the entry can be dropped entirely.
   */
  ruleIds: Set<string>;
}

/**
 * In-memory sidecar map. Lives for the duration of an editor session — the
 * map is rebuilt on workbook open by re-evaluating CF rules against the
 * snapshot's user-authored styles.
 *
 * Side-effect free: every public method returns a new value or mutates the
 * internal `Map` only; callers can inspect via getters before deciding
 * whether to commit downstream.
 */
export class CfSidecar {
  private entries = new Map<CellKey, CfSidecarEntry>();

  /** True iff the (sheet,row,col) cell currently has a sidecar entry. */
  has(sheetId: string, row: number, col: number): boolean {
    return this.entries.has(makeCellKey(sheetId, row, col));
  }

  /**
   * Read the entry for a cell. Returns null when nothing CF has touched
   * the cell yet.
   */
  get(sheetId: string, row: number, col: number): CfSidecarEntry | null {
    return this.entries.get(makeCellKey(sheetId, row, col)) ?? null;
  }

  /** Number of tracked cells. Useful for diagnostics + size warnings. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Snapshot the user-authored style of a cell BEFORE any CF touches it.
   * Idempotent — calling this on a cell that already has a sidecar entry
   * does NOT overwrite the recorded baseStyle (that's the whole point —
   * once we have a clean BASE we never let CF pollute it).
   */
  recordBase(sheetId: string, row: number, col: number, baseStyle: CellStyleSlice): void {
    const key = makeCellKey(sheetId, row, col);
    const existing = this.entries.get(key);
    if (existing) return; // base already recorded; leave it alone
    this.entries.set(key, {
      baseStyle: { ...baseStyle },
      cfStyle: {},
      ruleIds: new Set(),
    });
  }

  /**
   * Track a CF write to a cell. If the cell has never been touched by CF
   * before, the caller must pass the user-authored baseStyle (we record it
   * on first contact). Subsequent calls only update cfStyle + ruleIds.
   *
   * The cfStyle parameter is the FULL new cfStyle (not a delta); merging
   * across overlapping rules is the caller's responsibility because rule
   * priority varies per implementation.
   */
  trackWrite(
    sheetId: string,
    row: number,
    col: number,
    baseStyle: CellStyleSlice,
    cfStyle: CellStyleSlice,
    ruleId: string,
  ): void {
    const key = makeCellKey(sheetId, row, col);
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, {
        baseStyle: { ...baseStyle },
        cfStyle: { ...cfStyle },
        ruleIds: new Set([ruleId]),
      });
      return;
    }
    // Existing entry — preserve baseStyle (NEVER overwrite once recorded),
    // replace cfStyle, add the contributing rule id.
    existing.cfStyle = { ...cfStyle };
    existing.ruleIds.add(ruleId);
  }

  /**
   * The opposite of `trackWrite`: a single rule's contribution is removed
   * from the cell. When the last contributing rule leaves, the entry is
   * dropped entirely (cell returns to baseStyle territory; no further CF
   * tracking until something paints again).
   *
   * Returns:
   *   - the entry's baseStyle when the rule was contributing (caller writes
   *     baseStyle back to the facade to roll back)
   *   - null when the rule wasn't contributing or the cell isn't tracked
   */
  untrackRule(
    sheetId: string,
    row: number,
    col: number,
    ruleId: string,
  ): CellStyleSlice | null {
    const key = makeCellKey(sheetId, row, col);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (!entry.ruleIds.has(ruleId)) return null;
    entry.ruleIds.delete(ruleId);
    if (entry.ruleIds.size === 0) {
      // Last rule gone — drop the entry so the next CF touch starts fresh.
      const base = entry.baseStyle;
      this.entries.delete(key);
      return { ...base };
    }
    // Other rules still contributing — keep entry, return base for the
    // caller to compose the new cfStyle without the gone rule.
    return { ...entry.baseStyle };
  }

  /**
   * Return the baseStyle for a cell — what the cell looked like before any
   * CF touched it. When the cell isn't tracked, returns null (callers
   * should fall back to the live snapshot's style).
   */
  getBaseStyle(sheetId: string, row: number, col: number): CellStyleSlice | null {
    const entry = this.entries.get(makeCellKey(sheetId, row, col));
    if (!entry) return null;
    return { ...entry.baseStyle };
  }

  /**
   * Drop EVERY cell touched by a given rule, returning the (sheetId, row,
   * col, baseStyle) tuples so the caller can issue the rollback writes.
   * When the rule was the only contributor for a cell, the cell's entry
   * is removed; otherwise the rule is simply removed from `ruleIds`.
   */
  clearRule(
    ruleId: string,
  ): Array<{ sheetId: string; row: number; col: number; baseStyle: CellStyleSlice }> {
    const out: Array<{ sheetId: string; row: number; col: number; baseStyle: CellStyleSlice }> = [];
    for (const [key, entry] of this.entries) {
      if (!entry.ruleIds.has(ruleId)) continue;
      const [sheetId, rowStr, colStr] = key.split(":");
      const row = Number.parseInt(rowStr, 10);
      const col = Number.parseInt(colStr, 10);
      entry.ruleIds.delete(ruleId);
      if (entry.ruleIds.size === 0) {
        out.push({ sheetId, row, col, baseStyle: { ...entry.baseStyle } });
        this.entries.delete(key);
      } else {
        // Cell still has other CF rules painting on it; the caller will
        // re-compute the cfStyle from the remaining rules. We pass back
        // baseStyle so the caller can compose `base ∪ remaining-cf`.
        out.push({ sheetId, row, col, baseStyle: { ...entry.baseStyle } });
      }
    }
    return out;
  }

  /**
   * Drop EVERY tracked cell. Used when the workbook resets (file close,
   * Coco-undo rollback past the rule-creation point, etc.).
   */
  clearAll(): void {
    this.entries.clear();
  }

  /**
   * Walk every tracked cell — useful when the UI needs to redraw all CF
   * overlays after a re-mount (e.g. dark-mode toggle).
   */
  *cells(): IterableIterator<{
    sheetId: string;
    row: number;
    col: number;
    entry: CfSidecarEntry;
  }> {
    for (const [key, entry] of this.entries) {
      const [sheetId, rowStr, colStr] = key.split(":");
      yield {
        sheetId,
        row: Number.parseInt(rowStr, 10),
        col: Number.parseInt(colStr, 10),
        entry,
      };
    }
  }
}

/**
 * Compose a style slice from (base, cf) — keys present in cf override the
 * matching key in base; absent keys fall through to base. Mirrors the
 * "merge layer" semantic the facade write needs.
 */
export function composeStyle(
  base: CellStyleSlice,
  cf: CellStyleSlice,
): CellStyleSlice {
  return {
    ...base,
    ...(cf.bg !== undefined ? { bg: cf.bg } : {}),
    ...(cf.cl !== undefined ? { cl: cf.cl } : {}),
    ...(cf.bl !== undefined ? { bl: cf.bl } : {}),
    ...(cf.it !== undefined ? { it: cf.it } : {}),
    ...(cf.ul !== undefined ? { ul: cf.ul } : {}),
    ...(cf.iconValue !== undefined ? { iconValue: cf.iconValue } : {}),
  };
}
