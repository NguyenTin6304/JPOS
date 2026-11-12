import type { DocumentReference } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../config/firebase";
import { POS_COLLECTIONS } from "../config/collections";
import { getPosAuthSession } from "../services/posAuthService";
import { runShadowedTransaction } from "../services/shadowTransaction";
import { shadowAppliedVouchers, shadowReleasedVouchers } from "../services/shadowBackend";
import { writePaymentStatus } from "./paymentStatusProjection";
import {
  applyOrderVouchers,
  releaseOrderVoucherReservations,
  type AppliedVouchers,
} from "../services/voucherService";
import type {
  FixedTransferDetails,
  FixedTransferReason,
  PosOrder,
} from "../types/order";
import type {
  FixedTransferSettings,
  FixedTransferSettingsInput,
} from "../types/paymentSettings";
import { buildPayOSPaymentDescription } from "./payosPolicy";
import {
  buildVietQrQuickLink,
  normalizeFixedTransferSettings,
} from "./fixedTransferPolicy";

const MANAGE_PAYMENT_SETTINGS_PERMISSION = "pos.settings.manage";

function readWarehouseId(data: unknown): string {
  const warehouseId = data && typeof data === "object"
    ? (data as { warehouseId?: unknown }).warehouseId
    : undefined;
  if (typeof warehouseId !== "string" || !warehouseId.trim()) {
    throw new HttpsError("invalid-argument", "Điểm bán không hợp lệ.");
  }
  return warehouseId.trim();
}

function hasScopedPermission(
  permissions: Record<string, Record<string, unknown>>,
  key: string,
  warehouseId: string,
): boolean {
  const globalPermissions = permissions.global ?? {};
  const warehousePermissions = permissions[warehouseId] ?? {};
  return globalPermissions["*"] === true ||
    globalPermissions[key] === true ||
    warehousePermissions["*"] === true ||
    warehousePermissions[key] === true;
}

async function requireAccessibleWarehouse(userId: string, warehouseId: string) {
  const session = await getPosAuthSession(userId);
  const warehouse = session.warehouses.find((item) => item.id === warehouseId);
  if (!warehouse) {
    throw new HttpsError(
      "permission-denied",
      "Bạn không có quyền truy cập cấu hình thanh toán của điểm bán này.",
    );
  }
  return { session, warehouse };
}

export function isFixedTransferActive(order: PosOrder): boolean {
  return order.fixedTransferDetails?.status ===
    "AWAITING_MANUAL_CONFIRMATION";
}

export async function getFixedTransferSettingsForUser(
  userId: string,
  data: unknown,
  deviceId: string,
) {
  const warehouseId = readWarehouseId(data);
  await requireAccessibleWarehouse(userId, warehouseId);
  return {
    settings: await getFixedTransferSettingsForDevice(deviceId, warehouseId),
  };
}

export async function saveFixedTransferSettingsForUser(
  userId: string,
  data: unknown,
  deviceId: string,
) {
  const rawInput = data && typeof data === "object"
    ? data as Partial<FixedTransferSettingsInput>
    : {};
  const warehouseId = readWarehouseId(rawInput);
  const { session } = await requireAccessibleWarehouse(userId, warehouseId);
  if (
    !hasScopedPermission(
      session.permissions,
      MANAGE_PAYMENT_SETTINGS_PERMISSION,
      warehouseId,
    )
  ) {
    throw new HttpsError(
      "permission-denied",
      "Bạn không có quyền thay đổi cấu hình thanh toán.",
    );
  }

  let normalized: FixedTransferSettingsInput;
  try {
    normalized = normalizeFixedTransferSettings({
      deviceId,
      warehouseId,
      enabled: rawInput.enabled === true,
      fixedTransferOnly: rawInput.fixedTransferOnly === true,
      bankBin: typeof rawInput.bankBin === "string" ? rawInput.bankBin : "",
      accountNumber: typeof rawInput.accountNumber === "string"
        ? rawInput.accountNumber
        : "",
      accountName: typeof rawInput.accountName === "string"
        ? rawInput.accountName
        : "",
    });
  } catch (error: unknown) {
    throw new HttpsError(
      "invalid-argument",
      error instanceof Error ? error.message : "Cấu hình thanh toán không hợp lệ.",
    );
  }

  const docRef = db
    .collection(POS_COLLECTIONS.paymentSettings)
    .doc(deviceId);
  const settings = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(docRef);
    const currentVersion = snapshot.exists
      ? Number((snapshot.data() as Partial<FixedTransferSettings>).version) || 0
      : 0;
    const nextSettings: FixedTransferSettings = {
      ...normalized,
      version: currentVersion + 1,
      updatedAt: new Date().toISOString(),
      updatedByUid: userId,
    };
    transaction.set(docRef, nextSettings);
    return nextSettings;
  });
  return { settings };
}

