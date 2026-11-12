import { onSchedule } from "firebase-functions/v2/scheduler";
import {
  onDocumentWritten,
} from "firebase-functions/v2/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import type { DocumentReference, DocumentSnapshot } from "firebase-admin/firestore";
import { db } from "../config/firebase";
import { POS_COLLECTIONS } from "../config/collections";
import { isProductAvailableForWarehouse } from "../services/productVisibilityPolicy";
import { resolveOrderItemTaxPricing } from "../services/productTax";
import {
  confirmRemotePayment,
  createRemoteOrder,
  queryPaymentStatus,
} from "../services/hkApiService";
import { getPosAuthSession } from "../services/posAuthService";
import {
  canClaimRemoteOrderSync,
  canQueueRemoteOrderRetry,
  isRevenueEligibleOrder,
  shouldSynchronizeRemoteOrder,
} from "./orderLifecycle";
import {
  createInvoiceRequestToken,
  isInvoiceRequestToken,
} from "./invoiceRequestToken";
import type {
  OrderItem,
  OrderMemberSnapshot,
  PosOrder,
} from "../types/order";
import { getLuckyDrawSettingsForWarehouse } from "../luckyDraw/luckyDrawSettingsFunctions";
import { resolveLuckyDrawTicketCount } from "../luckyDraw/luckyDrawSettingsPolicy";
import {
  applyOrderVouchers,
  voucherFieldsForOrder,
  type AppliedVouchers,
} from "../services/voucherService";
import { getCurrentVietnamDayRange } from "./orderHistoryRange";
import { canAccessCloseout, canReadOrder, canReadOrderRange, isOwnOrderToday } from "./reportAccessPolicy";
import {
  buildShadowOrderCommand,
  sendShadowOrder,
  sendShadowPayment,
} from "../services/shadowBackend";

interface OrderItemInput {
  goodsId: string;
  quantity: number;
}

interface OrderInput {
  localOrderId: string;
  shopId: number;
  warehouseId: string;
  uid?: string;
  member?: OrderMemberSnapshot;
  deviceId?: string;
  items: OrderItemInput[];
  voucherCodes: string[];
}

interface CheckoutInput extends OrderInput {
  paymentMethodId: string;
}

interface OrderListInput {
  warehouseId?: string;
  startAt?: string;
  endAt?: string;
}

interface CloseoutOrderListInput {
  startAt: string;
  endAt: string;
  warehouseId: string;
  scope: "CURRENT_USER" | "ALL_USERS";
  purpose?: "VIEW" | "PRINT";
}

interface LatestOrderInput {
  shopId: number;
  status?: "DRAFT";
}

interface OperatorInfo {
  employeeId: string;
  firebaseUid: string;
  name: string;
}

interface LocalPaymentMethod {
  id: "CASH" | "QR_CODE";
  methodName: string;
}

const JPOS_PAYMENT_METHODS: Record<string, LocalPaymentMethod> = {
  CASH: { id: "CASH", methodName: "Tiền mặt" },
  QR_CODE: { id: "QR_CODE", methodName: "Chuyển khoản" },
};

const TICKET_PRODUCT_CATEGORY = 4;
const MAX_TICKETS_PER_ORDER = 1_000;
const MAX_LUCKY_DRAW_TICKETS_PER_ORDER = 200;

function createTicketCode(): string {
  return `JT-${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`;
}

function resolveJposPaymentMethod(paymentMethodId: string): LocalPaymentMethod {
  const method = JPOS_PAYMENT_METHODS[paymentMethodId];
  if (!method) {
    throw new HttpsError(
      "invalid-argument",
      "Phương thức thanh toán JPOS không hợp lệ.",
    );
  }
  return method;
}

function validateOrderInput(data: unknown): OrderInput {
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "Dữ liệu đơn hàng không hợp lệ.");
  }

  const input = data as Partial<OrderInput>;
  if (
    typeof input.localOrderId !== "string" ||
    !/^ORD-\d{10,13}-[A-Z0-9]{6}$/.test(input.localOrderId)
  ) {
    throw new HttpsError("invalid-argument", "Mã đơn hàng không hợp lệ.");
  }
  if (!Number.isInteger(input.shopId) || Number(input.shopId) <= 0) {
    throw new HttpsError("invalid-argument", "Mã cửa hàng không hợp lệ.");
  }
  if (
    typeof input.warehouseId !== "string" ||
    input.warehouseId.trim().length === 0
  ) {
    throw new HttpsError("invalid-argument", "Điểm bán không hợp lệ.");
  }
  if (
    input.uid !== undefined &&
    (typeof input.uid !== "string" ||
      input.uid.trim().length === 0 ||
      input.uid.trim().length > 128)
  ) {
    throw new HttpsError("invalid-argument", "UID thành viên không hợp lệ.");
  }
  const uid = typeof input.uid === "string" ? input.uid.trim() : undefined;
  const voucherCodes = Array.isArray(input.voucherCodes)
    ? input.voucherCodes.map((code) => {
        if (
          typeof code !== "string" ||
          code.trim().length < 4 ||
          code.trim().length > 80
        ) {
          throw new HttpsError("invalid-argument", "Mã voucher không hợp lệ.");
        }
        return code.trim().normalize("NFKC").toUpperCase();
      })
    : [];
  if (new Set(voucherCodes).size !== voucherCodes.length) {
    throw new HttpsError("invalid-argument", "Đơn hàng chứa voucher bị trùng.");
  }
  let member: OrderMemberSnapshot | undefined;
  if (input.member !== undefined) {
    if (!input.member || typeof input.member !== "object") {
      throw new HttpsError("invalid-argument", "Thông tin thành viên không hợp lệ.");
    }
    const candidate = input.member as Partial<OrderMemberSnapshot>;
    const memberCode = candidate.memberCode;
    if (
      typeof candidate.uid !== "string" ||
      candidate.uid.trim() !== uid ||
      (memberCode !== null &&
        (typeof memberCode !== "string" || memberCode.trim().length > 128)) ||
      typeof candidate.fullName !== "string" ||
      candidate.fullName.trim().length > 120 ||
      typeof candidate.phone !== "string" ||
      candidate.phone.trim().length > 32 ||
      typeof candidate.levelName !== "string" ||
      candidate.levelName.trim().length > 120
    ) {
      throw new HttpsError("invalid-argument", "Thông tin thành viên không hợp lệ.");
    }
    member = {
      uid: candidate.uid.trim(),
      memberCode: memberCode?.trim() || null,
      fullName: candidate.fullName.trim(),
      phone: candidate.phone.trim(),
      levelName: candidate.levelName.trim(),
    };
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new HttpsError("invalid-argument", "Đơn hàng chưa có sản phẩm.");
  }

  const seenGoodsIds = new Set<string>();
  const items = input.items.map((item) => {
    if (
      !item ||
      typeof item.goodsId !== "string" ||
      item.goodsId.trim().length === 0 ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 999
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Sản phẩm hoặc số lượng không hợp lệ.",
      );
    }
    if (seenGoodsIds.has(item.goodsId)) {
      throw new HttpsError(
        "invalid-argument",
        "Đơn hàng chứa sản phẩm bị trùng.",
      );
    }
    seenGoodsIds.add(item.goodsId);
    return { goodsId: item.goodsId, quantity: item.quantity };
  });

  return {
    localOrderId: input.localOrderId,
    shopId: Number(input.shopId),
    warehouseId: input.warehouseId.trim(),
    ...(uid ? { uid } : {}),
    ...(member ? { member } : {}),
    deviceId:
      typeof input.deviceId === "string" && input.deviceId.length <= 80
        ? input.deviceId
        : undefined,
    items,
    voucherCodes,
  };
}

