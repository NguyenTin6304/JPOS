import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { db } from "../config/firebase";
import { POS_COLLECTIONS } from "../config/collections";
import { getPosAuthSession } from "../services/posAuthService";
import { sendShadowPayment, shadowStoreTokensSecret } from "../services/shadowBackend";
import { runShadowedTransaction } from "../services/shadowTransaction";
import type { ActivePosDevice } from "../services/posDeviceAccessService";
import { payosApiKeySecret, payosChecksumKeySecret, payosClientIdSecret } from "../services/payosService";
import type { PosOrder } from "../types/order";
import { canReadOrder, hasReportPermission } from "../order/reportAccessPolicy";
import { listCloseoutOrdersForUser } from "../order/functions";
import { getCurrentVietnamDayRange } from "../order/orderHistoryRange";
import { reconcileCompletedPayOSOrder } from "./payosFunctions";
import { confirmedPayOSAttempt, isPayOSOrder, needsPayOSReconciliation, payOSReconciliationDueAt } from "./payosReconciliationPolicy";

async function authorize(userId: string, device: ActivePosDevice) {
  const session = await getPosAuthSession(userId);
  if (!session.warehouses.some((warehouse) => warehouse.id === device.warehouseId) ||
      !["pos.orders.read", "pos.orders.read_own_today"].some((key) => hasReportPermission(session.permissions, key, device.warehouseId))) {
    throw new HttpsError("permission-denied", "Bạn không có quyền đối soát tại điểm bán này.");
  }
  return session;
}

async function checkedOrderRef(device: ActivePosDevice, payload: { localOrderId?: unknown }) {
  if (typeof payload.localOrderId !== "string" || !/^ORD-\d{10,13}-[A-Z0-9]{6}$/.test(payload.localOrderId)) {
    throw new HttpsError("invalid-argument", "Mã đơn hàng không hợp lệ.");
  }
  const ref = db.collection(POS_COLLECTIONS.orders).doc(payload.localOrderId);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.data()?.warehouseId !== device.warehouseId) {
    throw new HttpsError("permission-denied", "Đơn hàng không thuộc điểm bán của máy POS.");
  }
  return { ref, order: snapshot.data() as PosOrder };
}

function summary(order: PosOrder, userId: string) {
  return {
    localOrderId: order.localOrderId, totalAmount: order.totalAmount,
    operatorName: order.paymentDetails?.manualConfirmation?.confirmedByName ?? order.operatorName,
    completedAt: order.paidAt ?? order.paymentDetails?.manualConfirmation?.confirmedAt ?? null,
    dueAt: order.payosReconciliation?.dueAt ?? payOSReconciliationDueAt(order),
    lastCheckedAt: order.payosReconciliation?.lastCheckedAt ?? null,
    lastError: order.payosReconciliation?.lastError ?? null,
    alertedAt: order.payosReconciliation?.alertedAt ?? null,
    acknowledged: order.payosReconciliation?.acknowledgedBy?.includes(userId) ?? false,
  };
}

/** Initialize legacy manually completed orders without querying PayOS on every list. */
async function initialize(ref: DocumentReference): Promise<PosOrder> {
  return runShadowedTransaction("payos-reconcile-init", async (transaction, recordShadow) => {
    const order = (await transaction.get(ref)).data() as PosOrder;
    if (!needsPayOSReconciliation(order) || order.payosReconciliation) return order;
    const now = new Date().toISOString();
    const dueAt = payOSReconciliationDueAt(order) ?? now;
    const payosReconciliation = { dueAt, nextCheckAt: dueAt };
    transaction.update(ref, { payosReconciliation });
    recordShadow(order, { at: now });
    return { ...order, payosReconciliation };
  });
}

