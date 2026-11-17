import type { DocumentReference } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../config/firebase";
import { POS_COLLECTIONS } from "../config/collections";
import {
  confirmRemotePayment,
  createRemoteOrder,
  queryPaymentStatus,
  type HKApiResponse,
} from "../services/hkApiService";
import {
  loadRemoteMemberPackage,
  loadRemoteMemberPackages,
} from "../services/memberPackageService";
import { getPosAuthSession } from "../services/posAuthService";
import type { MemberPointPackage } from "../types/member";
import type { PosOrder } from "../types/order";
import { MemberRemoteApiError } from "./functions";
import {
  validateMemberPackageCatalogInput,
  validateMemberPackageOrderId,
  validateMemberPackageSaleInput,
  type MemberPackageSaleInput,
} from "./packagePolicy";
import { getLuckyDrawSettingsForWarehouse } from "../luckyDraw/luckyDrawSettingsFunctions";
import { resolveLuckyDrawTicketCount } from "../luckyDraw/luckyDrawSettingsPolicy";
import {
  sendShadowPackage,
  shadowRemoteError,
  shadowRemoteResponse,
  type ShadowRemoteAction,
  type ShadowRemoteCall,
} from "../services/shadowBackend";
import { runShadowedTransaction } from "../services/shadowTransaction";

interface OperatorInfo {
  employeeId: string;
  firebaseUid: string;
  name: string;
}

async function assertWarehouseAccess(
  userId: string,
  warehouseId: string,
): Promise<OperatorInfo> {
  const session = await getPosAuthSession(userId);
  if (!session.warehouses.some((warehouse) => warehouse.id === warehouseId)) {
    throw new HttpsError(
      "permission-denied",
      "Bạn không có quyền bán gói tại điểm bán này.",
    );
  }
  return {
    employeeId: session.user.employee_id,
    firebaseUid: userId,
    name: session.user.full_name,
  };
}

function createPackageDraft(
  input: MemberPackageSaleInput,
  selectedPackage: MemberPointPackage,
  operator: OperatorInfo,
  luckyDrawTicketsPerUnit: number,
): PosOrder {
  const now = new Date().toISOString();
  const unitTaxAmount = selectedPackage.taxRateType === 2
    ? Math.min(selectedPackage.paymentAmountVnd, selectedPackage.taxRate)
    : selectedPackage.taxRate > 0
      ? selectedPackage.paymentAmountVnd -
        selectedPackage.paymentAmountVnd / (1 + selectedPackage.taxRate / 100)
      : 0;
  const effectiveTaxRate = selectedPackage.taxRateType === 2 &&
    selectedPackage.paymentAmountVnd > unitTaxAmount
    ? (unitTaxAmount /
      (selectedPackage.paymentAmountVnd - unitTaxAmount)) * 100
    : selectedPackage.taxRate;
  return {
    localOrderId: input.localOrderId,
    hkOrderNumber: null,
    shopId: input.shopId,
    warehouseId: input.warehouseId,
    createdBy: operator.firebaseUid,
    operatorId: operator.employeeId,
    operatorFirebaseUid: operator.firebaseUid,
    operatorName: operator.name,
    orderKind: "MEMBER_PACKAGE",
    uid: input.uid,
    member: input.member,
    status: "DRAFT",
    paymentMethod: "CASH",
    paymentMethodId: "CASH",
    paymentMethodName: "Tiền mặt",
    totalAmount: selectedPackage.paymentAmountVnd,
    items: [{
      goodsId: selectedPackage.goodsId,
      goodsName: selectedPackage.name,
      price: selectedPackage.paymentAmountVnd,
      quantity: 1,
      unitPriceBeforeTax: Math.round(
        selectedPackage.paymentAmountVnd - unitTaxAmount,
      ),
      taxRate: Number(effectiveTaxRate.toFixed(4)),
      taxAmount: Math.round(unitTaxAmount),
      luckyDrawTicketsPerUnit,
    }],
    sync: { retryCount: 0, lastError: null, syncedAt: null },
    createdAt: now,
    updatedAt: now,
  };
}

