# Frontend Data Models

All types are frontend-facing projections of backend entities/DTOs. Nullability follows code (`nullable:true` columns, optional DTO fields, `|null` returns). Derived values are computed client-side only from authoritative fields — never sent back.

## SafeUser (API-REST-001/002/017)

```ts
type UserRole = 'User' | 'Admin' | 'Customer'; // 'Customer' is a code alias of 'User'
type OAuthProvider = 'local' | 'google';
interface SafeUser {
  id: string; firstName: string; lastName: string; email: string;
  role: UserRole; provider: OAuthProvider;
  phoneNumber: string | null; phoneVerified: boolean;
  emailVerified: boolean; marketingOptIn: boolean; emailOptIn: boolean;
}
// Never present: password, token hashes, expiries. Ev: safe-user-response.dto.ts:72-86.
```

## Product (API-GQL-001/002)

```ts
interface Product { id: string; name: string; slug: string; description: string; price: number; created_at: string; }
interface PaginationMeta { totalItems: number; itemCount: number; itemsPerPage: number; totalPages: number; currentPage: number; }
interface ProductPagination { data: Product[]; meta: PaginationMeta; }
// No stock/available/images on Product. price is integer, CHECK >=0. Ev: schema.gql:37-54, product.entity.ts.
```

## Inventory (API-REST-030/031)

```ts
interface InventoryView { id: string; productId: string; stock: number; reservedAmount: number; available: number; createdAt: string; updatedAt: string; }
// available = stock - reservedAmount (getter, never a column). Ev: inventory.entity.ts:49-51.
interface AvailabilityCheck { available: number; requested: number; sufficient: boolean; }
```

## Cart (API-REST-020..025)

```ts
interface CartItem { id: string; quantity: number; product: Product; }
interface Cart { id: string; cart_items: CartItem[]; }
// No totals persisted. Derived (display-only): cartEstimatedTotal = Σ qty*product.price. Ev: cart.entity.ts, cart-items.entity.ts.
```

## Order + OrderItem (API-REST-026/035/037/038/039)

```ts
type OrderStatus = 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
interface CheckoutItem { id: string; productId: string; quantity: number; unitPrice: number; unit_price: number; subtotal: number; productName: string; }
interface Order { id: string; userId: string; status: OrderStatus; total: number; createdAt: string; updatedAt?: string; expiresAt: string; reservationId: string; items: CheckoutItem[]; reservation?: { id: string; status: ReservationStatus; expiresAt: string; orderId: string } | null; reason?: 'user' | 'failed' | 'expired'; }
// Render both unitPrice and unit_price (both shipped); fallback subtotal = qty*price. total is server-computed Σ. Ev: order.controller.ts, order-items.entity.ts:66-82.
```

## Payment (API-REST-028/029/034/045/046)

```ts
type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
type DeclineReason = 'card_declined' | 'insufficient_funds' | 'expired_card';
interface Payment { id: string; orderId: string; userId: string; amount: number; currency: 'usd'; status: PaymentStatus; provider: 'simulation'; failureReason: string | null; createdAt: string; updatedAt: string; }
// amount is server-copied from Order.total. 1:1 Payment:Order (@Unique orderId). Ev: payment.entity.ts.
```

## Reservation (API-REST-043/044, read-only for shoppers)

```ts
type ReservationStatus = 'RESERVED' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';
interface ReservationItem { id: string; inventoryId: string; quantity: number; }
interface Reservation { id: string; userId: string; orderId: string | null; status: ReservationStatus; expiresAt: string; items: ReservationItem[]; createdAt: string; updatedAt: string; }
```

## Notifications (API-REST-047..050 + WS)

```ts
type NotificationChannel = 'SYSTEM' | 'EMAIL';
type NotificationStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'FAILED';
interface Notification { id: string; userId: string; eventId: string; channel: NotificationChannel; type: string; title: string; body: string; status: NotificationStatus; isRead: boolean; readAt: string | null; sentAt: string; deliveredAt: string | null; }
interface WsNotificationNew { id: string; type: string; title: string; body: string; channel: NotificationChannel; eventId: string; createdAt: string; }
// isRead/readAt is user behavior, not delivery. Ev: notification.entity.ts.
```

## Enums & pagination summary

- Order: `PENDING→COMPLETED|CANCELLED|FAILED`; `COMPLETED→COMPLETED` idempotent only.
- Payment: `PENDING→SUCCEEDED|FAILED|CANCELLED`; terminal re-confirm 200 zero-delta; terminal cancel 409.
- Reservation: `RESERVED→COMPLETED|EXPIRED|CANCELLED`; same-status 200, cross 409.
- Pagination: `{data, meta:{totalItems,itemCount,itemsPerPage,totalPages,currentPage}}` everywhere; order/reservation lists are NaN-unguarded (validate client-side); payment/notification lists are strict (400 on bad input); payments use `totalPages=0` when empty.

## Ownership (see frontend-architecture.md)

- **Server-owned:** Product, InventoryView, Cart, Order/Total, Payment, Reservation, Notification rows.
- **Client-owned:** form input, dialogs, UI prefs, `x-request-id` per mutation, pager state.
- **Derived (display-only):** `available` display, cart estimates, `subtotal` fallback, status pills, `totalPages` guards.
- **Cached:** product pages (≤60s), single product (≤300s); never cache availability beyond the current view.
