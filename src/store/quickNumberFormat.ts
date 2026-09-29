// Format codes for the quick-format toolbar buttons (通貨 / %). The buttons
// apply them to the current selection through the numfmt facade, using the
// shared planner in numberFormat.ts (planUniformNumberFormat), which also
// carries the whole-column / whole-row cell cap (#98).

/** Format codes for the two preset buttons. Match Excel's defaults. */
export const QUICK_FMT_CURRENCY = "$#,##0.00";
export const QUICK_FMT_PERCENT = "0%";
