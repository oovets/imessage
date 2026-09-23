import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import { ghostIconButton } from "@/components/ui/icon-button";

export function ThemeToggle() {
  const { resolved, setTheme } = useTheme();
  const isDark = resolved === "dark";
  return (
    <button
      type="button"
      className={ghostIconButton}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
    >
      {isDark ? <Sun /> : <Moon />}
    </button>
  );
}
