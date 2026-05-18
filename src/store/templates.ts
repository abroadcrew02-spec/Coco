// Built-in workbook templates surfaced through the "Templates Gallery" entry
// on the File menu (`file-templates`). Each template is a pre-populated
// snapshot fragment using the same shape `workbook_new` returns
// (see commands/workbook.rs::workbook_new), so the editor can load it via
// the same updateSnapshot path used for any other mutation.
//
// Snapshot shape (Univer 0.5.x + Coco extensions):
//   {
//     id: string,                    // workbook uuid (filled in at load time)
//     name: "Untitled",
//     appVersion: string,            // filled in at load time
//     locale: "enUS",
//     styles: {},                    // inline `s` on each cell is sufficient
//     sheetOrder: string[],
//     sheets: {
//       [sheetId]: {
//         id: string,
//         name: string,              // tab name
//         rowCount: number,          // pre-allocated grid size
//         columnCount: number,
//         cellData: {
//           [row]: { [col]: { v?: unknown, f?: string, s?: object, _fmt?: string } }
//         },
//         _tables?: Array<...>,      // see store/tables.ts
//         _conditionalFormatting?: Array<CfRuleEntry>,  // see components/conditionalFormatRender.ts
//         _charts?: Array<ChartEntry>,                  // see store/chartRender.ts
//       }
//     }
//   }
//
// Kept side-effect free + framework-free so any caller (HomeScreen tile,
// File-menu dialog, future CLI seed) can produce a snapshot string without
// touching Univer or the Tauri backend. The "blank" template returns null so
// callers can fall through to the normal `newWorkbook()` codepath, which
// asks the backend for a fresh uuid + version stamp.

export interface TemplateInfo {
  id: string;
  nameJa: string;
  nameEn: string;
  descriptionJa: string;
  descriptionEn: string;
  thumbnailEmoji: string;
}

export const TEMPLATE_CATALOG: readonly TemplateInfo[] = [
  {
    id: "blank",
    nameJa: "空白のワークブック",
    nameEn: "Blank Workbook",
    descriptionJa: "何も入っていない新しいワークブック",
    descriptionEn: "A fresh, empty workbook to start from scratch.",
    thumbnailEmoji: "📄",
  },
  {
    id: "monthly-budget",
    nameJa: "月次予算",
    nameEn: "Monthly Budget",
    descriptionJa: "カテゴリ別の収入・支出と合計行付き",
    descriptionEn: "Categories with income / expense columns and a SUM total.",
    thumbnailEmoji: "💰",
  },
  {
    id: "todo-list",
    nameJa: "ToDo リスト",
    nameEn: "To-Do List",
    descriptionJa: "タスク / 優先度 / 期限 / ステータス",
    descriptionEn: "Task, priority, due date, and status columns.",
    thumbnailEmoji: "✅",
  },
  {
    id: "sales-dashboard",
    nameJa: "売上ダッシュボード",
    nameEn: "Sales Dashboard",
    descriptionJa: "地域 × 月の売上サンプルと棒グラフ",
    descriptionEn: "Sample sales by region × month with a built-in bar chart.",
    thumbnailEmoji: "📊",
  },
  {
    id: "project-gantt",
    nameJa: "プロジェクト ガント",
    nameEn: "Project Gantt",
    descriptionJa: "タスク + 開始/終了日 + 条件付き書式",
    descriptionEn: "Task list with start / end dates and a CF highlight.",
    thumbnailEmoji: "📅",
  },
  {
    id: "expense-report",
    nameJa: "経費精算",
    nameEn: "Expense Report",
    descriptionJa: "カテゴリ別の金額と合計",
    descriptionEn: "Expense categories with amounts and a SUM total.",
    thumbnailEmoji: "🧾",
  },
  {
    id: "inventory",
    nameJa: "在庫管理",
    nameEn: "Inventory",
    descriptionJa: "商品 / 在庫数 / 発注点 + 在庫不足の強調",
    descriptionEn: "Item, quantity, reorder level with low-stock highlight.",
    thumbnailEmoji: "📦",
  },
  {
    id: "contacts",
    nameJa: "連絡先",
    nameEn: "Contacts",
    descriptionJa: "名前 / メール / 電話 / 会社",
    descriptionEn: "Name, email, phone, and company table.",
    thumbnailEmoji: "📇",
  },
] as const;

