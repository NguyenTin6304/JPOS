import { randomUUID } from "node:crypto";

import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

import { POS_COLLECTIONS } from "../config/collections";
import { db } from "../config/firebase";
import type { OrderItem, PosOrder } from "../types/order";
import type { PosOrderVoucherSnapshot, PosVoucherResolution } from "../types/voucher";
import { calculateVoucherDiscount, type VoucherCalculation } from "./voucherCalculation";
import { isProductAvailableForWarehouse } from "./productVisibilityPolicy";
import {
  buildVoucherResolution,
  buildVoucherSettingId,
  normalizeVoucherCode,
  type RawVoucherCode,
  VOUCHER_CAMPAIGNS_COLLECTION,
  VOUCHER_CODES_COLLECTION,
  VOUCHER_REDEMPTIONS_COLLECTION,
  VOUCHER_SETTINGS_COLLECTION,
  voucherText,
} from "./voucherResolutionService";

interface ApplyVoucherInput {
  voucherCodes: string[];
  warehouseId: string;
  orderId: string;
  userId: string;
  userName?: string;
  deviceId: string;
  items: OrderItem[];
  mode: "RESERVE" | "COMMIT";
  reservedVouchers?: PosOrderVoucherSnapshot[];
}

/** The calculation applyOrderVouchers used, and the time it wrote on the voucher documents. */
export interface AppliedVouchers extends VoucherCalculation {
  appliedAt: Date;
}

/** The reservations releaseOrderVoucherReservations cancelled, and the time it wrote on them. */
export interface ReleasedVouchers {
  codes: string[];
  releasedAt: Date;
}

interface VoucherRecord {
  code: string;
  codeRef: FirebaseFirestore.DocumentReference;
  campaignRef: FirebaseFirestore.DocumentReference;
  resolution: PosVoucherResolution;
  redemptionRef: FirebaseFirestore.DocumentReference;
  previousStatus: string;
}

function timestampMilliseconds(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object" && "toDate" in value) {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  return Date.parse(voucherText(value));
}

