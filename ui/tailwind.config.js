/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // shadcn-style color tokens. Sourced from CSS vars in src/index.css so
      // theme switching (.dark / .light on <html>) flips them automatically.
      colors: {
        border: 'rgb(var(--border) / <alpha-value>)',
        input: 'rgb(var(--border) / <alpha-value>)',
        ring: 'rgb(var(--accent) / <alpha-value>)',
        background: 'rgb(var(--bg) / <alpha-value>)',
        foreground: 'rgb(var(--fg) / <alpha-value>)',
        primary: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          foreground: 'rgb(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'rgb(var(--bg-surface) / <alpha-value>)',
          foreground: 'rgb(var(--fg) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'rgb(var(--bg-surface) / <alpha-value>)',
          foreground: 'rgb(var(--fg-muted) / <alpha-value>)',
        },
        accent: {
          // shadcn's "accent" slot — the subtle hover bg (NOT Nook's brand color)
          DEFAULT: 'rgb(var(--surface-hover) / <alpha-value>)',
          foreground: 'rgb(var(--fg) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'rgb(var(--destructive) / <alpha-value>)',
          foreground: 'rgb(var(--destructive-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'rgb(var(--bg-surface) / <alpha-value>)',
          foreground: 'rgb(var(--fg) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'rgb(var(--bg-surface) / <alpha-value>)',
          foreground: 'rgb(var(--fg) / <alpha-value>)',
        },
        sidebar: {
          DEFAULT: 'rgb(var(--sidebar-bg) / <alpha-value>)',
          foreground: 'rgb(var(--sidebar-fg) / <alpha-value>)',
          muted: 'rgb(var(--sidebar-fg-muted) / <alpha-value>)',
          accent: 'rgb(var(--sidebar-accent-bg) / <alpha-value>)',
          border: 'rgb(var(--sidebar-border) / <alpha-value>)',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
}
