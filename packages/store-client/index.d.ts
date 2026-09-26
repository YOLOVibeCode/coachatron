// @noctusoft/store-client — types for the app side of the Noctusoft store.
// Contract: noctusoft-relay docs/api/store/README.md. Refs are opaque strings.

/// <reference types="node" />

// ---------------------------------------------------------------- event v1 ----

export type CheckoutEventType = "checkout.completed" | "checkout.expired";
export type PurchaseEventType =
  | "purchase.paid"
  | "purchase.failed"
  | "purchase.refunded"
  | "purchase.refund_failed"
  | "purchase.disputed"
  | "purchase.dispute_won"
  | "purchase.dispute_lost"
  | "purchase.fraud_warning";
export type SubscriptionEventType =
  | "subscription.started"
  | "subscription.renewed"
  | "subscription.payment_failed"
  | "subscription.action_required"
  | "subscription.changed"
  | "subscription.paused"
  | "subscription.resumed"
  | "subscription.canceled"
  | "subscription.trial_ending"
  | "subscription.renewal_upcoming";
export type SellerEventType = "seller.updated" | "seller.disconnected" | "seller.payout_paid" | "seller.payout_failed";
export type WalletEventType = "wallet.method_added" | "wallet.method_updated" | "wallet.method_removed";
export type MarketplaceEventType = `marketplace.${CheckoutEventType | PurchaseEventType | SubscriptionEventType}`;
export type EventType = CheckoutEventType | PurchaseEventType | SubscriptionEventType | SellerEventType | WalletEventType | MarketplaceEventType;
export type EventFamily = "checkout" | "purchase" | "subscription" | "seller" | "wallet" | "marketplace";
export type Mode = "test" | "live";

export interface StoreEvent<T extends EventType = EventType> {
  id: string;
  type: T;
  version: 1;
  store: string;
  product: string;
  mode: Mode;
  occurredAt: string;
  buyer: { userId: string | null; email: string | null } | null;
  item: { code: string; key: string; kind: "plan" | "sku"; name: string; quantity: number } | null;
  /** amountCents is what the buyer paid: after a coupon, with tax. taxCents is null when the store charges no tax. */
  money: {
    amountCents: number; currency: string; refundedCents: number; feeCents: number | null;
    discountCents: number | null; taxCents: number | null;
  } | null;
  /** The coupon that took money off this payment, or null. */
  discount: { code: string } | null;
  refs: {
    orderId: string | null;
    paymentId: string | null;
    subscriptionId: string | null;
    refundId: string | null;
    disputeId: string | null;
    [ref: string]: string | null;
  };
  subscription: {
    ref?: string;
    status: string;
    planKey?: string | null;
    currentPeriodEnd?: string | null;
    cancelAtPeriodEnd?: boolean;
    [field: string]: unknown;
  } | null;
  seller: {
    ref: string | null;
    key: string | null;
    status?: "active" | "pending" | "restricted" | "disconnected" | "action_required" | string;
    chargesEnabled?: boolean;
    payoutsEnabled?: boolean;
    requirementsDue?: string[];
    [field: string]: unknown;
  } | null;
  /** Present when the buyer or seller must do something, e.g. save a card on a new store. */
  action?: { reason: string; url: string | null; [field: string]: unknown } | null;
  entitlements: Record<string, unknown>;
  [field: string]: unknown;
}

export declare const EVENT_FAMILIES: {
  readonly checkout: readonly CheckoutEventType[];
  readonly purchase: readonly PurchaseEventType[];
  readonly subscription: readonly SubscriptionEventType[];
  readonly seller: readonly SellerEventType[];
  readonly wallet: readonly WalletEventType[];
};
export declare const EVENT_TYPES: readonly Exclude<EventType, MarketplaceEventType>[];
export declare function isEventType(type: unknown): type is EventType;
export declare function familyOf(type: unknown): EventFamily | null;

// ------------------------------------------------------------------- links ----

