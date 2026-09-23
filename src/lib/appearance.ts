export type ThemeMode = "light" | "dark";

export type ThemeTokenKey =
  | "background"
  | "foreground"
  | "primary"
  | "primaryForeground"
  | "muted"
  | "mutedForeground"
  | "border"
  | "panel"
  | "signal";

export type ThemeTokenValues = Record<ThemeTokenKey, string>;

export interface AppearanceSettings {
  fontScale: number;
  fontFamily: string;
  themeOverrides: Partial<Record<ThemeMode, Partial<ThemeTokenValues>>>;
}

export const MIN_FONT_SCALE = 0.8;
export const MAX_FONT_SCALE = 1.35;
export const FONT_SCALE_STEP = 0.05;
export const DEFAULT_FONT_SCALE = 1;
export const DEFAULT_FONT_FAMILY =
  '"Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
/** The pre-Geist default. Persisted appearance still carrying it is migrated. */
export const LEGACY_DEFAULT_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const THEME_TOKEN_LABELS: Array<{ key: ThemeTokenKey; label: string }> = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Text" },
  { key: "panel", label: "Panel" },
  { key: "primary", label: "Ink" },
  { key: "primaryForeground", label: "Ink text" },
  { key: "muted", label: "Muted" },
  { key: "mutedForeground", label: "Muted text" },
  { key: "border", label: "Border" },
  { key: "signal", label: "Signal" },
];

// Command Center palette: monochrome ink on warm off-white / near-black, with
// one signal colour reserved for "needs you" (unread, typing, progress, errors).
export const DEFAULT_THEME_TOKENS: Record<ThemeMode, ThemeTokenValues> = {
  light: {
    background: "#f4f3ef",
    foreground: "#111110",
    primary: "#111110",
    primaryForeground: "#f4f3ef",
    muted: "#ebe9e3",
    mutedForeground: "#6e6c66",
    border: "#dedcd5",
    panel: "#ffffff",
    signal: "#dd5a2c",
  },
  dark: {
    background: "#0e0e0d",
    foreground: "#eeece6",
    primary: "#eeece6",
    primaryForeground: "#0e0e0d",
    muted: "#1f1e1c",
    mutedForeground: "#8a877f",
    border: "#2a2926",
    panel: "#161615",
    signal: "#f07a4f",
  },
};

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  fontScale: DEFAULT_FONT_SCALE,
  fontFamily: DEFAULT_FONT_FAMILY,
  themeOverrides: {},
};

export function clampFontScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FONT_SCALE;
  const rounded = Math.round(value * 100) / 100;
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, rounded));
}

export function getThemeTokenValue(
  settings: AppearanceSettings,
  mode: ThemeMode,
  key: ThemeTokenKey
): string {
  return settings.themeOverrides[mode]?.[key] ?? DEFAULT_THEME_TOKENS[mode][key];
}

export function getThemeTokens(settings: AppearanceSettings, mode: ThemeMode): ThemeTokenValues {
  return {
    ...DEFAULT_THEME_TOKENS[mode],
    ...settings.themeOverrides[mode],
  };
}

function hexToHsl(hex: string): string {
  const normalized = normalizeHex(hex);
  const r = Number.parseInt(normalized.slice(1, 3), 16) / 255;
  const g = Number.parseInt(normalized.slice(3, 5), 16) / 255;
  const b = Number.parseInt(normalized.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  // One decimal: whole-percent rounding shifted the warm neutrals by up to
  // 2–3 RGB levels, which is visible between adjacent panels.
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return `${r1(h * 360)} ${r1(s * 100)}% ${r1(l * 100)}%`;
}

export function normalizeHex(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return "#000000";
}

export function applyAppearance(settings: AppearanceSettings, mode: ThemeMode): void {
  const root = document.documentElement;
  const tokens = getThemeTokens(settings, mode);
  const setColor = (name: string, value: string) => root.style.setProperty(name, hexToHsl(value));

  root.style.setProperty("font-size", `${clampFontScale(settings.fontScale) * 100}%`);
  root.style.setProperty("--app-font-family", settings.fontFamily || DEFAULT_FONT_FAMILY);

  setColor("--background", tokens.background);
  setColor("--panel", tokens.panel);
  setColor("--card", tokens.panel);
  setColor("--popover", tokens.panel);
  setColor("--signal", tokens.signal);
  setColor("--foreground", tokens.foreground);
  setColor("--card-foreground", tokens.foreground);
  setColor("--popover-foreground", tokens.foreground);
  setColor("--primary", tokens.primary);
  setColor("--ring", tokens.primary);
  setColor("--primary-foreground", tokens.primaryForeground);
  setColor("--muted", tokens.muted);
  setColor("--secondary", tokens.muted);
  setColor("--accent", tokens.muted);
  setColor("--muted-foreground", tokens.mutedForeground);
  setColor("--secondary-foreground", tokens.foreground);
  setColor("--accent-foreground", tokens.foreground);
  setColor("--border", tokens.border);
  setColor("--input", tokens.border);
}