async function assertWarehouseAccess(
  userId: string,
  warehouseId: string,
): Promise<OperatorInfo> {
  const session = await getPosAuthSession(userId);
  if (
    !session.warehouses.some((warehouse) => warehouse.id === warehouseId) ||
    !hasScopedPermission(session.permissions, "pos.sales.create", warehouseId)
  ) {
    throw new HttpsError(
      "permission-denied",
      "Bạn không có quyền tạo đơn tại điểm bán này.",
    );
  }
  return {
    employeeId: session.user.employee_id,
    firebaseUid: userId,
    name: session.user.full_name,
  };
}

async function loadAuthoritativeItems(
  itemInputs: OrderItemInput[],
  warehouseId: string,
): Promise<OrderItem[]> {
  const [luckyDrawSettings, visibilitySnapshot] = await Promise.all([
    getLuckyDrawSettingsForWarehouse(warehouseId),
    db.collection(POS_COLLECTIONS.productVisibilitySettings).doc(warehouseId).get(),
  ]);
  const visibility = visibilitySnapshot.data();
  const refs = itemInputs.map((item) =>
    db.collection(POS_COLLECTIONS.products).doc(item.goodsId),
  );
  const snapshots = await db.getAll(...refs);

  const items = snapshots.map((snapshot, index) => {
    if (!snapshot.exists) {
      throw new HttpsError(
        "failed-precondition",
        `Sản phẩm ${itemInputs[index].goodsId} không còn tồn tại.`,
      );
    }

    const product = snapshot.data();
    if (!isProductAvailableForWarehouse(snapshot.id, product || {}, visibility)) {
      throw new HttpsError(
        "failed-precondition",
        `Sản phẩm ${product?.goodsName || snapshot.id} hiện đã ngừng bán tại cửa hàng này.`,
      );
    }
    const basePrice = Number(product?.price);
    const storedAfterTaxPrice = Number(product?.afterTaxPrice);
    const price = Number.isFinite(storedAfterTaxPrice) && storedAfterTaxPrice > 0
      ? storedAfterTaxPrice
      : basePrice;
    const goodsName = product?.goodsName;
    if (
      typeof goodsName !== "string" ||
      goodsName.length === 0 ||
      !Number.isFinite(price) ||
      price < 0
    ) {
      throw new HttpsError(
        "failed-precondition",
        `Dữ liệu sản phẩm ${itemInputs[index].goodsId} không hợp lệ.`,
      );
    }

    const storedTaxRate = Number(product?.taxRate);
    const storedTaxRateType = Number(product?.taxRateType);
    const taxPricing = resolveOrderItemTaxPricing({
      basePrice,
      sellingPrice: price,
      taxRate: storedTaxRate,
      taxRateType: storedTaxRateType,
    });
    const category = Number(product?.category);
    const rawTicketsPerUnit = Number(product?.ticketsPerUnit);
    const ticketsPerUnit = category === TICKET_PRODUCT_CATEGORY &&
      Number.isInteger(rawTicketsPerUnit) &&
      rawTicketsPerUnit >= 0
      ? rawTicketsPerUnit
      : 0;
    const ticketCount = ticketsPerUnit * itemInputs[index].quantity;
    if (ticketCount > MAX_TICKETS_PER_ORDER) {
      throw new HttpsError(
        "failed-precondition",
        `Sản phẩm ${goodsName} tạo quá nhiều vé. Vui lòng giảm số lượng hoặc tách đơn.`,
      );
    }
    const luckyDrawTicketsPerUnit = resolveLuckyDrawTicketCount(
      luckyDrawSettings,
      snapshot.id,
      category,
    );

    return {
      goodsId: snapshot.id,
      goodsName,
      price,
      quantity: itemInputs[index].quantity,
      unitPriceBeforeTax: taxPricing.unitPriceBeforeTax,
      taxRate: taxPricing.taxRate,
      taxAmount: taxPricing.unitTaxAmount * itemInputs[index].quantity,
      ticketsPerUnit,
      luckyDrawTicketsPerUnit,
      ...(ticketCount > 0
        ? { ticketCodes: Array.from({ length: ticketCount }, createTicketCode) }
        : {}),
    };
  });

  const totalTicketCount = items.reduce(
    (total, item) => total + (item.ticketCodes?.length ?? 0),
    0,
  );
  if (totalTicketCount > MAX_TICKETS_PER_ORDER) {
    throw new HttpsError(
      "failed-precondition",
      `Đơn hàng vượt quá giới hạn ${MAX_TICKETS_PER_ORDER} vé. Vui lòng tách thành nhiều đơn.`,
    );
  }
  const totalLuckyDrawTickets = items.reduce(
    (total, item) => total +
      (item.luckyDrawTicketsPerUnit ?? 0) * item.quantity,
    0,
  );
  if (totalLuckyDrawTickets > MAX_LUCKY_DRAW_TICKETS_PER_ORDER) {
    throw new HttpsError(
      "failed-precondition",
      `Đơn hàng vượt quá giới hạn ${MAX_LUCKY_DRAW_TICKETS_PER_ORDER} phiếu bốc thăm. Vui lòng tách thành nhiều đơn.`,
    );
  }

  return items;
}