interface LinkLifetime {
  /** Unix seconds. Default: now + ttlSeconds. */
  exp?: number;
  /** Default: 24 random hex characters. */
  nonce?: string;
  /** Default 86400 (a day). Ignored when exp is given. */
  ttlSeconds?: number;
  /** The relay's public URL; without it `url` is relative. */
  baseUrl?: string;
}

export interface SignedLink<P> {
  url: string;
  sig: string;
  payload: P;
}

export interface BuyLinkPayload { store: string; code: string; user: string; email: string; return: string; qty: number; exp: number; nonce: string }
export interface ConnectBuyLinkPayload { product: string; seller: string; amountCents: number; currency: string; user: string; email: string; return: string; exp: number; nonce: string }
export interface WalletLinkPayload { store: string; user: string; email: string; return: string; exp: number; nonce: string; mode: Mode }

/** A plan or SKU of a store, signed with the store's signing secret. The relay prices it. */
export declare function signBuyLink(args: LinkLifetime & {
  secret: string;
  store: string;
  code: string;
  user?: string;
  email?: string;
  returnUrl?: string;
  qty?: number;
}): SignedLink<BuyLinkPayload>;

/** One amount paid to one seller, signed with the product's Connect signing key. */
export declare function signConnectBuyLink(args: LinkLifetime & {
  secret: string;
  product: string;
  seller: string;
  amountCents: number;
  currency?: string;
  user?: string;
  email?: string;
  returnUrl?: string;
}): SignedLink<ConnectBuyLinkPayload>;

/** The relay's save-a-card page for one buyer, signed with the store's signing secret. */
export declare function signWalletLink(args: LinkLifetime & {
  secret: string;
  store: string;
  user: string;
  email: string;
  returnUrl: string;
  mode?: Mode;
}): SignedLink<WalletLinkPayload>;

// ---------------------------------------------------------------- webhooks ----

type RawBody = string | Buffer | Uint8Array;
type HeaderBag = Record<string, string | string[] | undefined> | { get(name: string): string | null };

export type VerifyResult =
  | { ok: true; event: StoreEvent; noctusoft: boolean; relay: boolean }
  | { ok: false; reason: "unsigned" | "signature" | "json"; noctusoft: boolean; relay: boolean; event?: undefined };

export declare function verifyWebhook(args: { secret: string; body: RawBody; callbackUrl: string; headers: HeaderBag }): VerifyResult;

export type EventPattern = EventType | `${EventFamily}.*` | "*";
export type EventHandler = (event: StoreEvent, context: { headers: HeaderBag }) => unknown | Promise<unknown>;

export interface WebhookReply {
  status: 200 | 400 | 401 | 500;
  body: { ok: boolean; handled?: boolean; duplicate?: boolean; code?: string; error?: string };
}

export interface WebhookHandler {
  handle(args: { body: RawBody; headers: HeaderBag }): Promise<WebhookReply>;
  /** node:http / Express (before express.json(), or behind express.raw()). */
  node(req: import("node:http").IncomingMessage & { body?: unknown; rawBody?: unknown }, res: import("node:http").ServerResponse): Promise<void>;
  /** Fetch-style route handlers. */
  fetch(request: Request): Promise<Response>;
}

export declare function createWebhookHandler(args: {
  secret: string;
  callbackUrl: string;
  on?: Partial<Record<EventPattern, EventHandler>>;
  idempotency?: { seen(id: string): boolean | Promise<boolean>; remember(id: string): unknown };
  onError?: (err: unknown, event: StoreEvent) => void;
}): WebhookHandler;

// ------------------------------------------------------------------ client ----

export declare class StoreError extends Error {
  readonly name: "StoreError";
  readonly status: number;
  /** The relay's code, e.g. INVALID_REQUEST, NOT_FOUND, SCOPE_FORBIDDEN, AUTHENTICATION_REQUIRED, COUPON_INVALID (body.reason), TAX_LOCATION_REQUIRED. */
  readonly code: string;
  readonly retryable: boolean;
  readonly body: unknown;
}

