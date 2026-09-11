// Multichain widget theme, mapped onto Nook's own design tokens (index.css).
// The widget renders in the app's DOM and applies these values as CSS, so
// `rgb(var(--…))` references resolve against :root — the widget follows the
// app's light/dark theme automatically instead of being a hardcoded dark box.
export const WIDGET_THEME = {
  backgroundColor: 'rgb(var(--bg))',
  textColor: 'rgb(var(--fg))',
  secondaryTextColor: 'rgb(var(--fg-muted))',
  errorTextColor: 'rgb(var(--destructive))',
  inputBackgroundColor: 'rgb(var(--bg-surface))',
  inputBorderColor: 'rgb(var(--border))',
  inputTextColor: 'rgb(var(--fg))',
  // Primary action = Nook's neutral brand button (near-black in light mode,
  // near-white in dark), same as Upload / New drive.
  buttonBackgroundColor: 'rgb(var(--accent))',
  buttonTextColor: 'rgb(var(--primary-foreground))',
  buttonSecondaryBackgroundColor: 'rgb(var(--bg-surface))',
  buttonSecondaryTextColor: 'rgb(var(--fg))',
  borderRadius: '8px', // matches --radius (0.5rem)
  fontFamily: "'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif",
  fontSize: '13px',
  fontWeight: 400,
  smallFontSize: '11px',
  smallFontWeight: 400,
  labelSpacing: '0.1em',
  inputVerticalPadding: '8px',
  inputHorizontalPadding: '12px',
  buttonVerticalPadding: '10px',
  buttonHorizontalPadding: '16px',
}
