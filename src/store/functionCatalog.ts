// Catalog of Excel-compatible spreadsheet functions surfaced by the
// "Insert Function" dialog (Shift+F3 in Excel). This is plain data so that
// it can be filtered, searched, and rendered without pulling in Univer or
// any DOM concerns — keeps the picker testable and lets us reuse the same
// entries in the autocomplete dropdown later.
//
// Coverage targets Excel's ~100 most-used functions across the standard
// category buckets. Signatures use Excel notation (square brackets for
// optional arguments) so users who already know Excel can grok them at a
// glance. Descriptions are Japanese-leaning because the primary audience
// is JP knowledge workers, with English fallbacks where the JP equivalent
// would be awkwardly long.
//
// The catalog is intentionally `readonly` — components must not mutate it
// at runtime. Add new entries by editing this file; sort within a category
// is arbitrary but kept loosely grouped by topic (aggregates first, then
// rounding, then misc) so scanning by eye is easier.

export type FunctionCategory =
  | "math"
  | "stat"
  | "lookup"
  | "logical"
  | "text"
  | "date"
  | "info"
  | "financial"
  | "engineering";

export interface FunctionInfo {
  /** Excel function name in upper-case, no parens. e.g. "SUM". */
  name: string;
  /** Category bucket — drives the dropdown filter. */
  category: FunctionCategory;
  /** Excel-notation signature, e.g. "SUM(number1, [number2], ...)". */
  signature: string;
  /** Short one-line description shown beneath the signature. */
  description: string;
  /** Concrete example invocation, e.g. "=SUM(A1:A10)". */
  example: string;
}

// Labels for the category dropdown. Exposed so the dialog can render the
// options without hard-coding strings in two places.
export const FUNCTION_CATEGORY_LABELS: Record<FunctionCategory, string> = {
  math: "数学/三角",
  stat: "統計",
  lookup: "検索/行列",
  logical: "論理",
  text: "文字列操作",
  date: "日付/時刻",
  info: "情報",
  financial: "財務",
  engineering: "エンジニアリング",
};

export const FUNCTION_CATEGORY_ORDER: readonly FunctionCategory[] = [
  "math",
  "stat",
  "lookup",
  "logical",
  "text",
  "date",
  "info",
  "financial",
  "engineering",
] as const;

