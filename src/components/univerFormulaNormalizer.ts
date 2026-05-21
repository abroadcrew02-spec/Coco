// #179 (area C): wire `normalizeFormula` into Univer's cell-edit pipeline.
//
// Univer commits a cell edit through `SheetInterceptorService.onWriteCell`,
// which runs the raw `ICellData` through the `AFTER_CELL_EDIT` interceptor
// chain (synchronously) and then `AFTER_CELL_EDIT_ASYNC`. By registering an
// interceptor at `AFTER_CELL_EDIT` we get the cell value *as it is committed*
// — before it reaches the formula engine — so a user who types a Japanese
// function name (=合計(A1:A10)) has it rewritten to the canonical English
// name (=SUM(A1:A10)) the engine understands.
//
// `BEFORE_CELL_EDIT` is the wrong hook: it fires when an *existing* cell is
// loaded into the editor (edit start), not on commit, so a formula typed and
// confirmed would never be normalized.

import type { IDisposable, Univer } from "@univerjs/core";
import {
  AFTER_CELL_EDIT,
  SheetInterceptorService,
} from "@univerjs/sheets";
import { normalizeFormula } from "../i18n/functionLocale";

/**
 * Register an `AFTER_CELL_EDIT` interceptor that normalizes Japanese
 * function-name aliases in formula input. Returns an IDisposable; the caller
 * disposes it when the Univer instance is torn down.
 *
 * Defensive: if the SheetInterceptorService isn't available (e.g. a stripped
 * plugin set in a test) the function is a no-op and returns a dummy
 * disposable so callers don't have to special-case it.
 */
export function registerFormulaNormalizer(univer: Univer): IDisposable {
  let service: SheetInterceptorService | null = null;
  try {
    service = univer.__getInjector().get(SheetInterceptorService);
  } catch {
    service = null;
  }
  if (!service) {
    return { dispose: () => {} };
  }

  // `InterceptorManager.intercept` returns a plain remover function; wrap it
  // in an IDisposable so the caller's teardown stays uniform.
  const remove = service.writeCellInterceptor.intercept(AFTER_CELL_EDIT, {
    // Run before Univer's own AFTER_CELL_EDIT interceptors so the engine
    // never sees the JA alias. A high priority keeps us first in the
    // composed chain (Univer's built-in pass-through handler is priority -1).
    priority: 100,
    handler: (cell, _context, next) => {
      if (cell && typeof cell.f === "string" && cell.f.length > 0) {
        const normalized = normalizeFormula(cell.f);
        if (normalized !== cell.f) {
          return next({ ...cell, f: normalized });
        }
      }
      return next(cell);
    },
  });
  return { dispose: () => void remove() };
}