// ── Snapshot helpers ─────────────────────────────────────────────────────────

type Cell = { v?: unknown; f?: string; s?: Record<string, unknown>; _fmt?: string };
type CellData = Record<string, Record<string, Cell>>;

interface Sheet {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  cellData: CellData;
  _tables?: unknown[];
  _conditionalFormatting?: unknown[];
  _charts?: unknown[];
}

interface SnapshotJson {
  id: string;
  name: string;
  appVersion: string;
  locale: string;
  styles: Record<string, unknown>;
  sheetOrder: string[];
  sheets: Record<string, Sheet>;
}

const HEADER_STYLE: Record<string, unknown> = {
  bg: { rgb: "#217346" },
  cl: { rgb: "#FFFFFF" },
  bl: 1,
  ht: 2, // horizontal center
};

const TOTAL_STYLE: Record<string, unknown> = {
  bg: { rgb: "#E7F4EC" },
  bl: 1,
  bd: { t: { s: 1, cl: { rgb: "#217346" } } },
};

const setRow = (
  cellData: CellData,
  row: number,
  values: ReadonlyArray<Cell | string | number | null>,
): void => {
  const r: Record<string, Cell> = cellData[String(row)] ?? {};
  values.forEach((cell, col) => {
    if (cell === null) return;
    if (typeof cell === "object") {
      r[String(col)] = cell;
    } else {
      r[String(col)] = { v: cell };
    }
  });
  cellData[String(row)] = r;
};

const styledHeader = (label: string): Cell => ({ v: label, s: HEADER_STYLE });

const newSheet = (
  id: string,
  name: string,
  rowCount = 1000,
  columnCount = 26,
): Sheet => ({
  id,
  name,
  rowCount,
  columnCount,
  cellData: {},
});

const baseSnapshot = (sheet: Sheet): SnapshotJson => ({
  // `id` and `appVersion` are placeholder values; the load path replaces the
  // workbook id with whatever the backend stamps in `workbook_new`, and the
  // version banner reads from the running app, not the snapshot.
  id: "template",
  name: "Untitled",
  appVersion: "template",
  locale: "enUS",
  styles: {},
  sheetOrder: [sheet.id],
  sheets: { [sheet.id]: sheet },
});

// ── Individual templates ─────────────────────────────────────────────────────

function buildMonthlyBudget(): SnapshotJson {
  const sheet = newSheet("sheet-1", "月次予算");
  const cd = sheet.cellData;
  setRow(cd, 0, [
    styledHeader("カテゴリ"),
    styledHeader("予算"),
    styledHeader("実績"),
    styledHeader("差額"),
  ]);
  const categories = [
    ["家賃", 80000, 80000],
    ["食費", 40000, 38500],
    ["光熱費", 15000, 14200],
    ["通信費", 8000, 7800],
    ["交通費", 12000, 9500],
    ["娯楽", 10000, 12300],
  ];
  categories.forEach((row, i) => {
    const r = i + 1;
    setRow(cd, r, [
      row[0] as string,
      row[1] as number,
      row[2] as number,
      { f: `=B${r + 1}-C${r + 1}` },
    ]);
  });
  const totalRow = categories.length + 1;
  setRow(cd, totalRow, [
    { v: "合計", s: TOTAL_STYLE },
    { f: `=SUM(B2:B${totalRow})`, s: TOTAL_STYLE },
    { f: `=SUM(C2:C${totalRow})`, s: TOTAL_STYLE },
    { f: `=SUM(D2:D${totalRow})`, s: TOTAL_STYLE },
  ]);
  return baseSnapshot(sheet);
}