export const FUNCTION_CATALOG: readonly FunctionInfo[] = [
  // ---------- Math & Trig ----------
  { name: "SUM", category: "math", signature: "SUM(number1, [number2], ...)", description: "引数の合計を返します。", example: "=SUM(A1:A10)" },
  { name: "SUMIF", category: "math", signature: "SUMIF(range, criteria, [sum_range])", description: "条件に一致するセルの合計を返します。", example: "=SUMIF(A1:A10, \">0\")" },
  { name: "SUMIFS", category: "math", signature: "SUMIFS(sum_range, criteria_range1, criteria1, ...)", description: "複数条件に一致するセルの合計を返します。", example: "=SUMIFS(C:C, A:A, \"東京\", B:B, \">100\")" },
  { name: "PRODUCT", category: "math", signature: "PRODUCT(number1, [number2], ...)", description: "引数の積を返します。", example: "=PRODUCT(A1:A5)" },
  { name: "ROUND", category: "math", signature: "ROUND(number, num_digits)", description: "指定した桁数で四捨五入します。", example: "=ROUND(3.14159, 2)" },
  { name: "ROUNDUP", category: "math", signature: "ROUNDUP(number, num_digits)", description: "数値を切り上げます。", example: "=ROUNDUP(3.14, 1)" },
  { name: "ROUNDDOWN", category: "math", signature: "ROUNDDOWN(number, num_digits)", description: "数値を切り下げます。", example: "=ROUNDDOWN(3.18, 1)" },
  { name: "INT", category: "math", signature: "INT(number)", description: "整数部分を返します(切り下げ)。", example: "=INT(3.9)" },
  { name: "MOD", category: "math", signature: "MOD(number, divisor)", description: "剰余(余り)を返します。", example: "=MOD(10, 3)" },
  { name: "POWER", category: "math", signature: "POWER(number, power)", description: "べき乗を返します。", example: "=POWER(2, 10)" },
  { name: "SQRT", category: "math", signature: "SQRT(number)", description: "平方根を返します。", example: "=SQRT(16)" },
  { name: "ABS", category: "math", signature: "ABS(number)", description: "絶対値を返します。", example: "=ABS(-5)" },
  { name: "RAND", category: "math", signature: "RAND()", description: "0 以上 1 未満の乱数を返します。", example: "=RAND()" },
  { name: "RANDBETWEEN", category: "math", signature: "RANDBETWEEN(bottom, top)", description: "指定範囲の整数の乱数を返します。", example: "=RANDBETWEEN(1, 100)" },
  { name: "CEILING", category: "math", signature: "CEILING(number, significance)", description: "基準値の倍数に切り上げます。", example: "=CEILING(2.5, 1)" },
  { name: "FLOOR", category: "math", signature: "FLOOR(number, significance)", description: "基準値の倍数に切り下げます。", example: "=FLOOR(2.5, 1)" },
  { name: "EXP", category: "math", signature: "EXP(number)", description: "e (自然対数の底) のべき乗を返します。", example: "=EXP(1)" },
  { name: "LN", category: "math", signature: "LN(number)", description: "自然対数を返します。", example: "=LN(2.71828)" },
  { name: "LOG", category: "math", signature: "LOG(number, [base])", description: "指定底の対数を返します(既定は 10)。", example: "=LOG(100, 10)" },

  // ---------- Statistical ----------
  { name: "AVERAGE", category: "stat", signature: "AVERAGE(number1, [number2], ...)", description: "算術平均を返します。", example: "=AVERAGE(A1:A10)" },
  { name: "AVERAGEIF", category: "stat", signature: "AVERAGEIF(range, criteria, [average_range])", description: "条件に一致するセルの平均を返します。", example: "=AVERAGEIF(A1:A10, \">0\")" },
  { name: "AVERAGEIFS", category: "stat", signature: "AVERAGEIFS(average_range, criteria_range1, criteria1, ...)", description: "複数条件に一致するセルの平均を返します。", example: "=AVERAGEIFS(C:C, A:A, \"東京\", B:B, \">100\")" },
  { name: "COUNT", category: "stat", signature: "COUNT(value1, [value2], ...)", description: "数値が含まれるセルの個数を返します。", example: "=COUNT(A1:A10)" },
  { name: "COUNTA", category: "stat", signature: "COUNTA(value1, [value2], ...)", description: "空白でないセルの個数を返します。", example: "=COUNTA(A1:A10)" },
  { name: "COUNTIF", category: "stat", signature: "COUNTIF(range, criteria)", description: "条件に一致するセルの個数を返します。", example: "=COUNTIF(A1:A10, \">0\")" },
  { name: "COUNTIFS", category: "stat", signature: "COUNTIFS(criteria_range1, criteria1, ...)", description: "複数条件に一致するセルの個数を返します。", example: "=COUNTIFS(A:A, \"東京\", B:B, \">100\")" },
  { name: "COUNTBLANK", category: "stat", signature: "COUNTBLANK(range)", description: "空白セルの個数を返します。", example: "=COUNTBLANK(A1:A10)" },
  { name: "MAX", category: "stat", signature: "MAX(number1, [number2], ...)", description: "最大値を返します。", example: "=MAX(A1:A10)" },
  { name: "MIN", category: "stat", signature: "MIN(number1, [number2], ...)", description: "最小値を返します。", example: "=MIN(A1:A10)" },
  { name: "MAXIFS", category: "stat", signature: "MAXIFS(max_range, criteria_range1, criteria1, ...)", description: "条件に一致するセルの最大値を返します。", example: "=MAXIFS(C:C, A:A, \"東京\")" },
  { name: "MINIFS", category: "stat", signature: "MINIFS(min_range, criteria_range1, criteria1, ...)", description: "条件に一致するセルの最小値を返します。", example: "=MINIFS(C:C, A:A, \"東京\")" },
  { name: "MEDIAN", category: "stat", signature: "MEDIAN(number1, [number2], ...)", description: "中央値を返します。", example: "=MEDIAN(A1:A10)" },
  { name: "MODE", category: "stat", signature: "MODE(number1, [number2], ...)", description: "最頻値を返します。", example: "=MODE(A1:A10)" },
  { name: "STDEV", category: "stat", signature: "STDEV(number1, [number2], ...)", description: "標本標準偏差を返します。", example: "=STDEV(A1:A10)" },
  { name: "STDEVP", category: "stat", signature: "STDEVP(number1, [number2], ...)", description: "母標準偏差を返します。", example: "=STDEVP(A1:A10)" },
  { name: "VAR", category: "stat", signature: "VAR(number1, [number2], ...)", description: "標本分散を返します。", example: "=VAR(A1:A10)" },
  { name: "RANK", category: "stat", signature: "RANK(number, ref, [order])", description: "順位を返します。", example: "=RANK(B2, B$2:B$10, 0)" },
  { name: "PERCENTILE", category: "stat", signature: "PERCENTILE(array, k)", description: "指定パーセンタイル値を返します。", example: "=PERCENTILE(A1:A10, 0.9)" },
  { name: "QUARTILE", category: "stat", signature: "QUARTILE(array, quart)", description: "四分位数を返します。", example: "=QUARTILE(A1:A10, 1)" },

  // ---------- Lookup & Reference ----------
  { name: "VLOOKUP", category: "lookup", signature: "VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])", description: "テーブルから縦方向に値を検索します。", example: "=VLOOKUP(\"A001\", A:C, 3, FALSE)" },
  { name: "HLOOKUP", category: "lookup", signature: "HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])", description: "テーブルから横方向に値を検索します。", example: "=HLOOKUP(\"4月\", 1:5, 3, FALSE)" },
  { name: "INDEX", category: "lookup", signature: "INDEX(array, row_num, [column_num])", description: "配列から行/列番号で値を取得します。", example: "=INDEX(A1:C10, 5, 2)" },
  { name: "MATCH", category: "lookup", signature: "MATCH(lookup_value, lookup_array, [match_type])", description: "値の位置(行/列番号)を返します。", example: "=MATCH(\"東京\", A1:A10, 0)" },
  { name: "XLOOKUP", category: "lookup", signature: "XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])", description: "新しい検索関数。完全/近似/逆順に対応。", example: "=XLOOKUP(\"A001\", A:A, C:C)" },
  { name: "INDIRECT", category: "lookup", signature: "INDIRECT(ref_text, [a1])", description: "文字列で表されたセル参照を返します。", example: "=INDIRECT(\"A\" & B1)" },
  { name: "OFFSET", category: "lookup", signature: "OFFSET(reference, rows, cols, [height], [width])", description: "基準セルからオフセットした範囲を返します。", example: "=OFFSET(A1, 2, 3)" },
  { name: "CHOOSE", category: "lookup", signature: "CHOOSE(index_num, value1, [value2], ...)", description: "インデックスに応じて値を選択します。", example: "=CHOOSE(2, \"A\", \"B\", \"C\")" },
  { name: "ROW", category: "lookup", signature: "ROW([reference])", description: "セル参照の行番号を返します。", example: "=ROW(A5)" },
  { name: "COLUMN", category: "lookup", signature: "COLUMN([reference])", description: "セル参照の列番号を返します。", example: "=COLUMN(C1)" },
  { name: "ROWS", category: "lookup", signature: "ROWS(array)", description: "配列/範囲の行数を返します。", example: "=ROWS(A1:A10)" },
  { name: "COLUMNS", category: "lookup", signature: "COLUMNS(array)", description: "配列/範囲の列数を返します。", example: "=COLUMNS(A1:E1)" },

  // ---------- Logical ----------
  { name: "IF", category: "logical", signature: "IF(logical_test, [value_if_true], [value_if_false])", description: "条件に応じて値を返します。", example: "=IF(A1>0, \"正\", \"負\")" },
  { name: "IFS", category: "logical", signature: "IFS(test1, value1, [test2, value2], ...)", description: "複数条件を順番に評価します。", example: "=IFS(A1>=90,\"A\",A1>=70,\"B\",TRUE,\"C\")" },
  { name: "AND", category: "logical", signature: "AND(logical1, [logical2], ...)", description: "すべての引数が TRUE のとき TRUE を返します。", example: "=AND(A1>0, A1<100)" },
  { name: "OR", category: "logical", signature: "OR(logical1, [logical2], ...)", description: "いずれかが TRUE のとき TRUE を返します。", example: "=OR(A1=\"Y\", A1=\"N\")" },
  { name: "NOT", category: "logical", signature: "NOT(logical)", description: "論理値を反転します。", example: "=NOT(A1>0)" },
  { name: "XOR", category: "logical", signature: "XOR(logical1, [logical2], ...)", description: "排他的論理和を返します。", example: "=XOR(A1>0, B1>0)" },
  { name: "IFERROR", category: "logical", signature: "IFERROR(value, value_if_error)", description: "エラー時に代替値を返します。", example: "=IFERROR(A1/B1, 0)" },
  { name: "IFNA", category: "logical", signature: "IFNA(value, value_if_na)", description: "#N/A エラー時に代替値を返します。", example: "=IFNA(VLOOKUP(...), \"未登録\")" },
  { name: "SWITCH", category: "logical", signature: "SWITCH(expression, value1, result1, [value2, result2], ..., [default])", description: "式の値で分岐します。", example: "=SWITCH(A1, 1, \"月\", 2, \"火\")" },
  { name: "TRUE", category: "logical", signature: "TRUE()", description: "論理値 TRUE を返します。", example: "=TRUE()" },
  { name: "FALSE", category: "logical", signature: "FALSE()", description: "論理値 FALSE を返します。", example: "=FALSE()" },

  // ---------- Text ----------
  { name: "CONCAT", category: "text", signature: "CONCAT(text1, [text2], ...)", description: "文字列を連結します(範囲対応)。", example: "=CONCAT(A1:A5)" },
  { name: "CONCATENATE", category: "text", signature: "CONCATENATE(text1, [text2], ...)", description: "文字列を連結します(レガシー)。", example: "=CONCATENATE(A1, \"-\", B1)" },
  { name: "TEXT", category: "text", signature: "TEXT(value, format_text)", description: "数値を書式付きの文字列に変換します。", example: "=TEXT(A1, \"yyyy/mm/dd\")" },
  { name: "LEN", category: "text", signature: "LEN(text)", description: "文字列の文字数を返します。", example: "=LEN(A1)" },
  { name: "LEFT", category: "text", signature: "LEFT(text, [num_chars])", description: "左端から指定文字数を返します。", example: "=LEFT(A1, 3)" },
  { name: "RIGHT", category: "text", signature: "RIGHT(text, [num_chars])", description: "右端から指定文字数を返します。", example: "=RIGHT(A1, 3)" },
  { name: "MID", category: "text", signature: "MID(text, start_num, num_chars)", description: "中央の指定位置から文字を返します。", example: "=MID(A1, 2, 3)" },
  { name: "FIND", category: "text", signature: "FIND(find_text, within_text, [start_num])", description: "部分文字列の位置を返します(大文字小文字を区別)。", example: "=FIND(\"@\", A1)" },
  { name: "SEARCH", category: "text", signature: "SEARCH(find_text, within_text, [start_num])", description: "部分文字列の位置を返します(大文字小文字を区別しない)。", example: "=SEARCH(\"a\", A1)" },
  { name: "REPLACE", category: "text", signature: "REPLACE(old_text, start_num, num_chars, new_text)", description: "指定位置の文字列を置換します。", example: "=REPLACE(A1, 1, 3, \"XYZ\")" },
  { name: "SUBSTITUTE", category: "text", signature: "SUBSTITUTE(text, old_text, new_text, [instance_num])", description: "対象文字列をすべて置換します。", example: "=SUBSTITUTE(A1, \"-\", \"/\")" },
  { name: "UPPER", category: "text", signature: "UPPER(text)", description: "大文字に変換します。", example: "=UPPER(\"abc\")" },
  { name: "LOWER", category: "text", signature: "LOWER(text)", description: "小文字に変換します。", example: "=LOWER(\"ABC\")" },
  { name: "PROPER", category: "text", signature: "PROPER(text)", description: "各単語の先頭のみ大文字に変換します。", example: "=PROPER(\"hello world\")" },
  { name: "TRIM", category: "text", signature: "TRIM(text)", description: "余分な空白を削除します。", example: "=TRIM(A1)" },
  { name: "EXACT", category: "text", signature: "EXACT(text1, text2)", description: "2 つの文字列が等しいか比較します(大文字小文字区別)。", example: "=EXACT(A1, B1)" },
  { name: "REPT", category: "text", signature: "REPT(text, number_times)", description: "文字列を指定回数繰り返します。", example: "=REPT(\"*\", 5)" },
  { name: "NUMBERVALUE", category: "text", signature: "NUMBERVALUE(text, [decimal_separator], [group_separator])", description: "ロケール非依存で文字列を数値に変換します。", example: "=NUMBERVALUE(\"1,234.5\")" },
  { name: "VALUE", category: "text", signature: "VALUE(text)", description: "文字列を数値に変換します。", example: "=VALUE(\"123\")" },
  { name: "DOLLAR", category: "text", signature: "DOLLAR(number, [decimals])", description: "通貨書式の文字列に変換します。", example: "=DOLLAR(1234.5, 2)" },
  { name: "FIXED", category: "text", signature: "FIXED(number, [decimals], [no_commas])", description: "数値を桁区切り書式の文字列にします。", example: "=FIXED(1234.5, 1)" },
  { name: "T", category: "text", signature: "T(value)", description: "値が文字列ならその文字列を、それ以外なら空文字を返します。", example: "=T(A1)" },
  { name: "CHAR", category: "text", signature: "CHAR(number)", description: "文字コードから文字を返します。", example: "=CHAR(65)" },
  { name: "CODE", category: "text", signature: "CODE(text)", description: "先頭文字の文字コードを返します。", example: "=CODE(\"A\")" },
  { name: "UNICHAR", category: "text", signature: "UNICHAR(number)", description: "Unicode コードポイントから文字を返します。", example: "=UNICHAR(9731)" },
  { name: "UNICODE", category: "text", signature: "UNICODE(text)", description: "先頭文字の Unicode コードポイントを返します。", example: "=UNICODE(\"☃\")" },

  // ---------- Date & Time ----------
  { name: "NOW", category: "date", signature: "NOW()", description: "現在の日付と時刻を返します。", example: "=NOW()" },
  { name: "TODAY", category: "date", signature: "TODAY()", description: "今日の日付を返します。", example: "=TODAY()" },
  { name: "DATE", category: "date", signature: "DATE(year, month, day)", description: "年月日から日付値を返します。", example: "=DATE(2026, 5, 18)" },
  { name: "TIME", category: "date", signature: "TIME(hour, minute, second)", description: "時分秒から時刻値を返します。", example: "=TIME(13, 30, 0)" },
  { name: "YEAR", category: "date", signature: "YEAR(serial_number)", description: "日付の年を返します。", example: "=YEAR(A1)" },
  { name: "MONTH", category: "date", signature: "MONTH(serial_number)", description: "日付の月を返します。", example: "=MONTH(A1)" },
  { name: "DAY", category: "date", signature: "DAY(serial_number)", description: "日付の日を返します。", example: "=DAY(A1)" },
  { name: "HOUR", category: "date", signature: "HOUR(serial_number)", description: "時刻の時 (0-23) を返します。", example: "=HOUR(A1)" },
  { name: "MINUTE", category: "date", signature: "MINUTE(serial_number)", description: "時刻の分を返します。", example: "=MINUTE(A1)" },
  { name: "SECOND", category: "date", signature: "SECOND(serial_number)", description: "時刻の秒を返します。", example: "=SECOND(A1)" },
  { name: "WEEKDAY", category: "date", signature: "WEEKDAY(serial_number, [return_type])", description: "日付の曜日番号を返します。", example: "=WEEKDAY(TODAY(), 2)" },
  { name: "WEEKNUM", category: "date", signature: "WEEKNUM(serial_number, [return_type])", description: "日付の週番号を返します。", example: "=WEEKNUM(TODAY())" },
  { name: "DATEDIF", category: "date", signature: "DATEDIF(start_date, end_date, unit)", description: "2 つの日付の差を指定単位で返します。", example: "=DATEDIF(A1, B1, \"Y\")" },
  { name: "DATEVALUE", category: "date", signature: "DATEVALUE(date_text)", description: "日付文字列を日付値に変換します。", example: "=DATEVALUE(\"2026/05/18\")" },
  { name: "EOMONTH", category: "date", signature: "EOMONTH(start_date, months)", description: "指定月数後の月末日を返します。", example: "=EOMONTH(TODAY(), 1)" },
  { name: "EDATE", category: "date", signature: "EDATE(start_date, months)", description: "指定月数後の同日を返します。", example: "=EDATE(TODAY(), 3)" },
  { name: "NETWORKDAYS", category: "date", signature: "NETWORKDAYS(start_date, end_date, [holidays])", description: "稼働日数(土日除く)を返します。", example: "=NETWORKDAYS(A1, B1)" },
  { name: "WORKDAY", category: "date", signature: "WORKDAY(start_date, days, [holidays])", description: "稼働日数後の日付を返します。", example: "=WORKDAY(TODAY(), 10)" },

  // ---------- Information ----------
  { name: "ISBLANK", category: "info", signature: "ISBLANK(value)", description: "セルが空白なら TRUE を返します。", example: "=ISBLANK(A1)" },
  { name: "ISNUMBER", category: "info", signature: "ISNUMBER(value)", description: "値が数値なら TRUE を返します。", example: "=ISNUMBER(A1)" },
  { name: "ISTEXT", category: "info", signature: "ISTEXT(value)", description: "値が文字列なら TRUE を返します。", example: "=ISTEXT(A1)" },
  { name: "ISERROR", category: "info", signature: "ISERROR(value)", description: "値がエラーなら TRUE を返します。", example: "=ISERROR(A1)" },
  { name: "ISNA", category: "info", signature: "ISNA(value)", description: "値が #N/A なら TRUE を返します。", example: "=ISNA(A1)" },
  { name: "ISERR", category: "info", signature: "ISERR(value)", description: "#N/A 以外のエラーなら TRUE を返します。", example: "=ISERR(A1)" },
  { name: "ISLOGICAL", category: "info", signature: "ISLOGICAL(value)", description: "値が論理値なら TRUE を返します。", example: "=ISLOGICAL(A1)" },
  { name: "ISFORMULA", category: "info", signature: "ISFORMULA(reference)", description: "セルに数式があれば TRUE を返します。", example: "=ISFORMULA(A1)" },
  { name: "ISREF", category: "info", signature: "ISREF(value)", description: "値がセル参照なら TRUE を返します。", example: "=ISREF(A1)" },
  { name: "CELL", category: "info", signature: "CELL(info_type, [reference])", description: "セルの書式/位置/内容に関する情報を返します。", example: "=CELL(\"address\", A1)" },
  { name: "INFO", category: "info", signature: "INFO(type_text)", description: "システム情報を返します。", example: "=INFO(\"osversion\")" },
  { name: "N", category: "info", signature: "N(value)", description: "値を数値に変換します。", example: "=N(A1)" },
  { name: "NA", category: "info", signature: "NA()", description: "#N/A エラー値を返します。", example: "=NA()" },
  { name: "TYPE", category: "info", signature: "TYPE(value)", description: "値のデータ型を表す数値を返します。", example: "=TYPE(A1)" },

  // ---------- Financial ----------
  { name: "PMT", category: "financial", signature: "PMT(rate, nper, pv, [fv], [type])", description: "定期支払額(元利合計)を返します。", example: "=PMT(0.05/12, 60, -100000)" },
  { name: "FV", category: "financial", signature: "FV(rate, nper, pmt, [pv], [type])", description: "将来価値を返します。", example: "=FV(0.05/12, 60, -1000)" },
  { name: "PV", category: "financial", signature: "PV(rate, nper, pmt, [fv], [type])", description: "現在価値を返します。", example: "=PV(0.05/12, 60, -1000)" },
  { name: "NPV", category: "financial", signature: "NPV(rate, value1, [value2], ...)", description: "正味現在価値を返します。", example: "=NPV(0.1, -100, 30, 40, 50)" },
  { name: "IRR", category: "financial", signature: "IRR(values, [guess])", description: "内部収益率を返します。", example: "=IRR(A1:A6)" },
  { name: "RATE", category: "financial", signature: "RATE(nper, pmt, pv, [fv], [type], [guess])", description: "投資期間の利率を返します。", example: "=RATE(60, -1000, 50000)" },
  { name: "NPER", category: "financial", signature: "NPER(rate, pmt, pv, [fv], [type])", description: "投資の期間(支払回数)を返します。", example: "=NPER(0.05/12, -1000, 50000)" },
  { name: "IPMT", category: "financial", signature: "IPMT(rate, per, nper, pv, [fv], [type])", description: "指定期の利息支払額を返します。", example: "=IPMT(0.05/12, 1, 60, -100000)" },
  { name: "PPMT", category: "financial", signature: "PPMT(rate, per, nper, pv, [fv], [type])", description: "指定期の元金支払額を返します。", example: "=PPMT(0.05/12, 1, 60, -100000)" },

  // ---------- Engineering ----------
  { name: "BIN2DEC", category: "engineering", signature: "BIN2DEC(number)", description: "2 進数を 10 進数に変換します。", example: "=BIN2DEC(1010)" },
  { name: "DEC2BIN", category: "engineering", signature: "DEC2BIN(number, [places])", description: "10 進数を 2 進数に変換します。", example: "=DEC2BIN(10)" },
  { name: "BIN2HEX", category: "engineering", signature: "BIN2HEX(number, [places])", description: "2 進数を 16 進数に変換します。", example: "=BIN2HEX(1111)" },
  { name: "HEX2BIN", category: "engineering", signature: "HEX2BIN(number, [places])", description: "16 進数を 2 進数に変換します。", example: "=HEX2BIN(\"F\")" },
  { name: "DEC2HEX", category: "engineering", signature: "DEC2HEX(number, [places])", description: "10 進数を 16 進数に変換します。", example: "=DEC2HEX(255)" },
  { name: "HEX2DEC", category: "engineering", signature: "HEX2DEC(number)", description: "16 進数を 10 進数に変換します。", example: "=HEX2DEC(\"FF\")" },
] as const;

/**
 * Case-insensitive filter over `name + signature + description`. Returns
 * the original list when `query` is blank so the caller doesn't have to
 * special-case the empty-input path.
 *
 * Keeping this separate from the component makes it trivial to unit test
 * (same convention as `validateMutation` in dataValidation.ts).
 */
export function filterFunctions(
  catalog: readonly FunctionInfo[],
  category: FunctionCategory | "all",
  query: string,
): FunctionInfo[] {
  const q = query.trim().toLowerCase();
  return catalog.filter((fn) => {
    if (category !== "all" && fn.category !== category) return false;
    if (!q) return true;
    const haystack = `${fn.name} ${fn.signature} ${fn.description}`.toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Build the text the dialog will write into the active cell. The MVP just
 * emits `=NAME(` so the user can type arguments inline — this matches
 * Excel's Shift+F3 "Insert" behavior when invoked without filling out the
 * argument-helper form.
 */
export function buildInsertTemplate(fn: FunctionInfo): string {
  return `=${fn.name}(`;
}
