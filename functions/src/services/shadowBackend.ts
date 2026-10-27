import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import type { OrderItem, OrderMemberSnapshot, PosOrder } from "../types/order";

// =============================================================================
// Shadow writes to the JJL Data Sync backend (parallel-run phase, test only)
// =============================================================================
// After Firestore has committed a POS order write, send the same operation to
// the JJL Data Sync backend. The backend recomputes the order on its own and
// compares it with Firestore. Firestore stays the source of truth.
//
// - Does nothing unless SHADOW_BACKEND_URL (Functions environment variable)
//   and the SHADOW_BACKEND_KEY secret are both set.
// - Waits at most SHADOW_TIMEOUT_MS and swallows every error: a slow or broken
//   backend must never fail or noticeably slow down a sale.
// - Logs only the order id, the operation and an error name or status code.
//
// Deploying a function that binds SHADOW_BACKEND_KEY fails when the secret is
// missing from the project, so create it first on every project this code is
// deployed to:
//   firebase functions:secrets:set SHADOW_BACKEND_KEY --project test-jw-system
// =============================================================================

export const shadowBackendKeySecret = defineSecret("SHADOW_BACKEND_KEY");
export const SHADOW_TIMEOUT_MS = 2_000;

export type ShadowOperation = "prepare" | "checkout";

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
 * Build the command the backend expects: the operation input (order fields,
 * authoritative priced items, operator) plus the values this function
 * generated itself, read from the order as written.
 */
export function buildShadowOrderCommand(
  operation: ShadowOperation,
  input: ShadowOrderInput,
  items: OrderItem[],
  operator: ShadowOperator,
  order: ShadowOrderValues,
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
  };
  return operation === "prepare"
    ? { ...command, updatedAt: order.updatedAt }
    : { ...command, paymentMethodId: order.paymentMethodId, paidAt: order.paidAt };
}

/** Send one command to the backend. Never throws. */
export async function sendShadowOrder(
  operation: ShadowOperation,
  command: Record<string, unknown>,
): Promise<void> {
  const baseUrl = process.env.SHADOW_BACKEND_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) return;
  const localOrderId = String(command.localOrderId ?? "");

  try {
    const key = shadowBackendKeySecret.value();
    if (!key) return;
    const response = await fetch(`${baseUrl}/shadow/pos-orders/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shadow-Key": key },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(SHADOW_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn("[shadowBackend] Backend không nhận lệnh ghi song song", {
        operation,
        localOrderId,
        status: response.status,
      });
      return;
    }
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
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}
