import { randomBytes } from "node:crypto";
import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../config/firebase";
import { POS_COLLECTIONS } from "../config/collections";
import { getPosAuthSession } from "../services/posAuthService";
import { runShadowedTransaction } from "../services/shadowTransaction";
import type { PosOrder } from "../types/order";

export function paymentStatusSnapshot(order: PosOrder) {
  const attempt = order.paymentDetails?.attempts.find(
    (candidate) => candidate.orderCode === order.paymentDetails?.currentOrderCode,
  );
  const paidAttempt = order.paymentDetails?.attempts.find(
    (candidate) => candidate.status === "PAID" && candidate.orderCode === order.payosReconciliation?.orderCode,
  ) ?? order.paymentDetails?.attempts.find(
    (candidate) => candidate.status === "PAID" && candidate.paidAt === order.paidAt,
  ) ?? (attempt?.status === "PAID" ? attempt : null);
  return {
    localOrderId: order.localOrderId,
    orderKind: order.orderKind ?? "STANDARD",
    orderStatus: order.status,
    orderCode: attempt?.orderCode ?? null,
    paymentStatus: attempt?.status ?? null,
    paymentVerificationStatus: order.paymentVerificationStatus ?? "VERIFIED",
    providerConfirmedAt: order.payosReconciliation?.verifiedAt ?? paidAttempt?.paidAt ?? null,
    paidAt: order.paidAt ?? paidAttempt?.paidAt ?? null,
    confirmationSource: order.paymentVerificationStatus === "UNVERIFIED" && order.status !== "DRAFT"
      ? "MANUAL" : paidAttempt?.confirmationSource ?? null,
    updatedAt: order.updatedAt,
  };
}

/** Must be called in the same transaction as the corresponding order write. */
export function writePaymentStatus(transaction: Transaction, order: PosOrder): void {
  if (!order.paymentWatchId) return;
  transaction.set(
    db.collection(POS_COLLECTIONS.paymentStatus).doc(order.paymentWatchId),
    paymentStatusSnapshot(order),
    { merge: true },
  );
}

/** The opaque ID delegates this device's read access, scoped to one owner/order.
 * It is never a replacement for Firebase Auth or the live RBAC rules. */
export async function createPaymentWatch(
  userId: string,
  device: { id: string; warehouseId: string },
  localOrderId: unknown,
) {
  if (typeof localOrderId !== "string" || !/^ORD-\d{10,13}-[A-Z0-9]{6}$/.test(localOrderId)) {
    throw new HttpsError("invalid-argument", "Mã đơn hàng không hợp lệ.");
  }
  const session = await getPosAuthSession(userId);
  if (!session.warehouses.some((warehouse) => warehouse.id === device.warehouseId)) {
    throw new HttpsError("permission-denied", "Không có quyền theo dõi thanh toán tại điểm bán này.");
  }
  const expiresAt = Timestamp.fromMillis(Date.now() + 20 * 60 * 1000);
  const orderRef = db.collection(POS_COLLECTIONS.orders).doc(localOrderId);
  const watchId = await runShadowedTransaction("payment-watch", async (transaction, recordShadow) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists) throw new HttpsError("not-found", "Không tìm thấy đơn hàng.");
    const order = snapshot.data() as PosOrder;
    if (order.createdBy !== userId || order.deviceId !== device.id || order.warehouseId !== device.warehouseId) {
      throw new HttpsError("permission-denied", "Phiên thanh toán không thuộc thu ngân và thiết bị này.");
    }
    const id = order.paymentWatchId ?? randomBytes(32).toString("hex");
    transaction.set(db.collection(POS_COLLECTIONS.paymentStatus).doc(id), {
      ...paymentStatusSnapshot(order),
      ownerUid: userId,
      deviceId: device.id,
      warehouseId: device.warehouseId,
      expiresAt,
    });
    if (!order.paymentWatchId) {
      transaction.update(orderRef, { paymentWatchId: id });
      recordShadow(order, {
        operatorUid: userId,
        deviceId: device.id,
        watchId: id,
        at: new Date().toISOString(),
      });
    }
    return id;
  });
  return { watchId, expiresAt: expiresAt.toDate().toISOString() };
}
