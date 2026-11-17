import { getFunctions } from "firebase-admin/functions";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import { HttpsError } from "firebase-functions/v2/https";
import type { OrderItem, OrderMemberSnapshot, PosOrder } from "../types/order";
import type { PosOrderVoucherSnapshot } from "../types/voucher";
import type { AppliedVouchers, ReleasedVouchers } from "./voucherRedemptionService";

// =============================================================================
// Shadow writes to the JJL Data Sync backend (parallel-run phase, test only)
// =============================================================================
// After Firestore has committed a POS order write, send the same operation to
// the JJL Data Sync backend. The backend recomputes the order on its own and
// compares it with Firestore. Firestore stays the source of truth.
//
// - Does nothing unless SHADOW_BACKEND_URL (Functions environment variable) is
//   set.
// - Each store has its own token, sent in the X-Store-Token header. The
//   SHADOW_STORE_TOKENS secret is a JSON object: { "<warehouseId>": "<token>" }.
//   The backend takes the store from the token and refuses orders of other
//   stores. Adding a store means a new secret version and a redeploy.
// - Never throws: a slow or broken backend must never fail or noticeably slow
//   down a sale.
// - Delivery (SHADOW_DELIVERY environment variable):
//   - "direct" (default): post the command and wait at most SHADOW_TIMEOUT_MS;
//     a command that fails is lost (the backend's nightly heal copies the order).
//   - "queue": put the command on the Cloud Tasks queue of deliverShadowCommand
//     (order/shadowDeliveryWorker.ts) and return. The worker posts it and Cloud
//     Tasks retries it while the backend is down or the command arrives before
//     the write it was made on. If the command cannot be queued, it is posted
//     directly as in "direct".
// - Every command carries previousUpdatedAt: the order's updatedAt as the write
//   read it, before writing (null when the write created the order). The backend
//   defers (HTTP 409) a command whose previous version it does not have yet, so
//   queued commands are applied in order.
// - Logs only the order id, the store id, the operation and an error name or
//   status code.
//
// Deploying a function that binds SHADOW_STORE_TOKENS fails when the secret is
// missing from the project, so create it first on every project this code is
// deployed to:
//   firebase functions:secrets:set SHADOW_STORE_TOKENS --project test-jw-system
// =============================================================================

export const shadowStoreTokensSecret = defineSecret("SHADOW_STORE_TOKENS");
/** Direct delivery: the sale waits for it. */
export const SHADOW_TIMEOUT_MS = 2_000;
/** Queued delivery: nobody waits, so a slow backend gets more time. */
export const SHADOW_QUEUE_TIMEOUT_MS = 10_000;
export const SHADOW_QUEUE_FUNCTION = "deliverShadowCommand";
export const SHADOW_QUEUE_REGION = "asia-southeast1";
/** Tries of one queued command, over about 1.5 hours (order/shadowDeliveryWorker.ts). */
export const SHADOW_QUEUE_MAX_ATTEMPTS = 15;
/** How long Cloud Tasks waits for the worker, longer than SHADOW_QUEUE_TIMEOUT_MS. */
export const SHADOW_DISPATCH_DEADLINE_SECONDS = 30;
const SHADOW_PATHS = new Set(["prepare", "checkout", "payment", "sync", "package"]);

/** One command on the Cloud Tasks queue. */
export interface ShadowTask {
  path: string;
  operation: string;
  command: Record<string, unknown>;
}

export type ShadowOperation = "prepare" | "checkout";

/** One write of the QR payment flow, posted to /shadow/pos-orders/payment. */
export type ShadowPaymentOperation =
  | "qr-stage"
  | "payos-reserve"
  | "payos-link"
  | "payos-failed"
  | "payos-status"
  | "payos-paid"
  | "payos-connection-error"
  | "payos-manual-confirm"
  | "payos-resume"
  | "payos-local-cancel"
  | "payos-reconcile-retry"
  | "payos-reconcile-init"
  | "payos-reconcile-ack"
  | "payos-reconcile-clear"
  | "payment-watch"
  | "fixed-activate"
  | "fixed-confirm"
  | "fixed-cancel";