function calculateTotal(items: OrderItem[]): number {
  return items.reduce(
    (total, item) => total + item.price * item.quantity,
    0,
  );
}

function createDraftOrder(
  input: OrderInput,
  items: OrderItem[],
  operator: OperatorInfo,
): PosOrder {
  const now = new Date().toISOString();
  return {
    localOrderId: input.localOrderId,
    hkOrderNumber: null,
    invoiceRequestToken: createInvoiceRequestToken(),
    invoiceRequestCreatedAt: now,
    shopId: input.shopId,
    warehouseId: input.warehouseId,
    ...(input.uid ? { uid: input.uid } : {}),
    ...(input.member ? { member: input.member } : {}),
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    createdBy: operator.firebaseUid,
    operatorId: operator.employeeId,
    operatorFirebaseUid: operator.firebaseUid,
    operatorName: operator.name,
    status: "DRAFT",
    paymentMethod: "CASH",
    paymentMethodId: "CASH",
    paymentMethodName: "Tiền mặt",
    subtotalAmount: calculateTotal(items),
    discountAmount: 0,
    totalAmount: calculateTotal(items),
    ...(input.voucherCodes.length > 0
      ? { voucherCodes: input.voucherCodes }
      : {}),
    items,
    sync: {
      retryCount: 0,
      lastError: null,
      syncedAt: null,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function assertMemberAssociation(order: PosOrder, input: OrderInput): void {
  if (order.uid && input.uid && order.uid !== input.uid) {
    throw new HttpsError(
      "failed-precondition",
      "Đơn hàng đã được gắn với một thành viên khác.",
    );
  }
  if (order.member && input.member && order.member.uid !== input.member.uid) {
    throw new HttpsError(
      "failed-precondition",
      "Đơn hàng đã được gắn với một thành viên khác.",
    );
  }
}

function hasScopedPermission(
  permissions: Record<string, Record<string, unknown>>,
  permission: string,
  warehouseId: string,
): boolean {
  return (
    permissions.global?.["*"] === true ||
    permissions.global?.[permission] === true ||
    permissions[warehouseId]?.["*"] === true ||
    permissions[warehouseId]?.[permission] === true
  );
}

/**
 * Validate prices and stage an order for PayOS without marking it as paid.
 * The caller must create the PayOS link and wait for a verified payment before
 * transitioning the order from DRAFT to LOCAL_PAID.
 */
export async function stagePosOrderForPayOS(
  userId: string,
  data: unknown,
  initialSnapshot?: DocumentSnapshot,
): Promise<PosOrder> {
  const input = validateOrderInput(data);
  const docRef = db.collection(POS_COLLECTIONS.orders).doc(input.localOrderId);
  const existingSnapshot = initialSnapshot ?? await docRef.get();
  if (existingSnapshot.exists) {
    const existing = existingSnapshot.data() as PosOrder;
    if (existing.orderKind === "MEMBER_PACKAGE") {
      await assertWarehouseAccess(userId, input.warehouseId);
      return db.runTransaction(async (transaction) => {
        const freshSnapshot = await transaction.get(docRef);
        if (!freshSnapshot.exists) throw new HttpsError("not-found", "Không tìm thấy đơn bán gói.");
        const existing = freshSnapshot.data() as PosOrder;
        if (existing.createdBy !== userId) {
          throw new HttpsError(
            "permission-denied",
            "Bạn không có quyền tạo thanh toán cho đơn bán gói này.",
          );
        }
        if (
          existing.orderKind !== "MEMBER_PACKAGE" ||
          existing.status !== "DRAFT" ||
          existing.shopId !== input.shopId ||
          existing.warehouseId !== input.warehouseId ||
          existing.items.length !== 1 ||
          input.items.length !== 1 ||
          existing.items[0].goodsId !== input.items[0].goodsId ||
          input.items[0].quantity !== 1
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Đơn bán gói không còn phù hợp để tạo mã chuyển khoản.",
          );
        }
        const updatedAt = new Date().toISOString();
        transaction.update(docRef, {
          ...(input.deviceId ? { deviceId: input.deviceId } : {}),
          paymentMethod: "QR_CODE",
          paymentMethodId: "QR_CODE",
          paymentMethodName: "Chuyển khoản",
          updatedAt,
        });
        return {
          ...existing,
          ...(input.deviceId ? { deviceId: input.deviceId } : {}),
          paymentMethod: "QR_CODE",
          paymentMethodId: "QR_CODE",
          paymentMethodName: "Chuyển khoản",
          updatedAt,
        };
      });
    }
  }
  const [operator, items] = await Promise.all([
    assertWarehouseAccess(userId, input.warehouseId),
    loadAuthoritativeItems(input.items, input.warehouseId),
  ]);
  const subtotalAmount = calculateTotal(items);
  if (!Number.isSafeInteger(subtotalAmount) || subtotalAmount <= 0) {
    throw new HttpsError(
      "failed-precondition",
      "Tổng tiền thanh toán PayOS phải là số nguyên dương.",
    );
  }

  // The vouchers the committed run reserved, for the parallel-run shadow write.
  const shadow: { vouchers: AppliedVouchers | null } = { vouchers: null };
  const staged = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(docRef);
    const now = new Date().toISOString();
    const appliedVouchers = input.voucherCodes.length > 0
      ? await applyOrderVouchers(transaction, {
          voucherCodes: input.voucherCodes,
          warehouseId: input.warehouseId,
          orderId: input.localOrderId,
          userId,
          userName: operator.name,
          deviceId: input.deviceId || "unknown",
          items,
          mode: "RESERVE",
        })
      : null;
    shadow.vouchers = appliedVouchers;
    const voucherCalculation = appliedVouchers ?? {
      subtotalAmount,
      discountAmount: 0,
      totalAmount: subtotalAmount,
      vouchers: [],
    };
    if (voucherCalculation.totalAmount <= 0) {
      throw new HttpsError(
        "failed-precondition",
        "Đơn đã được voucher thanh toán đủ, không cần tạo mã chuyển khoản.",
      );
    }
    const voucherFields = voucherFieldsForOrder(voucherCalculation);

    if (!snapshot.exists) {
      const draft: PosOrder = {
        ...createDraftOrder(input, items, operator),
        paymentMethod: "QR_CODE",
        paymentMethodId: "QR_CODE",
        paymentMethodName: "Chuyển khoản",
        ...voucherFields,
        updatedAt: now,
      };
      transaction.create(docRef, draft);
      return draft;
    }

    const existing = snapshot.data() as PosOrder;
    assertMemberAssociation(existing, input);
    if (existing.createdBy !== userId) {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền tạo thanh toán cho đơn hàng này.",
      );
    }
    if (existing.status !== "DRAFT") {
      throw new HttpsError(
        "failed-precondition",
        "Đơn hàng không còn ở trạng thái chờ thanh toán.",
      );
    }

    const stagedOrder: PosOrder = {
      ...existing,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      invoiceRequestToken: isInvoiceRequestToken(existing.invoiceRequestToken)
        ? existing.invoiceRequestToken
        : createInvoiceRequestToken(),
      invoiceRequestCreatedAt:
        existing.invoiceRequestCreatedAt ?? now,
      shopId: input.shopId,
      warehouseId: input.warehouseId,
      uid: input.uid ?? existing.uid,
      member: input.member ?? existing.member,
      operatorId: operator.employeeId,
      operatorFirebaseUid: operator.firebaseUid,
      operatorName: operator.name,
      paymentMethod: "QR_CODE",
      paymentMethodId: "QR_CODE",
      paymentMethodName: "Chuyển khoản",
      ...voucherFields,
      items,
      updatedAt: now,
    };
    transaction.update(docRef, {
      ...(stagedOrder.deviceId ? { deviceId: stagedOrder.deviceId } : {}),
      shopId: stagedOrder.shopId,
      warehouseId: stagedOrder.warehouseId,
      ...(stagedOrder.uid ? { uid: stagedOrder.uid } : {}),
      ...(stagedOrder.member ? { member: stagedOrder.member } : {}),
      operatorId: stagedOrder.operatorId,
      operatorFirebaseUid: stagedOrder.operatorFirebaseUid,
      operatorName: stagedOrder.operatorName,
      invoiceRequestToken: stagedOrder.invoiceRequestToken,
      invoiceRequestCreatedAt: stagedOrder.invoiceRequestCreatedAt,
      paymentMethod: stagedOrder.paymentMethod,
      paymentMethodId: stagedOrder.paymentMethodId,
      paymentMethodName: stagedOrder.paymentMethodName,
      subtotalAmount: stagedOrder.subtotalAmount,
      discountAmount: stagedOrder.discountAmount,
      totalAmount: stagedOrder.totalAmount,
      voucherCodes: stagedOrder.voucherCodes ?? [],
      vouchers: stagedOrder.vouchers ?? [],
      items: stagedOrder.items,
      updatedAt: stagedOrder.updatedAt,
    });
    return stagedOrder;
  });

  // Parallel-run shadow write; never throws (services/shadowBackend.ts).
  await sendShadowPayment(
    "qr-stage",
    staged,
    buildShadowOrderCommand("prepare", input, items, operator, staged, shadow.vouchers),
  );
  return staged;
}

