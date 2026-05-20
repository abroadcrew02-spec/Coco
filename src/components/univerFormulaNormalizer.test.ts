// #179 (area C): wiring-level regression test for registerFormulaNormalizer.
//
// The CRITICAL bug this guards against: the normalizer was wired to
// `BEFORE_CELL_EDIT` (edit-start hook) instead of `AFTER_CELL_EDIT` (the
// commit hook `SheetInterceptorService.onWriteCell` actually runs). A pure
// unit test of `normalizeFormula` could not catch that mis-wiring, so this
// test stubs `writeCellInterceptor` and asserts both the registration key
// and that the registered handler normalizes a committed `ICellData`.

import { describe, it, expect, vi } from "vitest";
import { AFTER_CELL_EDIT, BEFORE_CELL_EDIT } from "@univerjs/sheets";
import { registerFormulaNormalizer } from "./univerFormulaNormalizer";

type Handler = (cell: unknown, ctx: unknown, next: (c: unknown) => unknown) => unknown;

/**
 * Build a fake Univer whose injector hands back a stub SheetInterceptorService.
 * `intercept` records the (key, interceptor) pair so the test can inspect it.
 */
function makeFakeUniver() {
  const calls: { key: unknown; interceptor: { priority?: number; handler: Handler } }[] =
    [];
  const remove = vi.fn();
  const service = {
    writeCellInterceptor: {
      intercept: (key: unknown, interceptor: { priority?: number; handler: Handler }) => {
        calls.push({ key, interceptor });
        return remove;
      },
    },
  };
  const univer = {
    __getInjector: () => ({
      get: (token: unknown) => {
        // registerFormulaNormalizer asks for SheetInterceptorService.
        void token;
        return service;
      },
    }),
  };
  return { univer, calls, remove };
}

describe("registerFormulaNormalizer wiring", () => {
  it("registers on AFTER_CELL_EDIT (the commit hook), not BEFORE_CELL_EDIT", () => {
    const { univer, calls } = makeFakeUniver();
    registerFormulaNormalizer(univer as never);

    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe(AFTER_CELL_EDIT);
    expect(calls[0].key).not.toBe(BEFORE_CELL_EDIT);
  });

  it("normalizes a JA formula in the committed ICellData and passes it to next", () => {
    const { univer, calls } = makeFakeUniver();
    registerFormulaNormalizer(univer as never);

    const handler = calls[0].interceptor.handler;
    const next = vi.fn((c: unknown) => c);
    const cell = { f: "=合計(A1)" };

    const result = handler(cell, {}, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith({ f: "=SUM(A1)" });
    expect(result).toEqual({ f: "=SUM(A1)" });
  });

  it("passes the cell through untouched when there is no JA alias to rewrite", () => {
    const { univer, calls } = makeFakeUniver();
    registerFormulaNormalizer(univer as never);

    const handler = calls[0].interceptor.handler;
    const next = vi.fn((c: unknown) => c);
    const cell = { f: "=SUM(A1)" };

    handler(cell, {}, next);

    // Same object reference — no needless clone when nothing changed.
    expect(next).toHaveBeenCalledWith(cell);
  });

  it("passes non-formula cells (plain value) straight through", () => {
    const { univer, calls } = makeFakeUniver();
    registerFormulaNormalizer(univer as never);

    const handler = calls[0].interceptor.handler;
    const next = vi.fn((c: unknown) => c);
    const cell = { v: "合計" };

    handler(cell, {}, next);

    expect(next).toHaveBeenCalledWith(cell);
  });

  it("disposes via the remover returned by intercept", () => {
    const { univer, remove } = makeFakeUniver();
    const disposable = registerFormulaNormalizer(univer as never);

    disposable.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when SheetInterceptorService is unavailable", () => {
    const univer = {
      __getInjector: () => ({
        get: () => {
          throw new Error("service not registered");
        },
      }),
    };
    // Should not throw, and the returned disposable must be safe to dispose.
    const disposable = registerFormulaNormalizer(univer as never);
    expect(() => disposable.dispose()).not.toThrow();
  });
});