function buildTodoList(): SnapshotJson {
  const sheet = newSheet("sheet-1", "ToDo");
  const cd = sheet.cellData;
  setRow(cd, 0, [
    styledHeader("タスク"),
    styledHeader("優先度"),
    styledHeader("期限"),
    styledHeader("ステータス"),
  ]);
  const rows: Array<[string, string, string, string]> = [
    ["要件レビュー", "高", "2026-05-20", "未着手"],
    ["設計ドキュメント作成", "中", "2026-05-25", "進行中"],
    ["UI モックアップ", "中", "2026-05-22", "完了"],
    ["バックエンド API 実装", "高", "2026-06-01", "未着手"],
    ["テスト計画", "低", "2026-06-05", "未着手"],
  ];
  rows.forEach((r, i) => setRow(cd, i + 1, r as unknown as Cell[]));
  return baseSnapshot(sheet);
}

function buildSalesDashboard(): SnapshotJson {
  const sheet = newSheet("sheet-1", "売上");
  const cd = sheet.cellData;
  setRow(cd, 0, [
    styledHeader("地域"),
    styledHeader("1月"),
    styledHeader("2月"),
    styledHeader("3月"),
    styledHeader("合計"),
  ]);
  const regions: Array<[string, number, number, number]> = [
    ["北海道", 1200000, 1350000, 1410000],
    ["東北", 980000, 1020000, 1100000],
    ["関東", 3200000, 3450000, 3680000],
    ["中部", 1450000, 1520000, 1600000],
    ["関西", 2100000, 2250000, 2380000],
    ["九州", 1180000, 1240000, 1310000],
  ];
  regions.forEach((row, i) => {
    const r = i + 1;
    setRow(cd, r, [
      row[0],
      row[1],
      row[2],
      row[3],
      { f: `=SUM(B${r + 1}:D${r + 1})` },
    ]);
  });
  sheet._charts = [
    {
      range: `A1:D${regions.length + 1}`,
      type: "bar",
      title: "地域別 売上 (1-3月)",
      hasHeaderRow: true,
      hasHeaderCol: true,
      showLegend: true,
    },
  ];
  return baseSnapshot(sheet);
}

function buildProjectGantt(): SnapshotJson {
  const sheet = newSheet("sheet-1", "ガント");
  const cd = sheet.cellData;
  setRow(cd, 0, [
    styledHeader("タスク"),
    styledHeader("担当"),
    styledHeader("開始日"),
    styledHeader("終了日"),
    styledHeader("進捗 (%)"),
  ]);
  const tasks: Array<[string, string, string, string, number]> = [
    ["要件定義", "Alice", "2026-05-01", "2026-05-10", 100],
    ["設計", "Bob", "2026-05-11", "2026-05-20", 80],
    ["実装", "Carol", "2026-05-21", "2026-06-10", 40],
    ["テスト", "Dave", "2026-06-11", "2026-06-20", 0],
    ["リリース", "Erin", "2026-06-21", "2026-06-25", 0],
  ];
  tasks.forEach((row, i) => setRow(cd, i + 1, row as unknown as Cell[]));
  // Highlight rows that are 100% complete.
  sheet._conditionalFormatting = [
    {
      sqref: `A2:E${tasks.length + 1}`,
      type: "expression",
      formula1: `=$E2=100`,
      style: { bgColor: "#E7F4EC", fontColor: "#217346", bold: true },
      priority: 1,
    },
  ];
  return baseSnapshot(sheet);
}