async function loadVoucherRecord(
  transaction: FirebaseFirestore.Transaction,
  input: ApplyVoucherInput,
  codeValue: string,
): Promise<VoucherRecord> {
  const codeRef = db.collection(VOUCHER_CODES_COLLECTION).doc(codeValue);
  const codeSnapshot = await transaction.get(codeRef);
  if (!codeSnapshot.exists) {
    throw new HttpsError("not-found", `Không tìm thấy voucher ${codeValue}.`);
  }
  const codeData = codeSnapshot.data() as RawVoucherCode;
  if (codeData.is_deleted === true ||
      !["AVAILABLE", "DISTRIBUTED"].includes(voucherText(codeData.status))) {
    throw new HttpsError(
      "failed-precondition",
      `Voucher ${codeValue} đã được sử dụng hoặc không còn hiệu lực.`,
    );
  }
  const campaignId = voucherText(codeData.campaign_id);
  if (!campaignId) {
    throw new HttpsError(
      "failed-precondition",
      `Voucher ${codeValue} chưa được liên kết với chiến dịch hợp lệ.`,
    );
  }
  const campaignRef = db.collection(VOUCHER_CAMPAIGNS_COLLECTION).doc(campaignId);
  const redemptionRef = db.collection(VOUCHER_REDEMPTIONS_COLLECTION).doc(codeValue);
  const redemptionSnapshot = await transaction.get(redemptionRef);
  const redemption = redemptionSnapshot.data() || {};
  const sameOrderReservation = redemptionSnapshot.exists &&
    redemption.order_id === input.orderId && voucherText(redemption.status) === "RESERVED";
  if (redemptionSnapshot.exists) {
    const sameOrder = redemption.order_id === input.orderId;
    const activeReservation = voucherText(redemption.status) === "RESERVED" &&
      timestampMilliseconds(redemption.expires_at) > Date.now();
    if (!sameOrder && (activeReservation || redemption.status === "COMPLETED")) {
      throw new HttpsError(
        "already-exists",
        `Voucher ${codeValue} đang được dùng ở giao dịch khác.`,
      );
    }
  }

  const reservedSnapshot = input.reservedVouchers?.find(
    (voucher) => voucher.code === codeValue && voucher.campaignId === campaignId,
  );
  let resolution: PosVoucherResolution;
  if (input.mode === "COMMIT" && sameOrderReservation && reservedSnapshot) {
    resolution = {
      code: reservedSnapshot.code,
      campaignId: reservedSnapshot.campaignId,
      campaignName: reservedSnapshot.campaignName,
      rewardType: reservedSnapshot.rewardType,
      rewardValue: reservedSnapshot.rewardValue,
      product: reservedSnapshot.product,
    };
  } else {
    const settingRef = db.collection(VOUCHER_SETTINGS_COLLECTION)
      .doc(buildVoucherSettingId(input.warehouseId, campaignId));
    const [campaignSnapshot, settingSnapshot] = await Promise.all([
      transaction.get(campaignRef),
      transaction.get(settingRef),
    ]);
    if (!campaignSnapshot.exists || !settingSnapshot.exists) {
      throw new HttpsError(
        "failed-precondition",
        `Voucher ${codeValue} chưa được mapping hợp lệ.`,
      );
    }
    const productId = voucherText(settingSnapshot.data()?.product_id);
    if (!productId) {
      throw new HttpsError(
        "failed-precondition",
        `Voucher ${codeValue} chưa được mapping với sản phẩm tại cửa hàng này.`,
      );
    }
    const productRef = db.collection(POS_COLLECTIONS.products).doc(productId);
    const visibilityRef = db.collection(POS_COLLECTIONS.productVisibilitySettings)
      .doc(input.warehouseId);
    const [productSnapshot, visibilitySnapshot] = await Promise.all([
      transaction.get(productRef),
      transaction.get(visibilityRef),
    ]);
    const product = productSnapshot.data();
    if (
      !productSnapshot.exists ||
      !product ||
      !isProductAvailableForWarehouse(
        productId,
        product,
        visibilitySnapshot.data(),
      )
    ) {
      throw new HttpsError(
        "failed-precondition",
        `Sản phẩm của voucher ${codeValue} hiện không được bán tại cửa hàng.`,
      );
    }
    resolution = buildVoucherResolution(
      codeValue,
      codeData,
      campaignId,
      campaignSnapshot.data() || {},
      settingSnapshot.data() || {},
      product,
    );
  }
  return {
    code: codeValue,
    codeRef,
    campaignRef,
    resolution,
    redemptionRef,
    previousStatus: voucherText(codeData.status),
  };
}

function redemptionDocument(input: {
  request: ApplyVoucherInput;
  resolution: PosVoucherResolution;
  discountAmount: number;
  now: Date;
  status: "RESERVED" | "COMPLETED";
}) {
  const { resolution, now } = input;
  return {
    id: resolution.code,
    voucher_code: resolution.code,
    campaign_id: resolution.campaignId,
    warehouse_id: input.request.warehouseId,
    device_id: input.request.deviceId,
    order_id: input.request.orderId,
    staff_id: input.request.userId,
    reward_type: resolution.rewardType,
    reward_value: resolution.rewardValue,
    product_id: resolution.product.goodsId,
    quantity: resolution.product.quantity,
    discount_amount: input.discountAmount,
    status: input.status,
    ...(input.status === "RESERVED"
      ? { expires_at: new Date(now.getTime() + 15 * 60_000) }
      : {}),
    action_time: now,
    sync_time: now,
    is_deleted: false,
    created_at: now,
    updated_at: now,
  };
}