export async function preparePosOrderForUser(
  userId: string,
  data: unknown,
) {
  const input = validateOrderInput(data);
  const operator = await assertWarehouseAccess(userId, input.warehouseId);
  const items = await loadAuthoritativeItems(input.items, input.warehouseId);
  const docRef = db.collection(POS_COLLECTIONS.orders).doc(input.localOrderId);

  try {
    const order = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);
      if (snapshot.exists) {
        const existing = snapshot.data() as PosOrder;
        if (existing.createdBy !== userId) {
          throw new HttpsError(
            "permission-denied",
            "Mã đơn hàng đã thuộc về một phiên khác.",
          );
        }
        assertMemberAssociation(existing, input);
        if ((input.uid && !existing.uid) || input.member) {
          const updatedAt = new Date().toISOString();
          transaction.update(docRef, {
            ...(input.uid ? { uid: input.uid } : {}),
            ...(input.member ? { member: input.member } : {}),
            updatedAt,
          });
          return {
            ...existing,
            ...(input.uid ? { uid: input.uid } : {}),
            ...(input.member ? { member: input.member } : {}),
            updatedAt,
          };
        }
        return existing;
      }

      const draft = createDraftOrder(input, items, operator);
      transaction.create(docRef, draft);
      return draft;
    });

    // Parallel-run shadow write; never throws (services/shadowBackend.ts).
    await sendShadowOrder(
      "prepare",
      buildShadowOrderCommand("prepare", input, items, operator, order),
    );

    return {
      localOrderId: order.localOrderId,
      status: order.status,
      totalAmount: order.totalAmount,
    };
  } catch (error: unknown) {
    if (error instanceof HttpsError) throw error;
    logger.error("[preparePosOrder] Không thể tạo đơn nháp", {
      userId,
      localOrderId: input.localOrderId,
      error,
    });
    throw new HttpsError(
      "internal",
      "Không thể chuẩn bị đơn hàng trên Firebase.",
    );
  }
}