/**
 * One write of the 鲸舰 (Jingjianx) synchronization after payment, or of the
 * invoice request token, posted to /shadow/pos-orders/sync.
 */
export type ShadowSyncOperation =
  | "sync-claim"
  | "sync-remote-order"
  | "sync-finish"
  | "sync-retry"
  | "sync-requeue"
  | "invoice-token";

const SHADOW_SYNC_OPERATIONS: ReadonlySet<string> = new Set<ShadowSyncOperation>([
  "sync-claim",
  "sync-remote-order",
  "sync-finish",
  "sync-retry",
  "sync-requeue",
  "invoice-token",
]);

export function isShadowSyncOperation(operation: string): operation is ShadowSyncOperation {
  return SHADOW_SYNC_OPERATIONS.has(operation);
}

/** One write of a member package sale, posted to /shadow/pos-orders/package. */
export type ShadowPackageOperation =
  | "package-prepare"
  | "package-cash"
  | "package-qr-stage"
  | "package-sync-start"
  | "package-remote-order"
  | "package-sync-finish";

const SHADOW_PACKAGE_OPERATIONS: ReadonlySet<string> = new Set<ShadowPackageOperation>([
  "package-prepare",
  "package-cash",
  "package-qr-stage",
  "package-sync-start",
  "package-remote-order",
  "package-sync-finish",
]);

export function isShadowPackageOperation(operation: string): operation is ShadowPackageOperation {
  return SHADOW_PACKAGE_OPERATIONS.has(operation);
}

/** A 鲸舰 call the order synchronization makes. */
export type ShadowRemoteAction = "order_create" | "order_pay" | "order_pay_query";

/**
 * What one 鲸舰 call answered, as far as the synchronization uses it: the
 * response fields its decisions and error messages read, or the message of the
 * error the call threw. The backend replays the synchronization on these.
 */
export interface ShadowRemoteCall {
  action: ShadowRemoteAction;
  success?: unknown;
  code?: unknown;
  msg?: unknown;
  /** order_create: data.orderNumber. */
  orderNumber?: unknown;
  /** order_pay_query: data.payStatus. */
  payStatus?: unknown;
  /** order_create of a member package sale: data.actualPayment. */
  actualPayment?: unknown;
  /** order_pay_query of a member package sale: data.payStatusDesc. */
  payStatusDesc?: unknown;
  /** The call threw: the message the synchronization records as its error. */
  error?: string;
}

/**
 * The response fields of one 鲸舰 call the synchronization reads. Undefined
 * fields are left out. `packageSale` adds the two fields only the member
 * package synchronization reads.
 */
export function shadowRemoteResponse(
  action: ShadowRemoteAction,
  response: { success?: unknown; code?: unknown; msg?: unknown; data?: unknown },
  packageSale = false,
): ShadowRemoteCall {
  const data = response.data && typeof response.data === "object"
    ? response.data as Record<string, unknown>
    : {};
  const fields = action === "order_create"
    ? ["orderNumber", ...(packageSale ? ["actualPayment"] : [])]
    : action === "order_pay_query"
      ? ["payStatus", ...(packageSale ? ["payStatusDesc"] : [])]
      : [];
  return Object.fromEntries(
    Object.entries({
      action,
      success: response.success,
      code: response.code,
      msg: response.msg,
      ...Object.fromEntries(fields.map((field) => [field, data[field]])),
    }).filter(([, value]) => value !== undefined),
  ) as unknown as ShadowRemoteCall;
}

/**
 * A 鲸舰 call that threw, with the message the synchronization records.
 * `otherThrown` is what the caller records for a thrown value that is not an
 * Error; by default its text.
 */
