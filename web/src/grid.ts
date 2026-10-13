import {
  CellStyleModule,
  ClientSideRowModelModule,
  colorSchemeDark,
  colorSchemeLight,
  ModuleRegistry,
  NumberFilterModule,
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
  ...(import.meta.env.DEV ? [ValidationModule] : []),
]);

// Brand tokens (styles.css) applied to the grid. Selection and hover use the
// green tint; status colours stay in the cell renderers.
const base = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 13,
  headerFontWeight: 600,
  borderRadius: 6,
  wrapperBorderRadius: 10,
  spacing: 7,
});

const light = base.withPart(colorSchemeLight).withParams({
  accentColor: "#2f7a46",
  backgroundColor: "#ffffff",
  foregroundColor: "#1b211d",
  borderColor: "#dfe4e0",
  headerBackgroundColor: "#f5f7f5",
  headerTextColor: "#4b554e",
  rowHoverColor: "#f0f6f1",
  selectedRowBackgroundColor: "#e3efe6",
  inputFocusBorder: { color: "#2f7a46" },
});

const dark = base.withPart(colorSchemeDark).withParams({
  accentColor: "#6cc287",
  backgroundColor: "#151a17",
  foregroundColor: "#e5ebe6",
  borderColor: "#2a332d",
  headerBackgroundColor: "#1b211d",
  headerTextColor: "#b4beb6",
  rowHoverColor: "#1d2a21",
  selectedRowBackgroundColor: "#203527",
  inputFocusBorder: { color: "#6cc287" },
});

/** AG Grid theme that follows Handrail's light/dark setting. */
export function useGridTheme() {
  return useTheme() === "dark" ? dark : light;
}