export interface CatalogItem {
  code: string; key: string; name: string; kind: "plan" | "sku";
  interval: string | null; intervalCount?: number | null; trialDays?: number | null;
  priceCents: number; currency: string;
}
export interface Catalog { mode: Mode; plans: CatalogItem[]; skus: CatalogItem[]; [field: string]: unknown }
export interface Entitlements {
  userId: string;
  plan: string | null;
  active: boolean;
  until: string | null;
  owns: Record<string, unknown>;
  subscription: { ref: string; status: string; [field: string]: unknown } | null;
  [field: string]: unknown;
}
export interface Purchase {
  userId: string; email: string | null; kind: string; sku: string | null; plan: string | null; quantity: number;
  amountCents: number; currency: string; paymentRef: string | null; orderRef: string | null; subscriptionRef: string | null;
  sellerKey: string | null; status: string; mode: Mode; createdAt: string; updatedAt: string;
}
/** What a coupon takes off one sale. */
export interface AppliedDiscount {
  code: string; name: string; percentOff: number | null; amountOffCents: number | null; currency: string | null;
  duration: "once" | "repeating" | "forever"; durationMonths: number | null;
  /** Taken off this sale. */
  amountCents: number;
}
/** `reason` on a 422 COUPON_INVALID (StoreError.body.reason). */
export type CouponRefusal = "NOT_FOUND" | "INACTIVE" | "EXPIRED" | "EXHAUSTED" | "ALREADY_USED" | "NOT_APPLICABLE" | "UNAVAILABLE";
export interface TaxAddress { country: string; state?: string; postalCode?: string; city?: string; line1?: string; line2?: string }
export interface HostedCheckout {
  /** A relay page; in a native app open it in an in-app browser session with an app-scheme returnUrl. */
  url: string;
  checkoutRef: string;
  mode?: Mode;
  subtotalCents?: number;
  discount?: AppliedDiscount | null;
  /** After the coupon, before tax. */
  amountCents?: number;
  currency?: string;
  /** "automatic": the hosted page adds tax at the buyer's address. */
  tax?: "automatic" | "none";
  [field: string]: unknown;
}
export interface Quote {
  mode: Mode; currency: string;
  lines: { key: string; code: string; name: string; quantity: number; priceCents: number }[];
  subtotalCents: number; discount: AppliedDiscount | null; amountCents: number; tax: "automatic" | "none";
  /** null when the store charges tax and no address was given. */
  taxCents: number | null; totalCents: number | null;
  /** Free days before the first bill, on a plan quote. */
  trialDays?: number;
}
export interface SubscriptionView {
  subscriptionRef: string; status: string; planKey: string | null; planCode: string | null; pendingPlanKey: string | null;
  currentPeriodEnd: string | null; billingStartsAt: string | null; trialEnd?: string | null; [field: string]: unknown;
}
export interface PaymentMethod { paymentMethodRef: string; brand: string | null; last4: string | null; [field: string]: unknown }
export interface ChargeResult {
  paymentRef: string; paymentMethodRef: string; status: string;
  item?: { key: string; code: string; name: string; quantity: number } | null;
  subtotalCents?: number; discountCents?: number; discount?: { code: string } | null; taxCents?: number;
  /** What the card was charged: after the coupon, with tax. */
  amountCents: number; currency: string;
  card: { brand: string | null; last4: string | null }; feeCents?: number | null;
}
export interface RefundResult { refundRef: string; paymentRef: string; status: string; amountCents: number }

interface Buyer { userId: string; email: string }
interface Idempotent { idempotencyKey: string }

/** Read what the store sells and what a buyer owns. */
export interface StoreReads {
  catalog(): Promise<Catalog>;
  entitlements(userId: string): Promise<Entitlements>;
  purchases(args?: { userId?: string; limit?: number }): Promise<{ store: string; purchases: Purchase[] }>;
}