export async function checkoutPosOrderForUser(
  userId: string,
  data: unknown,
) {
  const input = validateOrderInput(data);
  const paymentMethodId = (data as Partial<CheckoutInput>).paymentMethodId;
  if (
    typeof paymentMethodId !== "string" ||
    paymentMethodId.trim().length === 0 ||
    paymentMethodId.length > 128
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Phương thức thanh toán không hợp lệ.",
    );
  }

  const selectedPaymentMethod = resolveJposPaymentMethod(
    paymentMethodId.trim(),
  );
  if (selectedPaymentMethod.id === "QR_CODE") {
    throw new HttpsError(
      "failed-precondition",
      "Thanh toán chuyển khoản phải được xác nhận qua PayOS.",
    );
  }
  const [operator, items] = await Promise.all([
    assertWarehouseAccess(userId, input.warehouseId),
    loadAuthoritativeItems(input.items, input.warehouseId),
  ]);
  const subtotalAmount = calculateTotal(items);
  const docRef = db.collection(POS_COLLECTIONS.orders).doc(input.localOrderId);

  try {
    // What the committed run wrote, for the parallel-run shadow write.
    const shadow: { vouchers: AppliedVouchers | null; paidAtomically: boolean } = {
      vouchers: null,
      paidAtomically: false,
    };
    const shouldMarkPaid = await db.runTransaction(async (transaction) => {
      shadow.vouchers = null;
      shadow.paidAtomically = false;
      const snapshot = await transaction.get(docRef);
      const now = new Date().toISOString();
      const existing = snapshot.exists ? snapshot.data() as PosOrder : null;

      if (existing) {
        if (existing.createdBy !== userId) {
          throw new HttpsError(
            "permission-denied",
            "Bạn không có quyền thanh toán đơn hàng này.",
          );
        }
        assertMemberAssociation(existing, input);
        if (existing.status !== "DRAFT") return false;
      }

      const appliedVouchers = input.voucherCodes.length > 0
        ? await applyOrderVouchers(transaction, {
            voucherCodes: input.voucherCodes,
            warehouseId: input.warehouseId,
            orderId: input.localOrderId,
            userId,
            userName: operator.name,
            deviceId: input.deviceId || "unknown",
            items,
            mode: "COMMIT",
            reservedVouchers: existing?.vouchers,
          })
        : null;
      const voucherCalculation = appliedVouchers ?? {
        subtotalAmount,
        discountAmount: 0,
        totalAmount: subtotalAmount,
        vouchers: [],
      };
      const voucherFields = voucherFieldsForOrder(voucherCalculation);
      const completesAtomically = input.voucherCodes.length > 0;
      const completionFields = completesAtomically
        ? {
            status: "LOCAL_PAID" as const,
            paymentStatus: "PAID" as const,
            syncStatus: "PENDING" as const,
            paidAt: now,
          }
        : {};
      shadow.vouchers = appliedVouchers;
      shadow.paidAtomically = completesAtomically;

      if (!existing) {
        transaction.create(docRef, {
          ...createDraftOrder(input, items, operator),
          paymentMethod: selectedPaymentMethod.id,
          paymentMethodId: selectedPaymentMethod.id,
          paymentMethodName: selectedPaymentMethod.methodName,
          ...voucherFields,
          ...completionFields,
          updatedAt: now,
        });
        return !completesAtomically;
      }

      transaction.update(docRef, {
        shopId: input.shopId,
        warehouseId: input.warehouseId,
        ...(input.uid ? { uid: input.uid } : {}),
        ...(input.member ? { member: input.member } : {}),
        operatorId: operator.employeeId,
        operatorFirebaseUid: operator.firebaseUid,
        operatorName: operator.name,
        invoiceRequestToken: isInvoiceRequestToken(existing.invoiceRequestToken)
          ? existing.invoiceRequestToken
          : createInvoiceRequestToken(),
        invoiceRequestCreatedAt:
          existing.invoiceRequestCreatedAt ?? now,
        paymentMethod: selectedPaymentMethod.id,
        paymentMethodId: selectedPaymentMethod.id,
        paymentMethodName: selectedPaymentMethod.methodName,
        ...voucherFields,
        ...completionFields,
        items,
        updatedAt: now,
      });
      return !completesAtomically;
    });

    if (shouldMarkPaid) {
      const paidAt = new Date().toISOString();
      await docRef.update({
        status: "LOCAL_PAID",
        paidAt,
        updatedAt: paidAt,
      });
    }

    const paidSnapshot = await docRef.get();
    const paidOrder = paidSnapshot.data() as PosOrder;
    if (shouldMarkPaid || shadow.paidAtomically) {
      // The order just became LOCAL_PAID: in the second update without vouchers,
      // in the transaction itself with vouchers. Parallel-run shadow write; never
      // throws (services/shadowBackend.ts).
      await sendShadowOrder(
        "checkout",
        buildShadowOrderCommand("checkout", input, items, operator, paidOrder, shadow.vouchers),
      );
    }
    return {
      localOrderId: paidOrder.localOrderId,
      hkOrderNumber: paidOrder.hkOrderNumber,
      status: paidOrder.status,
      totalAmount: paidOrder.totalAmount,
      paidAt: paidOrder.paidAt ?? null,
    };
  } catch (error: unknown) {
    if (error instanceof HttpsError) throw error;
    logger.error("[checkoutPosOrder] Thanh toán Firebase thất bại", {
      userId,
      localOrderId: input.localOrderId,
      error,
    });
    throw new HttpsError(
      "internal",
      "Không thể ghi nhận thanh toán trên Firebase.",
    );
  }
}

export async function getPosOrderStatusForUser(
  userId: string,
  data: unknown,
) {
  const localOrderId =
    data && typeof data === "object"
      ? (data as { localOrderId?: unknown }).localOrderId
      : undefined;
  if (
    typeof localOrderId !== "string" ||
    !/^ORD-\d{10,13}-[A-Z0-9]{6}$/.test(localOrderId)
  ) {
    throw new HttpsError("invalid-argument", "Mã đơn hàng không hợp lệ.");
  }

  const snapshot = await db
    .collection(POS_COLLECTIONS.orders)
    .doc(localOrderId)
    .get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Không tìm thấy đơn hàng.");
  }

  const order = snapshot.data() as PosOrder;
  if (order.createdBy !== userId) {
    throw new HttpsError(
      "permission-denied",
      "Bạn không có quyền xem đơn hàng này.",
    );
  }

  return {
    localOrderId: order.localOrderId,
    hkOrderNumber: order.hkOrderNumber,
    status: order.status,
    totalAmount: order.totalAmount,
    lastError: order.sync?.lastError ?? null,
    updatedAt: order.updatedAt,
  };
}

