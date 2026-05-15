import { describe, expect, it } from "vitest";
import SheetsUIEnUS from "@univerjs/sheets-ui/locale/en-US";
import { buildCocoUniverLocale } from "./cocoUniverLocale";

interface UniverLocale {
  rightClick: Record<string, string>;
  toolbar: Record<string, unknown>;
  formula: Record<string, unknown>;
}

describe("buildCocoUniverLocale", () => {
  it("overrides right-click labels for ja-JP", () => {
    const locale = buildCocoUniverLocale("ja-JP") as unknown as UniverLocale;

    expect(locale.rightClick.copy).toBe("コピー");
    expect(locale.rightClick.paste).toBe("貼り付け");
    expect(locale.rightClick.cut).toBe("切り取り");
    expect(locale.rightClick.insert).toBe("挿入");
    expect(locale.rightClick.delete).toBe("削除");
    expect(locale.rightClick.hide).toBe("非表示");
    expect(locale.rightClick.clearSelection).toBe("クリア");
    expect(locale.rightClick.clearContent).toBe("内容をクリア");
    expect(locale.rightClick.clearFormat).toBe("書式をクリア");
    expect(locale.rightClick.clearAll).toBe("すべてクリア");
    expect(locale.rightClick.sortSelection).toBe("並べ替え");
    expect(locale.rightClick.filterSelection).toBe("フィルター");
    expect(locale.rightClick.rowHeight).toBe("行の高さ");
    expect(locale.rightClick.columnWidth).toBe("列の幅");
    expect(locale.rightClick.freeze).toBe("固定");
    expect(locale.rightClick.cancelFreeze).toBe("固定を解除");
    expect(locale.rightClick.pasteSpecial).toBe("形式を選択して貼り付け");
    expect(locale.rightClick.insertRowBefore).toBe("上に行を挿入");
    expect(locale.rightClick.deleteSelectedColumn).toBe("選択した列を削除");
    expect(locale.rightClick.freezeCol).toBe("この列まで固定");
    expect(locale.rightClick.protectRange).toBe("行と列を保護");
  });

  it("keeps en-US labels and merged locale sections for en-US", () => {
    const locale = buildCocoUniverLocale("en-US") as unknown as UniverLocale;

    expect(locale.rightClick.copy).toBe(SheetsUIEnUS.rightClick.copy);
    expect(locale.rightClick.paste).toBe(SheetsUIEnUS.rightClick.paste);
    expect(locale.rightClick.freeze).toBe(SheetsUIEnUS.rightClick.freeze);
    expect(locale.toolbar).toBeDefined();
    expect(locale.formula).toBeDefined();
  });

  it("does not mutate the source en-US locale objects", () => {
    const originalCopy = SheetsUIEnUS.rightClick.copy;
    const originalRightClick = SheetsUIEnUS.rightClick;
    const jaLocale = buildCocoUniverLocale("ja-JP") as unknown as UniverLocale;
    const enLocale = buildCocoUniverLocale("en-US") as unknown as UniverLocale;

    expect(SheetsUIEnUS.rightClick.copy).toBe(originalCopy);
    expect(jaLocale.rightClick).not.toBe(originalRightClick);
    expect(enLocale.rightClick).not.toBe(originalRightClick);

    jaLocale.rightClick.copy = "変更";
    enLocale.rightClick.copy = "Changed";

    expect(SheetsUIEnUS.rightClick.copy).toBe(originalCopy);
  });
});