/** Sell a plan or SKUs through the relay's hosted checkout. */
export interface StoreCheckout {
  /** returnUrl: https on billing.returnOrigins, or an app scheme on billing.returnSchemes (the app gets ?checkout=completed|canceled). */
  checkout(args: Buyer & Idempotent & { plan: string; returnUrl: string; coupon?: string }): Promise<HostedCheckout>;
  order(args: Buyer & Idempotent & { items: { code: string; quantity?: number }[]; returnUrl: string; maxAmountCents?: number; coupon?: string }): Promise<HostedCheckout>;
  /** What a sale costs with a coupon and, given an address, tax. Moves no money. Name one of plan, items, item. */
  quote(args: { plan?: string; items?: { code: string; quantity?: number }[]; item?: string; quantity?: number; coupon?: string; userId?: string; address?: TaxAddress }): Promise<Quote>;
}

export interface StoreSubscriptions {
  cancel(subscriptionRef: string, args?: { atPeriodEnd?: boolean }): Promise<SubscriptionView>;
  pause(subscriptionRef: string, args?: { months?: number }): Promise<SubscriptionView>;
  resume(subscriptionRef: string): Promise<SubscriptionView>;
  changePlan(subscriptionRef: string, args: { plan: string; effective?: "now" | "period_end" }): Promise<SubscriptionView & { effective: string }>;
  updatePaymentMethod(subscriptionRef: string, args: { returnUrl: string }): Promise<{ subscriptionRef: string; step: { kind: "redirect"; url: string } }>;
}

export interface StoreRefunds {
  refund(paymentRef: string, args: Idempotent & { amountCents?: number; reason?: string }): Promise<RefundResult>;
}

/** Saved cards and off-session charges. */
export interface StoreWallet {
  setup(args: Buyer & { returnUrl: string }): Promise<{ url: string; expiresAt: string }>;
  list(userId: string): Promise<{ userId: string; paymentMethods: PaymentMethod[] }>;
  remove(paymentMethodRef: string, args: { userId: string }): Promise<{ removed: true; paymentMethodRef: string }>;
}

export interface StoreCharges {
  /**
   * A catalog SKU priced by the relay (item, quantity, coupon) or an open amount (amountCents, no coupon).
   * 402 AUTHENTICATION_REQUIRED (StoreError.body.actionUrl) when the bank wants the buyer present;
   * 422 TAX_LOCATION_REQUIRED when a taxing store's saved card has no billing address.
   */
  charge(args: Idempotent & { userId: string; paymentMethodRef?: string; description?: string } & (
    | { item: string; quantity?: number; coupon?: string; amountCents?: never }
    | { amountCents: number; currency?: string; item?: never; coupon?: never }
  )): Promise<ChargeResult>;
}

/** One seller of a marketplace product (Connect Hub). */
export interface SellerClient extends StoreRefunds {
  agree(args: { version: string }): Promise<unknown>;
  status(): Promise<{ sellerRef: string; status: string; [field: string]: unknown }>;
  onboard(args: { returnUrl: string; email?: string }): Promise<{ url: string; [field: string]: unknown }>;
  createPlan(args: { key: string; name: string; priceCents: number; interval?: "month" | "year" | string; currency?: string }): Promise<unknown>;
  catalog(): Promise<Catalog>;
  checkout(args: Buyer & Idempotent & { plan: string; returnUrl?: string }): Promise<HostedCheckout>;
  /** With paymentMethodRef: an off-session charge on a saved card. Without: a hosted checkout for the amount. */
  charge(args: Idempotent & { userId: string; email?: string; amountCents: number; currency?: string; paymentMethodRef?: string; returnUrl?: string; description?: string }): Promise<HostedCheckout | ChargeResult>;
  subscriptions: StoreSubscriptions;
  wallet: StoreWallet;
}

export interface StoreClient extends StoreReads, StoreCheckout, StoreRefunds, StoreCharges {
  subscriptions: StoreSubscriptions;
  wallet: StoreWallet;
  marketplace(product: string): { seller(sellerKey: string): SellerClient };
}

export declare function createStoreClient(args: {
  /** The relay's public URL. */
  baseUrl: string;
  /** The product's relay key (nsk_…). */
  apiKey: string;
  /** One of the product's store aliases (X-Test-Store). */
  store?: string;
  /** X-Store-Mode. */
  mode?: Mode;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}): StoreClient;