export function shadowRemoteError(
  action: ShadowRemoteAction,
  error: unknown,
  otherThrown?: string,
): ShadowRemoteCall {
  return { action, error: error instanceof Error ? error.message : otherThrown ?? String(error) };
}

export type ShadowOrderRef = Pick<PosOrder, "localOrderId" | "warehouseId">;

/**
 * The order as a write read it, before writing: its updatedAt orders the
 * command. A write that creates the order has no updatedAt to give.
 */
export type ShadowOrderBefore = ShadowOrderRef & { updatedAt?: string | null };

/** The validated order input, as produced by validateOrderInput. */
export interface ShadowOrderInput {
  localOrderId: string;
  shopId: number;
  warehouseId: string;
  uid?: string;
  member?: OrderMemberSnapshot;
  deviceId?: string;
  voucherCodes: string[];
}

export interface ShadowOperator {
  employeeId: string;
  firebaseUid: string;
  name: string;
}

type ShadowOrderValues = Pick<
  PosOrder,
  | "createdAt"
  | "updatedAt"
  | "invoiceRequestToken"
  | "invoiceRequestCreatedAt"
  | "paymentMethodId"
  | "paidAt"
>;

/**
 * The voucher resolutions a write used (campaign, reward and product of each
 * code, as looked up in Firestore), without the discounts: the backend computes
 * those on its own.
 */
function voucherResolutions(vouchers: PosOrderVoucherSnapshot[]): Record<string, unknown>[] {
  return vouchers.map((voucher) => ({
    code: voucher.code,
    campaignId: voucher.campaignId,
    campaignName: voucher.campaignName,
    rewardType: voucher.rewardType,
    rewardValue: voucher.rewardValue,
    product: voucher.product,
  }));
}

/** Shadow values of a write that reserved or redeemed vouchers. */
export function shadowAppliedVouchers(applied: AppliedVouchers | null): Record<string, unknown> {
  return applied && applied.vouchers.length > 0
    ? {
        vouchers: voucherResolutions(applied.vouchers),
        vouchersAppliedAt: applied.appliedAt.toISOString(),
      }
    : {};
}

/** Shadow values of a write that released voucher reservations. */
export function shadowReleasedVouchers(released: ReleasedVouchers | null): Record<string, unknown> {
  return released && released.codes.length > 0
    ? {
        voucherRelease: {
          codes: released.codes,
          releasedAt: released.releasedAt.toISOString(),
        },
      }
    : {};
}

/**
 * Build the command the backend expects: the operation input (order fields,
 * authoritative priced items, operator, the vouchers the write applied) plus
 * the values this function generated itself, read from the order as written.
 * `previousUpdatedAt` is the order's updatedAt before the write (null when the
 * write created the order); left out, the backend does not order the command.
 */
export function buildShadowOrderCommand(
  operation: ShadowOperation,
  input: ShadowOrderInput,
  items: OrderItem[],
  operator: ShadowOperator,
  order: ShadowOrderValues,
  appliedVouchers: AppliedVouchers | null = null,
  previousUpdatedAt?: string | null,
): Record<string, unknown> {
  const command = {
    localOrderId: input.localOrderId,
    shopId: input.shopId,
    warehouseId: input.warehouseId,
    ...(input.uid ? { uid: input.uid } : {}),
    ...(input.member ? { member: input.member } : {}),
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    voucherCodes: input.voucherCodes,
    items,
    operator: {
      employeeId: operator.employeeId,
      firebaseUid: operator.firebaseUid,
      name: operator.name,
    },
    createdAt: order.createdAt,
    invoiceRequestToken: order.invoiceRequestToken,
    invoiceRequestCreatedAt: order.invoiceRequestCreatedAt,
    ...shadowAppliedVouchers(appliedVouchers),
    ...(previousUpdatedAt !== undefined ? { previousUpdatedAt } : {}),
  };
  return operation === "prepare"
    ? { ...command, updatedAt: order.updatedAt }
    : { ...command, paymentMethodId: order.paymentMethodId, paidAt: order.paidAt };
}