export async function getPosOrderForUser(
  userId: string,
  data: unknown,
) {
  const localOrderId =
    data && typeof data === "object"
      ? (data as { localOrderId?: unknown }).localOrderId
      : undefined;
  if (
    typeof localOrderId !== "string" ||
    !/^ORD-\d{10,13}-[A-Z0-9]{6}$/.test(localOrderId)
  ) {
    throw new HttpsError("invalid-argument", "Mã đơn hàng không hợp lệ.");
  }

  const [session, snapshot] = await Promise.all([
    getPosAuthSession(userId),
    db.collection(POS_COLLECTIONS.orders).doc(localOrderId).get(),
  ]);
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Không tìm thấy đơn hàng.");
  }

  const order = snapshot.data() as PosOrder;
  const warehouseIds = new Set(
    session.warehouses.map((warehouse) => warehouse.id),
  );
  // The sales screen also loads the just-created receipt through this endpoint.
  // Keep that workflow without granting historical or cross-employee access.
  const ownSaleReceipt = hasScopedPermission(session.permissions, "pos.sales.create", order.warehouseId) &&
    isOwnOrderToday(userId, order);
  if (
    !warehouseIds.has(order.warehouseId) ||
    (!canReadOrder(session.permissions, order.warehouseId, userId, order) && !ownSaleReceipt)
  ) {
    throw new HttpsError(
      "permission-denied",
      "Bạn không có quyền xem đơn hàng này.",
    );
  }

  if (isInvoiceRequestToken(order.invoiceRequestToken)) {
    return { order };
  }

  const orderWithInvoiceToken = await db.runTransaction(async (transaction) => {
    const latestSnapshot = await transaction.get(snapshot.ref);
    if (!latestSnapshot.exists) {
      throw new HttpsError("not-found", "Không tìm thấy đơn hàng.");
    }

    const latestOrder = latestSnapshot.data() as PosOrder;
    if (isInvoiceRequestToken(latestOrder.invoiceRequestToken)) {
      return latestOrder;
    }

    const invoiceRequestToken = createInvoiceRequestToken();
    const invoiceRequestCreatedAt = new Date().toISOString();
    transaction.update(latestSnapshot.ref, {
      invoiceRequestToken,
      invoiceRequestCreatedAt,
    });

    return {
      ...latestOrder,
      invoiceRequestToken,
      invoiceRequestCreatedAt,
    };
  });

  logger.info("[Biên lai] Đã bổ sung mã yêu cầu hóa đơn cho đơn cũ", {
    localOrderId,
    requestedBy: userId,
  });
  return { order: orderWithInvoiceToken };
}

async function loadAccessibleOrders(
  userId: string,
  requestedLimit: number,
): Promise<PosOrder[]> {
  const session = await getPosAuthSession(userId);
  const snapshot = await db
    .collection(POS_COLLECTIONS.orders)
    .orderBy("createdAt", "desc")
    .limit(requestedLimit)
    .get();

  return snapshot.docs
    .map((document) => document.data() as PosOrder)
    .filter(
      (order) =>
        session.warehouses.some((warehouse) => warehouse.id === order.warehouseId) &&
        ((order.createdBy === userId && order.status === "DRAFT") ||
          canReadOrder(session.permissions, order.warehouseId, userId, order)),
    );
}

async function loadAccessibleOrdersForWarehouse(
  userId: string,
  warehouseId: string,
  startAt: string,
  endAt: string,
): Promise<PosOrder[]> {
  const session = await getPosAuthSession(userId);
  const hasWarehouseAccess = session.warehouses.some(
    (warehouse) => warehouse.id === warehouseId,
  );
  if (!hasWarehouseAccess) {
    throw new HttpsError(
      "permission-denied",
      "Bạn không có quyền xem đơn hàng tại cửa hàng này.",
    );
  }
  if (!canReadOrderRange(session.permissions, warehouseId, { startAt, endAt })) {
    throw new HttpsError(
      "permission-denied",
      "Bạn không có quyền xem lịch sử đơn hàng tại cửa hàng này.",
    );
  }
  const snapshot = await db
    .collection(POS_COLLECTIONS.orders)
    .where("warehouseId", "==", warehouseId)
    .where("createdAt", ">=", startAt)
    .where("createdAt", "<", endAt)
    .orderBy("createdAt", "desc")
    .limit(5_001)
    .get();

  if (snapshot.size > 5_000) {
    throw new HttpsError(
      "resource-exhausted",
      "Ngày đã chọn có quá nhiều đơn hàng. Vui lòng liên hệ quản trị hệ thống.",
    );
  }

  return snapshot.docs
    .map((document) => document.data() as PosOrder)
    .filter((order) => order.warehouseId === warehouseId &&
      canReadOrder(session.permissions, warehouseId, userId, order));
}

export async function listPosOrdersForUser(
  userId: string,
  data: unknown,
) {
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "Ngày xem lịch sử không hợp lệ.");
  }
  const input = data as OrderListInput;
  const warehouseId =
      typeof input.warehouseId === "string"
      ? input.warehouseId.trim()
      : "";
  if (!warehouseId) {
    throw new HttpsError("invalid-argument", "Cửa hàng không hợp lệ.");
  }
  const legacyRange = input.startAt === undefined && input.endAt === undefined
    ? getCurrentVietnamDayRange()
    : null;
  const startTime = Date.parse(input.startAt ?? legacyRange?.startAt ?? "");
  const endTime = Date.parse(input.endAt ?? legacyRange?.endAt ?? "");
  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    startTime >= endTime ||
    endTime - startTime > 26 * 60 * 60 * 1000
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Chỉ có thể xem lịch sử trong một ngày hợp lệ.",
    );
  }
  const orders = await loadAccessibleOrdersForWarehouse(
    userId,
    warehouseId,
    new Date(startTime).toISOString(),
    new Date(endTime).toISOString(),
  );

  return {
    orders,
    fetchedAt: new Date().toISOString(),
  };
}

function validateCloseoutOrderListInput(data: unknown): CloseoutOrderListInput {
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "Khoảng thời gian báo cáo không hợp lệ.");
  }

  const input = data as Partial<CloseoutOrderListInput>;
  const startAt = typeof input.startAt === "string" ? input.startAt : "";
  const endAt = typeof input.endAt === "string" ? input.endAt : "";
  const warehouseId = typeof input.warehouseId === "string"
    ? input.warehouseId.trim()
    : "";
  const startTime = Date.parse(startAt);
  const endTime = Date.parse(endAt);

  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    startTime >= endTime ||
    endTime - startTime > 48 * 60 * 60 * 1000
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Báo cáo phải có thời gian bắt đầu trước thời gian kết thúc và không dài quá 48 giờ.",
    );
  }
  if (!warehouseId) {
    throw new HttpsError("invalid-argument", "Điểm bán không hợp lệ.");
  }
  if (input.purpose !== undefined && input.purpose !== "VIEW" && input.purpose !== "PRINT") {
    throw new HttpsError("invalid-argument", "Mục đích báo cáo không hợp lệ.");
  }
  if (input.scope !== "CURRENT_USER" && input.scope !== "ALL_USERS") {
    throw new HttpsError("invalid-argument", "Phạm vi tài khoản không hợp lệ.");
  }

  return {
    startAt: new Date(startTime).toISOString(),
    endAt: new Date(endTime).toISOString(),
    warehouseId,
    scope: input.scope,
    purpose: input.purpose ?? "VIEW",
  };
}