function buildExpenseReport(): SnapshotJson {
  const sheet = newSheet("sheet-1", "経費");
  const cd = sheet.cellData;
  setRow(cd, 0, [
    styledHeader("日付"),
    styledHeader("カテゴリ"),
    styledHeader("内容"),
    styledHeader("金額"),
  ]);
  const rows: Array<[string, string, string, number]> = [
    ["2026-05-01", "交通費", "客先訪問 (新宿)", 820],
    ["2026-05-02", "会議費", "ランチミーティング", 3400],
    ["2026-05-05", "通信費", "モバイル Wi-Fi", 4980],
    ["2026-05-08", "備品", "USB ハブ", 2980],
    ["2026-05-12", "交通費", "出張 (大阪)", 28500],
  ];
  rows.forEach((row, i) => setRow(cd, i + 1, row as unknown as Cell[]));
  const totalRow = rows.length + 1;
  setRow(cd, totalRow, [
    { v: "", s: TOTAL_STYLE },
    { v: "", s: TOTAL_STYLE },
    { v: "合計", s: TOTAL_STYLE },
    { f: `=SUM(D2:D${totalRow})`, s: TOTAL_STYLE },
  ]);
  return baseSnapshot(sheet);
}

function buildInventory(): SnapshotJson {
  const sheet = newSheet("sheet-1", "在庫");
  const cd = sheet.cellData;
  setRow(cd, 0, [
    styledHeader("商品コード"),
    styledHeader("商品名"),
    styledHeader("在庫数"),
    styledHeader("発注点"),
    styledHeader("仕入先"),
  ]);
  const items: Array<[string, string, number, number, string]> = [
    ["SKU-001", "USB ケーブル (1m)", 35, 20, "AcmeCo"],
    ["SKU-002", "HDMI ケーブル (2m)", 8, 15, "AcmeCo"],
    ["SKU-003", "ワイヤレスマウス", 22, 10, "GadgetWorks"],
    ["SKU-004", "メカニカルキーボード", 5, 8, "GadgetWorks"],
    ["SKU-005", "27\" モニター", 12, 5, "DisplayPro"],
  ];
  items.forEach((row, i) => setRow(cd, i + 1, row as unknown as Cell[]));
  // Highlight rows where qty < reorder level.
  sheet._conditionalFormatting = [
    {
      sqref: `A2:E${items.length + 1}`,
      type: "expression",
      formula1: `=$C2<$D2`,
      style: { bgColor: "#FDECEA", fontColor: "#B71C1C", bold: true },
      priority: 1,
    },
  ];
  return baseSnapshot(sheet);
}

function buildContacts(): SnapshotJson {
  const sheet = newSheet("sheet-1", "連絡先");
  const cd = sheet.cellData;
  setRow(cd, 0, [
    styledHeader("名前"),
    styledHeader("メール"),
    styledHeader("電話"),
    styledHeader("会社"),
  ]);
  const rows: Array<[string, string, string, string]> = [
    ["山田 太郎", "yamada@example.com", "03-1234-5678", "サンプル株式会社"],
    ["佐藤 花子", "sato@example.com", "03-2345-6789", "テスト商事"],
    ["鈴木 一郎", "suzuki@example.com", "06-3456-7890", "Acme Co."],
    ["田中 美咲", "tanaka@example.com", "045-456-7890", "GadgetWorks"],
  ];
  rows.forEach((row, i) => setRow(cd, i + 1, row as unknown as Cell[]));
  return baseSnapshot(sheet);
}

/**
 * Build a snapshot JSON string for the given template id. Returns `null` for
 * the blank template (caller should fall through to the default newWorkbook
 * codepath) and for any unknown id.
 */
export function buildTemplateSnapshot(id: string): string | null {
  switch (id) {
    case "blank":
      return null;
    case "monthly-budget":
      return JSON.stringify(buildMonthlyBudget());
    case "todo-list":
      return JSON.stringify(buildTodoList());
    case "sales-dashboard":
      return JSON.stringify(buildSalesDashboard());
    case "project-gantt":
      return JSON.stringify(buildProjectGantt());
    case "expense-report":
      return JSON.stringify(buildExpenseReport());
    case "inventory":
      return JSON.stringify(buildInventory());
    case "contacts":
      return JSON.stringify(buildContacts());
    default:
      return null;
  }
}

/** True when the catalog declares this template id. */
export function isKnownTemplate(id: string): boolean {
  return TEMPLATE_CATALOG.some((t) => t.id === id);
}