function assertSamePackageOrder(
  order: PosOrder,
  input: MemberPackageSaleInput,
): void {
  if (
    order.orderKind !== "MEMBER_PACKAGE" ||
    order.uid !== input.uid ||
    order.shopId !== input.shopId ||
    order.warehouseId !== input.warehouseId ||
    order.items.length !== 1 ||
    order.items[0].goodsId !== input.goodsId
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Mã đơn đã được dùng cho một giao dịch khác.",
    );
  }
}

export async function listMemberPackagesForUser(userId: string, data: unknown) {
  const input = validateMemberPackageCatalogInput(data);
  await assertWarehouseAccess(userId, input.warehouseId);
  const packages = await loadRemoteMemberPackages(input.uid);
  return { packages, fetchedAt: new Date().toISOString() };
}

export async function prepareMemberPackageOrderForUser(
  userId: string,
  data: unknown,
) {
  const input = validateMemberPackageSaleInput(data);
  const [operator, selectedPackage, luckyDrawSettings] = await Promise.all([
    assertWarehouseAccess(userId, input.warehouseId),
    loadRemoteMemberPackage(input.uid, input.goodsId),
    getLuckyDrawSettingsForWarehouse(input.warehouseId),
  ]);
  if (
    !Number.isSafeInteger(selectedPackage.paymentAmountVnd) ||
    selectedPackage.paymentAmountVnd <= 0
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Giá gói từ OpenAPI không hợp lệ để thanh toán.",
    );
  }

  const docRef = db.collection(POS_COLLECTIONS.orders).doc(input.localOrderId);
  const luckyDrawTicketsPerUnit = resolveLuckyDrawTicketCount(
    luckyDrawSettings,
    selectedPackage.goodsId,
    selectedPackage.category,
  );
  // The shadow command of this write: the input, the package as 鲸舰 returned it
  // and the lucky-draw count as looked up; the backend prices the line itself.
  const shadowValues = (updatedAt: string) => ({
    shopId: input.shopId,
    uid: input.uid,
    member: input.member,
    goodsId: input.goodsId,
    operator,
    package: {
      goodsId: selectedPackage.goodsId,
      name: selectedPackage.name,
      paymentAmountVnd: selectedPackage.paymentAmountVnd,
      taxRate: selectedPackage.taxRate,
      taxRateType: selectedPackage.taxRateType,
    },
    luckyDrawTicketsPerUnit,
    updatedAt,
  });
  const order = await runShadowedTransaction("package-prepare", async (transaction, recordShadow) => {
    const snapshot = await transaction.get(docRef);
    if (snapshot.exists) {
      const existing = snapshot.data() as PosOrder;
      if (existing.createdBy !== userId) {
        throw new HttpsError(
          "permission-denied",
          "Bạn không có quyền sử dụng đơn bán gói này.",
        );
      }
      assertSamePackageOrder(existing, input);
      if (!existing.member || existing.items[0].luckyDrawTicketsPerUnit === undefined) {
        const updatedAt = new Date().toISOString();
        const items = existing.items.map((item, index) => index === 0
          ? { ...item, luckyDrawTicketsPerUnit }
          : item);
        transaction.update(docRef, {
          member: input.member,
          items,
          updatedAt,
        });
        recordShadow(existing, shadowValues(updatedAt));
        return { ...existing, member: input.member, items, updatedAt };
      }
      return existing;
    }
    const draft = createPackageDraft(
      input,
      selectedPackage,
      operator,
      luckyDrawTicketsPerUnit,
    );
    transaction.create(docRef, draft);
    recordShadow(
      { localOrderId: input.localOrderId, warehouseId: input.warehouseId },
      shadowValues(draft.updatedAt),
    );
    return draft;
  });

  return {
    localOrderId: order.localOrderId,
    status: order.status,
    totalAmount: order.totalAmount,
    selectedPackage,
  };
}

function isPaid(response: HKApiResponse): boolean {
  return response.success && Number(response.data?.payStatus) === 2;
}

async function callRemote<T>(
  action: string,
  request: () => Promise<HKApiResponse<T>>,
): Promise<HKApiResponse<T>> {
  try {
    return await request();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "Không rõ nguyên nhân";
    throw new MemberRemoteApiError(
      action,
      null,
      `Không thể kết nối OpenAPI: ${reason}`,
    );
  }
}

