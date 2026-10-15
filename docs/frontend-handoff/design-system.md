# Design System (PROPOSED — no existing frontend brand found)

No frontend styles/branding exist in this workspace, so everything below is a **proposed** direction optimized for discovery, trust, readability, conversion. Tokens are shipped as CSS variables + Tailwind mapping.

## A. Brand & visual direction

- **Personality:** calm, trustworthy marketplace (think Stripe-meets-Etsy restraint). No playful gradients on money paths; color is reserved for status + primary action.
- **Principles:** (1) price/availability always legible first; (2) one primary action per viewport; (3) status is text + icon, never color-alone; (4) destructive actions need confirm dialogs.

### Tokens (`:root` CSS variables)

```css
:root {
  /* color */
  --color-bg: #fafaf9; --color-surface: #ffffff; --color-surface-2: #f5f5f4;
  --color-ink: #1c1917; --color-ink-2: #57534e; --color-ink-3: #a8a29e;
  --color-line: #e7e5e4;
  --color-primary: #1d4ed8; --color-primary-hover: #1e40af; --color-on-primary: #ffffff;
  --color-success: #15803d; --color-success-bg: #dcfce7;
  --color-warning: #b45309; --color-warning-bg: #fef3c7;
  --color-danger: #b91c1c; --color-danger-bg: #fee2e2;
  --color-info: #0369a1; --color-info-bg: #e0f2fe;
  /* type: system stack first (no webfont dependency for MVP) */
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --text-xs: .75rem; --text-sm: .875rem; --text-base: 1rem; --text-lg: 1.125rem;
  --text-xl: 1.25rem; --text-2xl: 1.5rem; --text-3xl: 1.875rem;
  /* spacing (4pt) */ --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-6: 24px; --sp-8: 32px; --sp-12: 48px;
  /* layout */ --content-max: 1200px; --radius-sm: 6px; --radius-md: 10px; --radius-lg: 16px;
  --shadow-sm: 0 1px 2px rgb(0 0 0/.06); --shadow-md: 0 4px 12px rgb(0 0 0/.08);
}
/* Tailwind: map primary/success/warning/danger/info + radius + content-max via theme.extend.colors/borderRadius/maxWidth. Dark mode: deferred (light only V1). */
```

- **Grid:** 12-col, max 1200px, gutters 16m/24t/32d. **Icons:** 1.5px outline (Lucide-style), 16/20px. **Images:** 4:3 catalog, 1:1 PDP main, placeholder art (initial-letter tile) since backend has no images. **Motion:** 150ms ease-out micro (hover/press), 250ms dialogs/toasts; `prefers-reduced-motion: reduce` disables all non-essential animation.

## B.–D. summarized here; full component specs live in `component-inventory.md`

- **Breakpoints:** `sm 640 / md 768 / lg 1024 / xl 1280`. Mobile: single column, bottom-nav + sticky cart CTA; PDP stacks gallery→info; cart lines stack with thumb+stepper. Tablet: 3-col grid. Laptop: 4-col grid, PDP 2-col (gallery sticky). Desktop ≥1280: same + wider gutters. Touch targets ≥44px; images `object-cover` with fixed aspect boxes (no layout shift).
- **State language (global):** initial load → skeletons (never blank); background refetch → subtle stale indicator (catalog shows "updated X ago"); empty → art + action; validation → inline `aria-describedby` + red border + message; 401 → silent refresh once, else session-expired banner; 429 → countdown + disabled submit (honor `Retry-After`); 409 → contention card with recovery (see flows); checkout pending → full-step busy state + double-submit lock; success → confirmation page (never a toast-only for money); network fail → inline retry on GETs, explicit re-submit on mutations.