export async function getFixedTransferSettingsForDevice(
  deviceId: string,
  warehouseId: string,
): Promise<FixedTransferSettings | null> {
  const collection = db.collection(POS_COLLECTIONS.paymentSettings);
  const deviceSnapshot = await collection.doc(deviceId).get();
  const snapshot = deviceSnapshot.exists
    ? deviceSnapshot
    : await collection.doc(warehouseId).get();
  if (!snapshot.exists) return null;
  const settings = snapshot.data() as Omit<FixedTransferSettings, "deviceId"> & {
    deviceId?: string;
  };
  return {
    ...settings,
    deviceId,
    warehouseId,
    fixedTransferOnly: settings.fixedTransferOnly === true,
  };
}

async function getFixedTransferSettingsForOrder(
  order: PosOrder,
): Promise<FixedTransferSettings | null> {
  if (order.deviceId) {
    return getFixedTransferSettingsForDevice(order.deviceId, order.warehouseId);
  }
  const snapshot = await db
    .collection(POS_COLLECTIONS.paymentSettings)
    .doc(order.warehouseId)
    .get();
  if (!snapshot.exists) return null;
  return {
    ...(snapshot.data() as Omit<FixedTransferSettings, "deviceId">),
    deviceId: "legacy",
    warehouseId: order.warehouseId,
  };
}

export async function activateFixedTransferForOrder(
  userId: string,
  docRef: DocumentReference,
  reason: FixedTransferReason,
): Promise<PosOrder> {
  const snapshot = await docRef.get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Không tìm thấy đơn hàng.");
  }
  const order = snapshot.data() as PosOrder;
  if (isFixedTransferActive(order)) return order;
  if (order.status !== "DRAFT" || order.createdBy !== userId) {
    throw new HttpsError(
      "failed-precondition",
      "Đơn hàng không thể chuyển sang mã QR tài khoản cố định.",
    );
  }
  const { warehouse } = await requireAccessibleWarehouse(
    userId,
    order.warehouseId,
  );
  const settings = await getFixedTransferSettingsForOrder(order);
  if (!settings) {
    throw new HttpsError(
      "failed-precondition",
      "PayOS không tạo được mã và điểm bán chưa cấu hình tài khoản chuyển khoản dự phòng.",
    );
  }
  if (!settings.enabled) {
    throw new HttpsError(
      "failed-precondition",
      "Mã QR tài khoản cố định đang bị tắt trong cài đặt thanh toán.",
    );
  }

  const description = buildPayOSPaymentDescription(
    warehouse.code,
    order.localOrderId,
  );
  const qrImageUrl = buildVietQrQuickLink({
    bankBin: settings.bankBin,
    accountNumber: settings.accountNumber,
    accountName: settings.accountName,
    amount: order.totalAmount,
    description,
  });

  return runShadowedTransaction("fixed-activate", async (transaction, recordShadow) => {
    const freshSnapshot = await transaction.get(docRef);
    if (!freshSnapshot.exists) {
      throw new HttpsError("not-found", "Không tìm thấy đơn hàng.");
    }
    const freshOrder = freshSnapshot.data() as PosOrder;
    if (isFixedTransferActive(freshOrder)) return freshOrder;
    if (freshOrder.status !== "DRAFT" || freshOrder.createdBy !== userId) {
      throw new HttpsError(
        "failed-precondition",
        "Đơn hàng không còn chờ thanh toán.",
      );
    }
    const now = new Date().toISOString();
    const fixedTransferDetails: FixedTransferDetails = {
      provider: "vietqr_quicklink",
      status: "AWAITING_MANUAL_CONFIRMATION",
      reason,
      bankBin: settings.bankBin,
      accountNumber: settings.accountNumber,
      accountName: settings.accountName,
      amount: freshOrder.totalAmount,
      description,
      qrImageUrl,
      settingsVersion: settings.version,
      createdAt: now,
      updatedAt: now,
    };
    transaction.update(docRef, {
      fixedTransferDetails,
      updatedAt: now,
    });
    writePaymentStatus(transaction, { ...freshOrder, fixedTransferDetails, updatedAt: now });
    recordShadow(freshOrder, {
      operatorUid: userId,
      warehouseCode: warehouse.code,
      reason,
      bankBin: settings.bankBin,
      accountNumber: settings.accountNumber,
      accountName: settings.accountName,
      settingsVersion: settings.version,
      activatedAt: now,
    });
    return { ...freshOrder, fixedTransferDetails, updatedAt: now };
  });
}

