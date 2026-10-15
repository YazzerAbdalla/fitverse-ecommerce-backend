# Component Inventory (`UI-COMP-*`)

Every component: purpose → props → variants/states → behavior → a11y → responsive → reuse. All proposed (no existing frontend). Only components with a clear MVP purpose are listed.

## Shell & navigation

- **UI-COMP-001 AppShell:** header + main + footer + toast region + dialog outlet. Props: `user: SafeUser|null`, `cartCount`, `unreadCount`. A11y: landmarks, skip-link. Reuse: every page.
- **UI-COMP-002 DesktopNav / UI-COMP-003 MobileNav (bottom bar + drawer):** links Home/Products/Cart/Orders/Notifications/Account + auth-aware (guest → Login/Register; user → logout). Props: `user`, `unreadCount`. Breakpoint: drawer <1024, bar <640. A11y: `aria-current`, focus-trap in drawer, Esc closes.
- **UI-COMP-004 SearchBar (client-side):** input + clear; filters *loaded* pages only, labeled "searches loaded products". Props: `value, onChange, resultCount`. No debounce-server logic (no backend support).
- **UI-COMP-005 Breadcrumbs:** Home / Products / `{name}`. Simple nav aid; `aria-label=breadcrumb`, `aria-current=page` on last.

## Catalog

- **UI-COMP-006 ProductCard:** placeholder tile (initial letter), name (2-line clamp), price (tabular-nums), "View" link. Props: `product`. States: default/hover/focus; loading → `UI-COMP-015` skeleton. Never shows stock.
- **UI-COMP-007 ProductGallery:** single placeholder art + thumbs (decorative, since no images). Props: `product`. A11y: `alt="{name}"`, decorative thumbs `aria-hidden`.
- **UI-COMP-008 StockBadge:** derived from API-REST-030/031 only. Variants: `in-stock (success) / low-stock (warning, ≤threshold, default 5) / out-of-stock (danger) / unavailable (neutral, inventory 404) / sign-in-required (neutral, guest)`. Props: `available|null, threshold`. Always text+icon, never color-alone.
- **UI-COMP-009 PriceDisplay:** integer price + presentational currency label + optional "refreshes at checkout" hint on PDP. Props: `price, hint?`. Monospace/tabular figures.

## Cart & checkout

- **UI-COMP-010 QuantitySelector:** stepper (− value +) + direct input. Props: `value, min=1, max=available?, onChange, disabled`. A11y: `aria-live` value announcement, spinbutton role where apt. Clamp to `available` when known; overshoot → 409 path.
- **UI-COMP-011 CartLine:** thumb, name, unit price, stepper, line estimate, remove. Props: `item, available?`. Decrease-to-0 routes to remove (backend 400s otherwise).
- **UI-COMP-012 CartSummary:** lines count, estimated total (`Σ qty×price`, labeled "Estimate — final total at checkout"), checkout CTA. Props: `cart, pending?`. CTA disabled when empty/pending.
- **UI-COMP-013 OrderStatusPill / UI-COMP-014 PaymentStatusPill:** text+icon pills for `PENDING|COMPLETED|CANCELLED|FAILED` and `PENDING|SUCCEEDED|FAILED|CANCELLED`. Props: `status`. Never color-alone.

## Forms & feedback

- **UI-COMP-015 SkeletonLoader:** shimmer blocks for cards/lines/details. Props: `variant`. Respects `prefers-reduced-motion` (static blocks).
- **UI-COMP-016 Pagination:** prev/numbered/next pager bound to `{page, totalPages}`. Props: `page, totalPages, onPage`. Client-clamps page≥1; payment/notification pages surface backend 400 inline.
- **UI-COMP-017 FilterBar (notifications/orders):** selects for `isRead/channel/type/status` + page-size. Props mirror API-REST-038/047 query DTOs.
- **UI-COMP-018 TextField / UI-COMP-019 PasswordField (show/hide) / UI-COMP-020 Select / UI-COMP-021 Checkbox:** labeled inputs with `aria-describedby` error slots; password min 8 readable rule; email `type=email`.
- **UI-COMP-022 Button (primary/secondary/ghost/danger) / UI-COMP-023 AddToCartButton (pending→disabled+spinner):** single primary per viewport; danger only behind confirm.
- **UI-COMP-024 Dialog/ConfirmDialog:** focus-trap, Esc, return-focus; used for clear-cart, cancel-order, logout-all.
- **UI-COMP-025 Toast:** success/info only (never for money completion — that gets a page); `role=status`, auto-dismiss 5s, action link optional.
- **UI-COMP-026 Alert (inline):** variants success/warning/danger/info; used for 400/403/404/409/429/500 copy including verbatim backend strings where specified (`exist.`, `loged`, reservation 403s).
- **UI-COMP-027 EmptyState:** art + title + action (e.g., empty cart → "Browse products").
- **UI-COMP-028 FieldError:** inline message bound to input via `aria-describedby`; shows DTO/validation text, never logs values.

Reuse rule: pages compose these; no page-local duplicates of buttons/inputs/badges/pagers. New components need a purpose statement + reuse note before being added.