export async function handlePayOSReconciliation(
  userId: string, device: ActivePosDevice, action: string,
  payload: { localOrderId?: unknown; warehouseId?: unknown },
) {
  if (action === "reconcile-closeout") {
    if (payload.warehouseId !== device.warehouseId) {
      throw new HttpsError("permission-denied", "Báo cáo không thuộc điểm bán của máy POS.");
    }
    const result = await listCloseoutOrdersForUser(userId, payload);
    const deadline = Date.now() + 40_000;
    let incomplete = false;
    for (let index = 0; index < result.orders.length; index += 4) {
      const group = result.orders.slice(index, index + 4);
      await Promise.all(group.map(async (order, offset) => {
        if (!needsPayOSReconciliation(order)) return;
        if (Date.now() >= deadline) { incomplete = true; return; }
        result.orders[index + offset] = await reconcileCompletedPayOSOrder(
          db.collection(POS_COLLECTIONS.orders).doc(order.localOrderId),
          8000,
        );
      }));
    }
    return { ...result, fetchedAt: new Date().toISOString(), reconciliationIncomplete: incomplete };
  }
  const session = await authorize(userId, device);
  if (action === "reconcile-check" || action === "reconcile-ack") {
    const { ref, order: orderForAccess } = await checkedOrderRef(device, payload);
    if (!canReadOrder(session.permissions, device.warehouseId, userId, orderForAccess)) {
      throw new HttpsError("permission-denied", "Bạn không có quyền xem đơn hàng này.");
    }
    if (action === "reconcile-check") {
      const order = await reconcileCompletedPayOSOrder(ref);
      return {
        pending: needsPayOSReconciliation(order),
        verified: isPayOSOrder(order) && order.paymentVerificationStatus === "VERIFIED",
        order: summary(order, userId),
      };
    }
    await initialize(ref);
    await runShadowedTransaction("payos-reconcile-ack", async (transaction, recordShadow) => {
      const order = (await transaction.get(ref)).data() as PosOrder;
      if (!needsPayOSReconciliation(order)) return;
      transaction.update(ref, { "payosReconciliation.acknowledgedBy": FieldValue.arrayUnion(userId) });
      recordShadow(order, { operatorUid: userId, at: new Date().toISOString() });
    });
    return { acknowledged: true };
  }
  const today = getCurrentVietnamDayRange();
  const query = db.collection(POS_COLLECTIONS.orders)
    .where("warehouseId", "==", device.warehouseId)
    .where("paymentVerificationStatus", "==", "UNVERIFIED")
    .where("createdAt", ">=", today.startAt)
    .where("createdAt", "<", today.endAt)
    .orderBy("createdAt").limit(100);
  const pending: Array<{ ref: DocumentReference; order: PosOrder }> = [];
  let page = await query.get();
  const scanDeadline = Date.now() + 35_000;
  while (!page.empty) {
    for (const doc of page.docs) {
      let order = doc.data() as PosOrder;
      if (!canReadOrder(session.permissions, device.warehouseId, userId, order) ||
          !needsPayOSReconciliation(order)) continue;
      if (!order.payosReconciliation) order = await initialize(doc.ref);
      if (needsPayOSReconciliation(order)) pending.push({ ref: doc.ref, order });
      if (pending.length > 500) {
        throw new HttpsError("resource-exhausted", "Có quá nhiều đơn PayOS chờ đối soát. Vui lòng liên hệ quản lý.");
      }
    }
    if (Date.now() >= scanDeadline) {
      throw new HttpsError("deadline-exceeded", "Chưa tải đủ danh sách đối soát PayOS. Vui lòng thử lại.");
    }
    page = await query.startAfter(page.docs[page.docs.length - 1]).get();
  }
  // Check newly overdue orders before warning, and repair legacy PAID evidence.
  const initialChecks = pending.filter(({ order }) => confirmedPayOSAttempt(order) ||
    (!order.payosReconciliation?.alertedAt && Date.parse(order.payosReconciliation?.dueAt ?? "") <= Date.now())).slice(0, 4);
  await Promise.all(initialChecks.map(async (entry) => {
    entry.order = await reconcileCompletedPayOSOrder(entry.ref, 8000);
  }));
  return {
    orders: pending.filter(({ order }) => needsPayOSReconciliation(order)).map(({ order }) => summary(order, userId)),
    serverTime: new Date().toISOString(),
  };
}

export const reconcilePendingPayOSPayments = onSchedule({
  schedule: "every 1 minutes", region: "asia-southeast1", timeoutSeconds: 120, maxInstances: 1,
  ...(process.env.GCLOUD_PROJECT === "test-jw-system"
    ? { serviceAccount: "pos-payment-qa@test-jw-system.iam.gserviceaccount.com" }
    : {}),
  secrets: [payosClientIdSecret, payosApiKeySecret, payosChecksumKeySecret, shadowStoreTokensSecret],
}, async () => {
  const snapshot = await db.collection(POS_COLLECTIONS.orders)
    .where("payosReconciliation.nextCheckAt", "<=", new Date().toISOString())
    .orderBy("payosReconciliation.nextCheckAt").limit(12).get();
  for (let index = 0; index < snapshot.docs.length; index += 4) {
    await Promise.all(snapshot.docs.slice(index, index + 4).map(async (doc) => {
      try {
        if (needsPayOSReconciliation(doc.data() as PosOrder)) {
          await reconcileCompletedPayOSOrder(doc.ref);
        } else {
          await doc.ref.update({ "payosReconciliation.nextCheckAt": null });
          await sendShadowPayment("payos-reconcile-clear", doc.data() as PosOrder, { at: new Date().toISOString() });
        }
      } catch (error) {
        logger.error("[PayOS reconciliation] Kiểm tra nền thất bại", { orderId: doc.id, error });
      }
    }));
  }
});