/**
 * Load every paid order in a closeout period. This intentionally uses the
 * authoritative paidAt timestamp and fails instead of silently truncating a
 * financial report.
 */
export async function listCloseoutOrdersForUser(
  userId: string,
  data: unknown,
) {
  const input = validateCloseoutOrderListInput(data);
  const session = await getPosAuthSession(userId);
  if (
    !session.warehouses.some((warehouse) => warehouse.id === input.warehouseId) ||
    !canAccessCloseout(session.permissions, input.warehouseId, input, input.purpose ?? "VIEW")
  ) {
    throw new HttpsError(
      "permission-denied",
      "Bạn không có quyền xem hoặc in báo cáo trong phạm vi đã chọn tại điểm bán này.",
    );
  }

  const snapshot = await db
    .collection(POS_COLLECTIONS.orders)
    .where("paidAt", ">=", input.startAt)
    .where("paidAt", "<", input.endAt)
    .orderBy("paidAt", "desc")
    .limit(5_001)
    .get();

  if (snapshot.size > 5_000) {
    throw new HttpsError(
      "resource-exhausted",
      "Báo cáo có quá nhiều đơn hàng. Vui lòng chia nhỏ khoảng thời gian.",
    );
  }

  const orders = snapshot.docs
    .map((document) => document.data() as PosOrder)
    .filter((order) =>
      order.warehouseId === input.warehouseId &&
      isRevenueEligibleOrder(order) &&
      (input.scope === "ALL_USERS" || order.createdBy === userId)
    );

  return {
    orders,
    fetchedAt: new Date().toISOString(),
  };
}

export async function getLatestPosOrderForUser(
  userId: string,
  data: unknown,
) {
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "Điểm bán không hợp lệ.");
  }
  const input = data as Partial<LatestOrderInput>;
  if (!Number.isInteger(input.shopId) || Number(input.shopId) <= 0) {
    throw new HttpsError("invalid-argument", "Điểm bán không hợp lệ.");
  }
  if (input.status !== undefined && input.status !== "DRAFT") {
    throw new HttpsError("invalid-argument", "Trạng thái đơn không hợp lệ.");
  }

  const orders = await loadAccessibleOrders(userId, 200);
  const order = orders.find(
    (candidate) =>
      candidate.shopId === Number(input.shopId) &&
      (!input.status || candidate.status === input.status),
  );

  return { order: order ?? null };
}

export async function retryPosOrderSyncForUser(
  userId: string,
  data: unknown,
) {
  const localOrderId =
    data && typeof data === "object"
      ? (data as { localOrderId?: unknown }).localOrderId
      : undefined;
  if (
    typeof localOrderId !== "string" ||
    !/^ORD-\d{10,13}-[A-Z0-9]{6}$/.test(localOrderId)
  ) {
    throw new HttpsError("invalid-argument", "Mã đơn hàng không hợp lệ.");
  }

  const session = await getPosAuthSession(userId);
  const warehouseIds = new Set(
    session.warehouses.map((warehouse) => warehouse.id),
  );
  const docRef = db.collection(POS_COLLECTIONS.orders).doc(localOrderId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Không tìm thấy đơn hàng.");
  }

  const order = snapshot.data() as PosOrder;
  if (
    !warehouseIds.has(order.warehouseId) ||
    !hasScopedPermission(
      session.permissions,
      "pos.orders.retry_sync",
      order.warehouseId,
    )
  ) {
    throw new HttpsError(
      "permission-denied",
      "Bạn không có quyền đồng bộ lại đơn hàng này.",
    );
  }
  if (!canQueueRemoteOrderRetry(order)) {
    return {
      localOrderId,
      status: order.status,
      queued: false,
    };
  }

  const updatedAt = new Date().toISOString();
  const queued = await db.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(docRef);
    if (!currentSnapshot.exists) return false;
    const current = currentSnapshot.data() as PosOrder;
    if (!canQueueRemoteOrderRetry(current)) return false;
    transaction.update(docRef, {
      status: "LOCAL_PAID",
      paymentStatus: current.paymentStatus ?? "PAID",
      syncStatus: "PENDING",
      syncOperationId: null,
      version: (current.version ?? 0) + 1,
      updatedAt,
      "sync.retryCount": 0,
      "sync.lastError": null,
    });
    return true;
  });
  return {
    localOrderId,
    status: queued ? "LOCAL_PAID" : order.status,
    queued,
  };
}

function isRemotePaymentConfirmed(response: {
  success: boolean;
  data: Record<string, unknown> | null;
}): boolean {
  return response.success && Number(response.data?.payStatus) === 2;
}