export async function applyOrderVouchers(
  transaction: FirebaseFirestore.Transaction,
  input: ApplyVoucherInput,
): Promise<AppliedVouchers> {
  const normalized = input.voucherCodes.map(normalizeVoucherCode);
  if (new Set(normalized).size !== normalized.length) {
    throw new HttpsError("invalid-argument", "Đơn hàng chứa voucher bị trùng.");
  }
  const records: VoucherRecord[] = [];
  for (const codeValue of normalized) {
    records.push(await loadVoucherRecord(transaction, input, codeValue));
  }
  const calculation = calculateVoucherDiscount(
    input.items,
    records.map((record) => record.resolution),
  );
  const now = new Date();
  for (const record of records) {
    const snapshot = calculation.vouchers.find((item) => item.code === record.code)!;
    if (input.mode === "RESERVE") {
      transaction.set(record.redemptionRef, redemptionDocument({
        request: input,
        resolution: record.resolution,
        discountAmount: snapshot.discountAmount,
        now,
        status: "RESERVED",
      }));
      continue;
    }
    transaction.update(record.codeRef, {
      status: "USED",
      used_at: now,
      used_by_staff_id: input.userId,
      used_by_staff_name: input.userName || input.userId,
      redemption_order_id: input.orderId,
      updated_by: input.userId,
      updated_at: now,
      revision: FieldValue.increment(1),
    });
    transaction.update(record.campaignRef, {
      [`code_counts.${record.previousStatus.toLowerCase()}`]: FieldValue.increment(-1),
      "code_counts.used": FieldValue.increment(1),
      revision: FieldValue.increment(1),
      updated_at: now,
    });
    transaction.set(record.redemptionRef, redemptionDocument({
      request: input,
      resolution: record.resolution,
      discountAmount: snapshot.discountAmount,
      now,
      status: "COMPLETED",
    }));
    transaction.create(db.collection("audit_logs").doc(`pos-voucher-${record.code}`), {
      id: `pos-voucher-${record.code}`,
      entity_type: "POS_VOUCHER_REDEMPTION",
      entity_id: record.code,
      entity_name: record.resolution.campaignName,
      warehouse_id: input.warehouseId,
      action: "UPDATE",
      user_id: input.userId,
      user_name: input.userName || null,
      action_time: now,
      sync_time: now,
      old_value: { status: record.previousStatus },
      new_value: { status: "USED", order_id: input.orderId },
      ip_address: null,
      device_id: input.deviceId,
      session_token: null,
      notes: "Redeemed JPULSE voucher in JPOS",
    });
  }
  // appliedAt is for the parallel-run shadow write (services/shadowBackend.ts).
  return { ...calculation, appliedAt: now };
}

export async function releaseOrderVoucherReservations(
  transaction: FirebaseFirestore.Transaction,
  order: Pick<PosOrder, "localOrderId" | "voucherCodes" | "createdBy" | "deviceId" | "warehouseId">,
  reason: string,
): Promise<ReleasedVouchers> {
  const snapshots = await Promise.all(
    (order.voucherCodes ?? []).map((code) =>
      transaction.get(
        db.collection(VOUCHER_REDEMPTIONS_COLLECTION).doc(normalizeVoucherCode(code)),
      ),
    ),
  );
  const now = new Date();
  const codes: string[] = [];
  for (const snapshot of snapshots) {
    const redemption = snapshot.data() || {};
    if (!snapshot.exists || redemption.order_id !== order.localOrderId ||
        voucherText(redemption.status) !== "RESERVED") continue;
    codes.push(snapshot.id);
    transaction.update(snapshot.ref, {
      status: "CANCELLED",
      cancelled_at: now,
      updated_at: now,
      sync_time: now,
    });
    const auditId = randomUUID();
    transaction.create(db.collection("audit_logs").doc(auditId), {
      id: auditId,
      entity_type: "POS_VOUCHER_REDEMPTION",
      entity_id: snapshot.id,
      entity_name: null,
      warehouse_id: order.warehouseId,
      action: "UPDATE",
      user_id: order.createdBy,
      user_name: null,
      action_time: now,
      sync_time: now,
      old_value: { status: "RESERVED", order_id: order.localOrderId },
      new_value: { status: "CANCELLED", order_id: order.localOrderId },
      ip_address: null,
      device_id: order.deviceId || null,
      session_token: null,
      notes: reason,
    });
  }
  // For the parallel-run shadow write (services/shadowBackend.ts).
  return { codes, releasedAt: now };
}

export const voucherFieldsForOrder = (
  calculation: VoucherCalculation,
): Pick<PosOrder, "subtotalAmount" | "discountAmount" | "totalAmount" | "voucherCodes" | "vouchers"> => ({
  subtotalAmount: calculation.subtotalAmount,
  discountAmount: calculation.discountAmount,
  totalAmount: calculation.totalAmount,
  voucherCodes: calculation.vouchers.map((item) => item.code),
  vouchers: calculation.vouchers,
});
