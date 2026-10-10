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
import { useEffect, useState } from "react";

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

const base = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 13,
  headerFontWeight: 600,
  accentColor: "#0f7a64",
  borderRadius: 6,
  wrapperBorderRadius: 10,
  spacing: 7,
  rowHoverColor: "color-mix(in srgb, #0f7a64 7%, transparent)",
});

const light = base.withPart(colorSchemeLight).withParams({ backgroundColor: "#ffffff", headerBackgroundColor: "#f7f8f9" });
const dark = base
  .withPart(colorSchemeDark)
  .withParams({ backgroundColor: "#161a1f", headerBackgroundColor: "#1c2127", accentColor: "#3fbf9f", foregroundColor: "#e6e9ec" });

/** AG Grid theme that follows the system light/dark setting. */
const query = window.matchMedia("(prefers-color-scheme: dark)");

export function useGridTheme() {
  const [isDark, setDark] = useState(query.matches);
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [query]);
  return isDark ? dark : light;
}
