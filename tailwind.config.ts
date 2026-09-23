import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      // Command Center type scale, in rem so ⌘+/− font scaling still applies
      // (root = 16px × fontScale). Pixel values are the design's at scale 1.
      fontSize: {
        "cc-h1": ["2.125rem", { lineHeight: "2.5rem", letterSpacing: "-0.03em" }], // 34/40
        "cc-lead": ["0.9375rem", "1.375rem"], // 15/22
        // The rest keep the 19px body line-height, as in the design (chips and
        // meta inherit it, which is what sizes the key chips to 21px).
        "cc-title": ["0.9375rem", "1.1875rem"], // 15
        "cc-body": ["0.84375rem", "1.1875rem"], // 13.5/19
        "cc-sender": ["0.71875rem", "1.1875rem"], // 11.5
        "cc-meta": ["0.6875rem", "1.1875rem"], // 11
        "cc-chip": ["0.65625rem", "1.1875rem"], // 10.5
        "cc-time": ["0.625rem", "0.875rem"], // 10/14
      },
      // Named, not arbitrary: tailwindcss-animate also claims `duration-*`
      // (animation-duration), so `duration-[120ms]` is ambiguous.
      transitionDuration: {
        120: "120ms",
        160: "160ms",
      },
      fontFamily: {
        sans: ["var(--app-font-family)"],
        mono: ['"Geist Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        panel: "hsl(var(--panel))",
        signal: "hsl(var(--signal))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [animate],
};

export default config;