/** The store's token from the secret, or undefined when the store has none. */
function storeToken(warehouseId: string): string | undefined {
  const tokens: unknown = JSON.parse(shadowStoreTokensSecret.value() || "{}");
  const token = tokens && typeof tokens === "object"
    ? (tokens as Record<string, unknown>)[warehouseId]
    : undefined;
  return typeof token === "string" && token ? token : undefined;
}

/** Send one prepare or checkout command to the backend. Never throws. */
export async function sendShadowOrder(
  operation: ShadowOperation,
  command: Record<string, unknown>,
): Promise<void> {
  await postCommand(operation, operation, command);
}

/**
 * Send one write of the QR payment flow to the backend, after Firestore has
 * committed it. `values` are the values this function generated or received from
 * PayOS; the backend decides on its own what they change. `previousUpdatedAt`
 * is the order's updatedAt as the write read it (null when the write created
 * the order); left out, the backend does not order the command. Never throws.
 */
export async function sendShadowPayment(
  operation: ShadowPaymentOperation,
  order: ShadowOrderRef,
  values: Record<string, unknown>,
  previousUpdatedAt?: string | null,
): Promise<void> {
  await postCommand("payment", operation, {
    ...values,
    operation,
    localOrderId: order.localOrderId,
    warehouseId: order.warehouseId,
    ...(previousUpdatedAt !== undefined ? { previousUpdatedAt } : {}),
  });
}

/**
 * Send one write of the 鲸舰 synchronization, or of the invoice request token,
 * after Firestore has committed it. `before` is the order as the write read it,
 * before writing: its updatedAt orders the command. Never throws.
 */
export async function sendShadowSync(
  operation: ShadowSyncOperation,
  before: ShadowOrderBefore,
  values: Record<string, unknown>,
): Promise<void> {
  await postOrderedCommand("sync", operation, before, values);
}

/**
 * Send one write of a member package sale after Firestore has committed it.
 * `before` is the order as the write read it (without updatedAt when the write
 * created the order). Never throws.
 */
export async function sendShadowPackage(
  operation: ShadowPackageOperation,
  before: ShadowOrderBefore,
  values: Record<string, unknown>,
): Promise<void> {
  await postOrderedCommand("package", operation, before, values);
}

async function postOrderedCommand(
  path: string,
  operation: string,
  before: ShadowOrderBefore,
  values: Record<string, unknown>,
): Promise<void> {
  await postCommand(path, operation, {
    ...values,
    operation,
    localOrderId: before.localOrderId,
    warehouseId: before.warehouseId,
    previousUpdatedAt: before.updatedAt ?? null,
  });
}

function shadowBackendUrl(): string | undefined {
  return process.env.SHADOW_BACKEND_URL?.trim().replace(/\/+$/, "") || undefined;
}

