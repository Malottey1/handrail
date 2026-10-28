import {
  CellStyleModule,
  ClientSideRowModelModule,
  colorSchemeDark,
  colorSchemeLight,
  CsvExportModule,
  EventApiModule,
  ModuleRegistry,
  NumberFilterModule,
  PaginationModule,
  RowSelectionModule,
  RowStyleModule,
  TextFilterModule,
  themeQuartz,
  TooltipModule,
  ValidationModule,
} from "ag-grid-community";
import { useTheme } from "./theme";

// Only the features the dashboard uses (AllCommunityModule triples the bundle).
// ValidationModule reports misconfigured grids in development builds only.
ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  TextFilterModule,
  NumberFilterModule,
  TooltipModule,
  RowStyleModule,
  CellStyleModule,
  PaginationModule,
  RowSelectionModule,
  CsvExportModule,
  EventApiModule,
  ...(import.meta.env.DEV ? [ValidationModule] : []),
]);

// Brand tokens (styles.css) applied to the grid. Selection and hover use the
// green tint; status colours stay in the cell renderers.
const base = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 13.5,
  headerFontSize: 13,
  headerFontWeight: 600,
  borderRadius: 6,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  spacing: 7,
  rowHeight: 52,
  headerHeight: 46,
  cellHorizontalPadding: 14,
  checkboxBorderRadius: 4,
});

const light = base.withPart(colorSchemeLight).withParams({
  accentColor: "#127842",
  backgroundColor: "#ffffff",
  foregroundColor: "#1b211d",
  borderColor: "#dfe4e0",
  headerBackgroundColor: "#ffffff",
  headerTextColor: "#4b554e",
  rowHoverColor: "#eef6f1",
  selectedRowBackgroundColor: "#e0efe5",
  inputFocusBorder: { color: "#127842" },
});

const dark = base.withPart(colorSchemeDark).withParams({
  accentColor: "#64c48a",
  backgroundColor: "#151a17",
  foregroundColor: "#e5ebe6",
  borderColor: "#2a332d",
  headerBackgroundColor: "#151a17",
  headerTextColor: "#b4beb6",
  rowHoverColor: "#1a2b20",
  selectedRowBackgroundColor: "#1e3627",
  inputFocusBorder: { color: "#64c48a" },
});

/** AG Grid theme that follows Handrail's light/dark setting. */
export function useGridTheme() {
  return useTheme() === "dark" ? dark : light;
}