export async function confirmFixedTransferForOrder(
  userId: string,
  docRef: DocumentReference,
  operatorName: string,
): Promise<PosOrder> {
  return runShadowedTransaction("fixed-confirm", async (transaction, recordShadow) => {
    const snapshot = await transaction.get(docRef);
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Không tìm thấy đơn hàng.");
    }
    const order = snapshot.data() as PosOrder;
    if (order.status !== "DRAFT") return order;
    if (order.createdBy !== userId || !isFixedTransferActive(order)) {
      throw new HttpsError(
        "failed-precondition",
        "Đơn hàng chưa có mã QR tài khoản cố định đang chờ xác nhận.",
      );
    }
    let appliedVouchers: AppliedVouchers | null = null;
    if (order.voucherCodes?.length) {
      const calculation = await applyOrderVouchers(transaction, {
        voucherCodes: order.voucherCodes,
        warehouseId: order.warehouseId,
        orderId: order.localOrderId,
        userId,
        userName: operatorName,
        deviceId: order.deviceId || "unknown",
        items: order.items,
        mode: "COMMIT",
        reservedVouchers: order.vouchers,
      });
      appliedVouchers = calculation;
      if (calculation.totalAmount !== order.totalAmount) {
        throw new HttpsError(
          "failed-precondition",
          "Giá trị voucher đã thay đổi trong lúc chờ thanh toán.",
        );
      }
    }
    const confirmedAt = new Date().toISOString();
    const fixedTransferDetails: FixedTransferDetails = {
      ...order.fixedTransferDetails!,
      status: "MANUALLY_CONFIRMED",
      confirmedAt,
      confirmedByUid: userId,
      confirmedByName: operatorName,
      updatedAt: confirmedAt,
    };
    const nextOrder: PosOrder = {
      ...order,
      status: "LOCAL_PAID",
      paymentMethod: "QR_CODE",
      paymentMethodId: "QR_CODE",
      paymentMethodName: "Chuyển khoản (chưa xác nhận)",
      paymentVerificationStatus: "UNVERIFIED",
      fixedTransferDetails,
      paidAt: confirmedAt,
      updatedAt: confirmedAt,
    };
    transaction.update(docRef, {
      status: nextOrder.status,
      paymentMethod: nextOrder.paymentMethod,
      paymentMethodId: nextOrder.paymentMethodId,
      paymentMethodName: nextOrder.paymentMethodName,
      paymentVerificationStatus: nextOrder.paymentVerificationStatus,
      fixedTransferDetails,
      paidAt: confirmedAt,
      updatedAt: confirmedAt,
    });
    writePaymentStatus(transaction, nextOrder);
    recordShadow(nextOrder, {
      operatorUid: userId,
      operatorName,
      confirmedAt,
      ...shadowAppliedVouchers(appliedVouchers),
    });
    return nextOrder;
  });
}

export async function cancelFixedTransferForOrder(
  userId: string,
  docRef: DocumentReference,
): Promise<PosOrder> {
  return runShadowedTransaction("fixed-cancel", async (transaction, recordShadow) => {
    const snapshot = await transaction.get(docRef);
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Không tìm thấy đơn hàng.");
    }
    const order = snapshot.data() as PosOrder;
    if (!isFixedTransferActive(order)) return order;
    if (order.createdBy !== userId || order.status !== "DRAFT") {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền hủy mã QR tài khoản cố định này.",
      );
    }
    const updatedAt = new Date().toISOString();
    const fixedTransferDetails: FixedTransferDetails = {
      ...order.fixedTransferDetails!,
      status: "CANCELLED",
      updatedAt,
    };
    const releasedVouchers = await releaseOrderVoucherReservations(
      transaction,
      order,
      "Released after fixed-transfer cancellation",
    );
    transaction.update(docRef, { fixedTransferDetails, updatedAt });
    writePaymentStatus(transaction, { ...order, fixedTransferDetails, updatedAt });
    recordShadow(order, { operatorUid: userId, updatedAt, ...shadowReleasedVouchers(releasedVouchers) });
    return { ...order, fixedTransferDetails, updatedAt };
  });
}