function queuedDelivery(): boolean {
  return process.env.SHADOW_DELIVERY?.trim() === "queue";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** Queue the command, or post it directly (SHADOW_DELIVERY). Never throws. */
async function postCommand(
  path: string,
  operation: string,
  command: Record<string, unknown>,
): Promise<void> {
  if (!shadowBackendUrl()) return;
  const task: ShadowTask = { path, operation, command };
  if (queuedDelivery()) {
    try {
      await getFunctions()
        .taskQueue<ShadowTask>(`locations/${SHADOW_QUEUE_REGION}/functions/${SHADOW_QUEUE_FUNCTION}`)
        .enqueue(task, { dispatchDeadlineSeconds: SHADOW_DISPATCH_DEADLINE_SECONDS });
      return;
    } catch (error: unknown) {
      logger.warn("[shadowBackend] Không đưa được lệnh ghi song song vào hàng đợi, gửi thẳng", {
        operation,
        localOrderId: String(command.localOrderId ?? ""),
        error: errorName(error),
      });
    }
  }
  await deliver(task, SHADOW_TIMEOUT_MS);
}

/**
 * Deliver one queued command (deliverShadowCommand, order/shadowDeliveryWorker.ts).
 * Throws HttpsError "unavailable" (HTTP 503) when Cloud Tasks should send it
 * again: the backend is unreachable, overloaded or broken, or it deferred the
 * command (HTTP 409) until the write before it arrives. An HttpsError only sets
 * the response status; any other error would also be logged as an unhandled
 * error on every try. On the last try it logs the command as dropped instead:
 * the backend's nightly heal copies the order from Firestore.
 */
export async function handleShadowTask(task: ShadowTask, retryCount: number): Promise<void> {
  if (!isShadowTask(task)) {
    logger.error("[shadowBackend] Bỏ việc ghi song song không đúng dạng");
    return;
  }
  if (await deliver(task, SHADOW_QUEUE_TIMEOUT_MS) === "done") return;
  const attempts = retryCount + 1;
  if (attempts >= SHADOW_QUEUE_MAX_ATTEMPTS) {
    logger.error("[shadowBackend] Bỏ lệnh ghi song song sau khi hết số lần gửi", {
      operation: task.operation,
      localOrderId: String(task.command.localOrderId ?? ""),
      attempts,
    });
    return;
  }
  throw new HttpsError("unavailable", `Shadow command not delivered yet (${task.operation}, try ${attempts})`);
}

function isShadowTask(task: unknown): task is ShadowTask {
  const candidate = task as Partial<ShadowTask> | null;
  return typeof candidate?.path === "string" &&
    SHADOW_PATHS.has(candidate.path) &&
    typeof candidate.operation === "string" &&
    typeof candidate.command === "object" &&
    candidate.command !== null;
}

/** Statuses worth sending again: deferred, rate limited, or a server or proxy error. */
function isRetryableStatus(status: number): boolean {
  return status === 409 || status === 429 || status >= 500;
}

/**
 * Post one command. "retry" when sending it again later may work; "done" when it
 * was received, or sending it again cannot help (no token, a refused request).
 */
async function deliver(task: ShadowTask, timeoutMs: number): Promise<"done" | "retry"> {
  const baseUrl = shadowBackendUrl();
  if (!baseUrl) return "done";
  const { path, operation, command } = task;
  const localOrderId = String(command.localOrderId ?? "");
  const warehouseId = String(command.warehouseId ?? "");

  let token: string | undefined;
  try {
    token = storeToken(warehouseId);
  } catch (error: unknown) {
    logger.warn("[shadowBackend] Không gửi được lệnh ghi song song", {
      operation,
      localOrderId,
      error: errorName(error),
    });
    return "done";
  }
  if (!token) {
    logger.warn("[shadowBackend] Cửa hàng chưa có token ghi song song", {
      operation,
      localOrderId,
      warehouseId,
    });
    return "done";
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/shadow/pos-orders/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Store-Token": token },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    logger.warn("[shadowBackend] Không gửi được lệnh ghi song song", {
      operation,
      localOrderId,
      error: errorName(error),
    });
    return "retry";
  }
  if (!response.ok) {
    logger.warn("[shadowBackend] Backend không nhận lệnh ghi song song", {
      operation,
      localOrderId,
      status: response.status,
    });
    return isRetryableStatus(response.status) ? "retry" : "done";
  }
  try {
    const outcome = await response.json() as { result?: string; reason?: string | null };
    if (outcome.result === "rejected") {
      logger.warn("[shadowBackend] Backend từ chối lệnh ghi song song", {
        operation,
        localOrderId,
        reason: outcome.reason ?? null,
      });
    }
  } catch (error: unknown) {
    logger.warn("[shadowBackend] Không gửi được lệnh ghi song song", {
      operation,
      localOrderId,
      error: errorName(error),
    });
  }
  return "done";
}