async function synchronizeRemoteOrder(
  docRef: DocumentReference,
  orderId: string,
): Promise<void> {
  const operationId = crypto.randomUUID();
  const order = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(docRef);
    if (!snapshot.exists) return null;
    const current = snapshot.data() as PosOrder;
    if (!canClaimRemoteOrderSync(current)) return null;
    const updatedAt = new Date().toISOString();
    const claimed: PosOrder = {
      ...current,
      status: "SYNCING",
      paymentStatus: current.paymentStatus ?? "PAID",
      syncStatus: "SYNCING",
      syncOperationId: operationId,
      version: (current.version ?? 0) + 1,
      updatedAt,
    };
    transaction.update(docRef, {
      status: claimed.status,
      paymentStatus: claimed.paymentStatus,
      syncStatus: claimed.syncStatus,
      syncOperationId: claimed.syncOperationId,
      version: claimed.version,
      updatedAt,
    });
    return claimed;
  });
  if (!order) return;

  const updateCurrentOperation = async (
    values: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>,
  ): Promise<boolean> =>
    db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);
      if (!snapshot.exists) return false;
      const current = snapshot.data() as PosOrder;
      if (current.syncOperationId !== operationId) return false;
      transaction.update(docRef, {
        ...values,
        version: (current.version ?? 0) + 1,
      });
      return true;
    });

  let hkOrderNumber = order.hkOrderNumber;
  try {
    if (!hkOrderNumber) {
      const createResponse = await createRemoteOrder({
        uid: order.uid || "",
        goodsItems: order.items.map((item) => ({
          goodsId: item.goodsId,
          quantity: String(item.quantity),
        })),
      });
      if (!createResponse.success) {
        throw new Error(
          `order_create thất bại: [${createResponse.code}] ${createResponse.msg}`,
        );
      }

      hkOrderNumber =
        typeof createResponse.data?.orderNumber === "string"
          ? createResponse.data.orderNumber
          : null;
      if (!hkOrderNumber) {
        throw new Error("order_create không trả về orderNumber.");
      }

      const retained = await updateCurrentOperation({
        hkOrderNumber,
        remoteOrderId: order.remoteOrderId ?? null,
        updatedAt: new Date().toISOString(),
      });
      if (!retained) return;
    }

    let statusResponse = order.hkOrderNumber
      ? await queryPaymentStatus({ orderNumber: hkOrderNumber })
      : null;

    if (!statusResponse || !isRemotePaymentConfirmed(statusResponse)) {
      const payResponse = await confirmRemotePayment({
        orderNumber: hkOrderNumber,
        payAmount: order.voucherCodes?.length ? order.totalAmount : null,
      });
      statusResponse = await queryPaymentStatus({
        orderNumber: hkOrderNumber,
      });

      if (
        !payResponse.success &&
        !isRemotePaymentConfirmed(statusResponse)
      ) {
        throw new Error(
          `order_pay thất bại: [${payResponse.code}] ${payResponse.msg}`,
        );
      }
    }

    if (!isRemotePaymentConfirmed(statusResponse)) {
      throw new Error(
        `order_pay_query chưa xác nhận đã thanh toán: ${statusResponse.msg}`,
      );
    }

    const syncedAt = new Date().toISOString();
    await updateCurrentOperation({
      status: "SYNC_SUCCESS",
      paymentStatus: "PAID",
      syncStatus: "SYNC_SUCCESS",
      hkOrderNumber,
      syncOperationId: operationId,
      updatedAt: syncedAt,
      sync: {
        retryCount: order.sync?.retryCount || 0,
        lastError: null,
        syncedAt,
      },
    });
    logger.info("[Đồng bộ đơn] Hoàn tất", { orderId, hkOrderNumber });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const updatedAt = new Date().toISOString();
    await updateCurrentOperation({
      status: "SYNC_FAILED",
      paymentStatus: order.paymentStatus ?? "PAID",
      syncStatus: "SYNC_FAILED",
      hkOrderNumber: hkOrderNumber || null,
      syncOperationId: operationId,
      updatedAt,
      sync: {
        retryCount: (order.sync?.retryCount || 0) + 1,
        lastError: errorMessage,
        syncedAt: null,
      },
    });
    logger.error("[Đồng bộ đơn] Thất bại, thanh toán local vẫn hợp lệ", {
      orderId,
      hkOrderNumber,
      error: errorMessage,
    });
  }
}

async function recordPosOrderAudit(
  orderId: string,
  before: PosOrder,
  after: PosOrder,
): Promise<void> {
  const initialPayment = before.status === "DRAFT";
  const auditId = initialPayment
    ? `pos-order-paid-${orderId}`
    : `pos-order-retry-${orderId}-${after.sync?.retryCount ?? 0}`;
  try {
    await db.collection("audit_logs").doc(auditId).create({
      id: auditId,
      entity_type: "POS_ORDER",
      entity_id: orderId,
      entity_name: orderId,
      warehouse_id: after.warehouseId,
      action: initialPayment ? "CREATE" : "UPDATE",
      user_id: after.createdBy,
      user_name: after.operatorName,
      action_time: new Date(after.updatedAt),
      sync_time: new Date(),
      old_value: {
        status: before.status,
        payment_method: before.paymentMethodId,
      },
      new_value: {
        status: after.status,
        payment_method: after.paymentMethodId,
        total_amount: after.totalAmount,
        payment_verification_status: after.paymentVerificationStatus ?? "VERIFIED",
      },
      ip_address: null,
      device_id: after.deviceId ?? null,
      session_token: null,
      notes: initialPayment
        ? "Completed basic JPOS checkout"
        : "Queued JPOS order synchronization retry",
    });
  } catch (error: unknown) {
    const code = (error as { code?: number | string }).code;
    if (code === 6 || code === "already-exists") return;
    throw error;
  }
}

export const onOrderLocalPaid = onDocumentWritten(
  {
    document: `${POS_COLLECTIONS.orders}/{orderId}`,
    region: "asia-southeast1",
    timeoutSeconds: 120,
  },
  async (event) => {
    if (!event.data) return;
    if (!event.data.after.exists) return;
    const after = event.data.after.data() as PosOrder;
    const before = event.data.before.exists
      ? event.data.before.data() as PosOrder
      : { ...after, status: "DRAFT" as const };
    if (!shouldSynchronizeRemoteOrder(
      before.status,
      after.status,
      after.orderKind ?? "STANDARD",
    )) {
      return;
    }

    await recordPosOrderAudit(event.params.orderId, before, after);

    const docRef = db
      .collection(POS_COLLECTIONS.orders)
      .doc(event.params.orderId);
    await synchronizeRemoteOrder(docRef, event.params.orderId);
  },
);

export const retryFailedOrderSyncs = onSchedule(
  {
    schedule: "every 5 minutes",
    region: "asia-southeast1",
    timeoutSeconds: 120,
  },
  async () => {
    const snapshot = await db
      .collection(POS_COLLECTIONS.orders)
      .where("status", "==", "SYNC_FAILED")
      .where("sync.retryCount", "<", 5)
      .limit(50)
      .get();

    if (snapshot.empty) return;

    let queuedCount = 0;
    for (const document of snapshot.docs) {
      const queued = await db.runTransaction(async (transaction) => {
        const currentSnapshot = await transaction.get(document.ref);
        if (!currentSnapshot.exists) return false;
        const order = currentSnapshot.data() as PosOrder;
        if (!canQueueRemoteOrderRetry(order)) return false;
        transaction.update(document.ref, {
          status: "LOCAL_PAID",
          paymentStatus: order.paymentStatus ?? "PAID",
          syncStatus: "PENDING",
          syncOperationId: null,
          version: (order.version ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        });
        return true;
      });
      if (queued) queuedCount += 1;
    }
    if (queuedCount === 0) return;
    logger.info("[Đồng bộ đơn] Đã xếp lại đơn lỗi", {
      count: queuedCount,
    });
  },
);