async function markSyncFailed(
  docRef: DocumentReference,
  order: PosOrder,
  reason: string,
  hkOrderNumber: string | null,
): Promise<string> {
  const updatedAt = new Date().toISOString();
  await docRef.update({
    status: "SYNC_FAILED",
    hkOrderNumber,
    updatedAt,
    sync: {
      retryCount: (order.sync?.retryCount || 0) + 1,
      lastError: reason,
      syncedAt: null,
    },
  });
  return updatedAt;
}

async function finalizeMemberPackageOrder(
  userId: string,
  localOrderId: string,
) {
  const docRef = db.collection(POS_COLLECTIONS.orders).doc(localOrderId);
  const [session, snapshot] = await Promise.all([
    getPosAuthSession(userId),
    docRef.get(),
  ]);
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Không tìm thấy đơn bán gói thành viên.");
  }
  const order = snapshot.data() as PosOrder;
  const canAccess = order.createdBy === userId || session.warehouses.some(
    (warehouse) => warehouse.id === order.warehouseId,
  );
  if (!canAccess) {
    throw new HttpsError("permission-denied", "Bạn không có quyền xử lý đơn này.");
  }
  if (order.orderKind !== "MEMBER_PACKAGE" || !order.uid) {
    throw new HttpsError("failed-precondition", "Đây không phải đơn gói thành viên.");
  }
  if (order.status === "SYNC_SUCCESS") {
    return {
      localOrderId,
      remoteOrderNumber: order.hkOrderNumber,
      status: order.status,
      completedAt: order.sync.syncedAt,
    };
  }
  if (order.status === "DRAFT") {
    throw new HttpsError(
      "failed-precondition",
      "Đơn chưa được xác nhận thanh toán tại POS.",
    );
  }
  if (order.status === "SYNCING") {
    throw new HttpsError(
      "aborted",
      "OpenAPI đang xử lý đơn. Vui lòng chờ và kiểm tra lại.",
    );
  }

  // Shadow commands of the writes below, each ordered by the updatedAt of the
  // write before it. `remoteCalls` is what each 鲸舰 call of this run answered:
  // the backend replays the decisions on it.
  let lastUpdatedAt: string | null | undefined = order.updatedAt;
  const sendShadow = async (
    operation: "package-sync-start" | "package-remote-order" | "package-sync-finish",
    updatedAt: string,
    values: Record<string, unknown> = {},
  ): Promise<void> => {
    const before = { localOrderId, warehouseId: order.warehouseId, updatedAt: lastUpdatedAt };
    lastUpdatedAt = updatedAt;
    await sendShadowPackage(operation, before, { ...values, updatedAt });
  };
  const remoteCalls: ShadowRemoteCall[] = [];
  const recorded = async <T>(
    action: ShadowRemoteAction,
    pending: Promise<HKApiResponse<T>>,
  ): Promise<HKApiResponse<T>> => {
    try {
      const response = await pending;
      remoteCalls.push(shadowRemoteResponse(action, response, true));
      return response;
    } catch (error: unknown) {
      remoteCalls.push(shadowRemoteError(action, error, "Không rõ nguyên nhân"));
      throw error;
    }
  };

  const startedAt = new Date().toISOString();
  await docRef.update({ status: "SYNCING", updatedAt: startedAt });
  await sendShadow("package-sync-start", startedAt);
  let hkOrderNumber = order.hkOrderNumber;
  let currentAction = "order_create";
  try {
    if (!hkOrderNumber) {
      const createResponse = await callRemote(
        "order_create",
        () => recorded("order_create", createRemoteOrder({
          uid: order.uid!,
          goodsItems: order.items.map((item) => ({
            goodsId: item.goodsId,
            quantity: String(item.quantity),
          })),
        })),
      );
      hkOrderNumber = typeof createResponse.data?.orderNumber === "string"
        ? createResponse.data.orderNumber
        : null;
      if (!createResponse.success || !hkOrderNumber) {
        throw new MemberRemoteApiError(
          "order_create",
          createResponse.code,
          createResponse.msg || "OpenAPI không thể tạo đơn bán gói.",
        );
      }
      const remoteActualPayment = Number(createResponse.data?.actualPayment);
      const numberedAt = new Date().toISOString();
      await docRef.update({
        hkOrderNumber,
        remoteActualPayment: Number.isFinite(remoteActualPayment)
          ? remoteActualPayment
          : null,
        updatedAt: numberedAt,
      });
      await sendShadow("package-remote-order", numberedAt, { remote: [...remoteCalls] });
      if (
        !Number.isFinite(remoteActualPayment) ||
        remoteActualPayment !== order.totalAmount
      ) {
        throw new MemberRemoteApiError(
          "order_create",
          createResponse.code,
          "Số tiền đơn OpenAPI không khớp số tiền khách đã thanh toán. " +
            "Đơn đã dừng trước bước order_pay để đối soát.",
        );
      }
    }

    if (
      order.remoteActualPayment !== undefined &&
      order.remoteActualPayment !== order.totalAmount
    ) {
      throw new MemberRemoteApiError(
        "order_create",
        null,
        "Số tiền đơn OpenAPI không khớp số tiền đã thu. Cần đối soát trước khi thử lại.",
      );
    }

    currentAction = "order_pay_query";
    let statusResponse = await callRemote(
      "order_pay_query",
      () => recorded("order_pay_query", queryPaymentStatus({ orderNumber: hkOrderNumber! })),
    );
    if (!isPaid(statusResponse)) {
      currentAction = "order_pay";
      const payResponse = await callRemote(
        "order_pay",
        () => recorded("order_pay", confirmRemotePayment({ orderNumber: hkOrderNumber! })),
      );
      currentAction = "order_pay_query";
      statusResponse = await callRemote(
        "order_pay_query",
        () => recorded("order_pay_query", queryPaymentStatus({ orderNumber: hkOrderNumber! })),
      );
      if (!payResponse.success && !isPaid(statusResponse)) {
        throw new MemberRemoteApiError(
          "order_pay",
          payResponse.code,
          payResponse.msg || "OpenAPI không thể thanh toán đơn bán gói.",
        );
      }
    }
    if (!isPaid(statusResponse)) {
      throw new MemberRemoteApiError(
        "order_pay_query",
        statusResponse.code,
        statusResponse.data?.payStatusDesc?.toString() ||
          statusResponse.msg ||
          "OpenAPI chưa xác nhận đơn đã thanh toán.",
      );
    }

    const completedAt = new Date().toISOString();
    await docRef.update({
      status: "SYNC_SUCCESS",
      hkOrderNumber,
      updatedAt: completedAt,
      sync: {
        retryCount: order.sync?.retryCount || 0,
        lastError: null,
        syncedAt: completedAt,
      },
    });
    await sendShadow("package-sync-finish", completedAt, { remote: [...remoteCalls] });
    return {
      localOrderId,
      remoteOrderNumber: hkOrderNumber,
      status: "SYNC_SUCCESS" as const,
      completedAt,
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "OpenAPI xử lý thất bại.";
    const failedAt = await markSyncFailed(docRef, order, reason, hkOrderNumber);
    await sendShadow("package-sync-finish", failedAt, { remote: [...remoteCalls] });
    if (error instanceof MemberRemoteApiError) throw error;
    throw new MemberRemoteApiError(currentAction, null, reason);
  }
}

export async function sellMemberPackageForCashForUser(
  userId: string,
  data: unknown,
) {
  const input = validateMemberPackageSaleInput(data);
  await prepareMemberPackageOrderForUser(userId, input);
  const docRef = db.collection(POS_COLLECTIONS.orders).doc(input.localOrderId);
  await runShadowedTransaction("package-cash", async (transaction, recordShadow) => {
    const snapshot = await transaction.get(docRef);
    const order = snapshot.data() as PosOrder;
    if (order.status !== "DRAFT") return;
    const paidAt = new Date().toISOString();
    transaction.update(docRef, {
      status: "LOCAL_PAID",
      paymentMethod: "CASH",
      paymentMethodId: "CASH",
      paymentMethodName: "Tiền mặt",
      paidAt,
      updatedAt: paidAt,
    });
    recordShadow(order, { updatedAt: paidAt });
  });
  return finalizeMemberPackageOrder(userId, input.localOrderId);
}

export async function finalizeMemberPackageSaleForUser(
  userId: string,
  data: unknown,
) {
  return finalizeMemberPackageOrder(
    userId,
    validateMemberPackageOrderId(data),
  );
}
