import { fetchMemberProfileHistoryForUser, updateMemberProfileSyncRetryForUser } from "../services/memberProfileEditService";
import { searchMemberPhonesForUser } from "../services/memberPhoneSearchService";
import { detectPartnerCardRecovery, previewPartnerCardRecovery, confirmPartnerCardRecovery, fetchPartnerCardRecovery } from "../services/partnerCardRecoveryService";
import { previewMemberCardReturnForUser, createMemberCardReturnJobForUser, fetchMemberCardReturnJobForUser, controlMemberCardReturnJobForUser } from "../services/memberCardReturnService";
import * as logger from "firebase-functions/logger";
import { randomUUID } from "crypto";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  getPosAuthSession as loadPosAuthSession,
  PosAuthDomainError,
  resolvePosLoginEmail,
} from "../services/posAuthService";
import {
  loadPosProductCatalog,
  synchronizePosProducts,
} from "../services/productSyncService";
import {
  joyworldPassSecret,
  joyworldUserSecret,
} from "../services/joyworldCatalogService";
import { shadowBackendKeySecret } from "../services/shadowBackend";
import {
  checkoutPosOrderForUser,
  getLatestPosOrderForUser,
  listCloseoutOrdersForUser,
  getPosOrderForUser,
  getPosOrderStatusForUser,
  listPosOrdersForUser,
  preparePosOrderForUser,
  retryPosOrderSyncForUser,
} from "../order/functions";
import { assertActivePosDevice } from "../services/posDeviceAccessService";
import { resolveVoucherForCart } from "../services/voucherService";
import {
  listPosMemberCardsForUser,
  listPosMemberPassTicketsForUser,
  listPosMemberStoredValueHistoryForUser,
  lookupPosMemberForUser,
  registerPosMemberForUser,
  resumePosMemberRegistrationForUser,
  updatePosMemberProfileForUser,
} from "../member/functions";
import { compensatePosMemberForUser } from "../member/compensation";
import { listMemberRenewalBatchesForUser, renewMemberStoredValueForUser } from "../services/memberRenewalService";
import {
  finalizeMemberPackageSaleForUser,
  listMemberPackagesForUser,
  prepareMemberPackageOrderForUser,
  sellMemberPackageForCashForUser,
} from "../member/packageFunctions";
import { throwMemberCallableError } from "../member/callable";
import {
  checkMemberCardForIssueForUser,
  confirmMemberCardIssueForUser,
  getMemberCardIssueInfoForUser,
} from "../services/joyworldMemberCardService";
import {
  getLuckyDrawSettingsForUser,
  saveLuckyDrawSettingsForUser,
} from "../luckyDraw/luckyDrawSettingsFunctions";
const CALLABLE_OPTIONS = {
  region: "asia-southeast1",
  cors: true,
  timeoutSeconds: 300,
  maxInstances: 20,
  secrets: [joyworldUserSecret, joyworldPassSecret],
};

export const resolvePosLoginIdentifier = onCall(
  CALLABLE_OPTIONS,
  async (request) => {
    await assertActivePosDevice(request.data);
    const identifier = request.data?.identifier;
    if (
      typeof identifier !== "string" ||
      identifier.trim().length === 0 ||
      identifier.length > 160
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Thông tin đăng nhập không hợp lệ.",
      );
    }

    try {
      const email = await resolvePosLoginEmail(identifier);
      if (!email) {
        throw new HttpsError(
          "not-found",
          "Thông tin đăng nhập không chính xác.",
        );
      }
      return { email };
    } catch (error: unknown) {
      if (error instanceof HttpsError) throw error;
      logger.error("[resolvePosLoginIdentifier] Failed", error);
      throw new HttpsError(
        "internal",
        "Không thể xử lý yêu cầu đăng nhập.",
      );
    }
  },
);

// Order preparation and checkout also send shadow writes (services/shadowBackend.ts).
const POS_SESSION_OPTIONS = {
  ...CALLABLE_OPTIONS,
  secrets: [...CALLABLE_OPTIONS.secrets, shadowBackendKeySecret],
};

export const getPosAuthSession = onCall(
  POS_SESSION_OPTIONS,
  async (request) => {
    const device = await assertActivePosDevice(request.data);
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Bạn phải đăng nhập để xác minh phiên POS.",
      );
    }

    const action = request.data?.action;
    const requestedWarehouseId = request.data?.payload?.warehouseId;
    if (
      typeof requestedWarehouseId === "string" &&
      requestedWarehouseId !== device.warehouseId
    ) {
      throw new HttpsError(
        "permission-denied",
        "Máy POS không được phép thao tác tại cửa hàng này.",
      );
    }
    if (
      action === "lookupMember" ||
      action === "previewPartnerCardRecovery" || action === "confirmPartnerCardRecovery" || action === "fetchPartnerCardRecovery" ||
      action === "detectPartnerCardRecovery" ||
      action === "previewMemberCardReturn" || action === "createMemberCardReturnJob" || action === "fetchMemberCardReturnJob" || action === "controlMemberCardReturnJob" ||
      action === "searchMemberPhones" ||
      action === "resumeMemberRegistration" ||
      action === "registerMember" ||
      action === "updateMemberProfile" ||
      action === "updateMemberProfileLocal" ||
      action === "fetchMemberProfileHistory" ||
      action === "updateMemberProfileSyncRetry" ||
      action === "getMemberStoredValueHistory" ||
      action === "getMemberCards" ||
      action === "getMemberPassTickets" ||
      action === "getMemberCardIssueInfo" ||
      action === "checkMemberCardForIssue" ||
      action === "confirmMemberCardIssue" ||
      action === "compensateMemberBalance" ||
      action === "getMemberRenewalBatches" ||
      action === "renewMemberStoredValue" ||
      action === "getMemberPackages" ||
      action === "prepareMemberPackageOrder" ||
      action === "sellMemberPackageCash" ||
      action === "finalizeMemberPackageSale"
    ) {
      try {
        if(action==="previewPartnerCardRecovery")return await previewPartnerCardRecovery(request.auth.uid,request.data?.payload);
        if(action==="detectPartnerCardRecovery")return await detectPartnerCardRecovery(request.auth.uid,request.data?.payload);
        if(action==="confirmPartnerCardRecovery")return await confirmPartnerCardRecovery(request.auth.uid,request.data?.payload,device.id);
        if(action==="fetchPartnerCardRecovery")return await fetchPartnerCardRecovery(request.auth.uid,request.data?.payload);
        if(action==="previewMemberCardReturn")return await previewMemberCardReturnForUser(request.auth.uid,request.data?.payload);
        if(action==="createMemberCardReturnJob")return await createMemberCardReturnJobForUser(request.auth.uid,request.data?.payload,device.id);
        if(action==="fetchMemberCardReturnJob")return await fetchMemberCardReturnJobForUser(request.auth.uid,request.data?.payload);
        if(action==="controlMemberCardReturnJob")return await controlMemberCardReturnJobForUser(request.auth.uid,request.data?.payload);
        if (action === "getMemberRenewalBatches") return await listMemberRenewalBatchesForUser(request.auth.uid, request.data?.payload, device.id);
        if (action === "renewMemberStoredValue") return await renewMemberStoredValueForUser(request.auth.uid, request.data?.payload, device.id);
        if (action === "searchMemberPhones") return await searchMemberPhonesForUser(request.auth.uid, request.data?.payload);
        if (action === "resumeMemberRegistration") return await resumePosMemberRegistrationForUser(request.auth.uid, request.data?.payload);
        if (action === "fetchMemberProfileHistory") return await fetchMemberProfileHistoryForUser(request.auth.uid, request.data?.payload);
        if (action === "updateMemberProfileSyncRetry") return await updateMemberProfileSyncRetryForUser(request.auth.uid, request.data?.payload);
        if (action === "lookupMember") {
          return await lookupPosMemberForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "registerMember") {
          return await registerPosMemberForUser(
            request.auth.uid,
            request.data?.payload,
            device.id,
          );
        }
        if (action === "getMemberStoredValueHistory") {
          return await listPosMemberStoredValueHistoryForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "getMemberCards") {
          return await listPosMemberCardsForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "getMemberPassTickets") {
          return await listPosMemberPassTicketsForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "getMemberCardIssueInfo") {
          return await getMemberCardIssueInfoForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "checkMemberCardForIssue") {
          return await checkMemberCardForIssueForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "confirmMemberCardIssue") {
          return await confirmMemberCardIssueForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "compensateMemberBalance") {
          return await compensatePosMemberForUser(
            request.auth.uid,
            request.data?.payload,
            device.id,
          );
        }
        if (action === "getMemberPackages") {
          return await listMemberPackagesForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "prepareMemberPackageOrder") {
          return await prepareMemberPackageOrderForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "sellMemberPackageCash") {
          return await sellMemberPackageForCashForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "finalizeMemberPackageSale") {
          return await finalizeMemberPackageSaleForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        return await updatePosMemberProfileForUser(
          request.auth.uid,
          request.data?.payload,
          device.id,
        );
      } catch (error: unknown) {
        return throwMemberCallableError(
          error,
          `getPosAuthSession:${action}`,
          request.auth.uid,
        );
      }
    }

    if (
      action === "prepareOrder" ||
      action === "checkoutOrder" ||
      action === "getOrder" ||
      action === "getOrderStatus" ||
      action === "getOrders" ||
      action === "getCloseoutOrders" ||
      action === "getLatestOrder" ||
      action === "resolveVoucher" ||
      action === "retryOrderSync"
    ) {
      try {
        if (action === "prepareOrder") {
          return await preparePosOrderForUser(
            request.auth.uid,
            { ...request.data?.payload, deviceId: device.id },
          );
        }
        if (action === "checkoutOrder") {
          return await checkoutPosOrderForUser(
            request.auth.uid,
            { ...request.data?.payload, deviceId: device.id },
          );
        }
        if (action === "getOrders") {
          return await listPosOrdersForUser(
            request.auth.uid,
            {
              ...request.data?.payload,
              warehouseId: device.warehouseId,
            },
          );
        }
        if (action === "resolveVoucher") {
          return await resolveVoucherForCart(
            request.data?.payload?.code,
            device.warehouseId,
          );
        }
        if (action === "getCloseoutOrders") {
          return await listCloseoutOrdersForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "getLatestOrder") {
          return await getLatestPosOrderForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "retryOrderSync") {
          return await retryPosOrderSyncForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        if (action === "getOrder") {
          return await getPosOrderForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        return await getPosOrderStatusForUser(
          request.auth.uid,
          request.data?.payload,
        );
      } catch (error: unknown) {
        if (error instanceof HttpsError) throw error;
        logger.error("[getPosAuthSession] Xử lý đơn hàng thất bại", {
          uid: request.auth.uid,
          action,
          error,
        });
        throw new HttpsError(
          "internal",
          "Không thể xử lý đơn hàng. Vui lòng thử lại.",
        );
      }
    }

    if (action === "getProducts") {
      try {
        return await loadPosProductCatalog();
      } catch (error: unknown) {
        logger.error("[getPosAuthSession] Product catalog load failed", {
          uid: request.auth.uid,
          error,
        });
        throw new HttpsError(
          "internal",
          "Không thể tải danh sách sản phẩm POS.",
        );
      }
    }

    if (
      action === "getLuckyDrawSettings" ||
      action === "saveLuckyDrawSettings"
    ) {
      try {
        if (action === "getLuckyDrawSettings") {
          return await getLuckyDrawSettingsForUser(
            request.auth.uid,
            request.data?.payload,
          );
        }
        return await saveLuckyDrawSettingsForUser(
          request.auth.uid,
          request.data?.payload,
        );
      } catch (error: unknown) {
        if (error instanceof HttpsError) throw error;
        logger.error("[getPosAuthSession] Lucky-draw settings failed", {
          uid: request.auth.uid,
          action,
          error,
        });
        throw new HttpsError(
          "internal",
          "Không thể xử lý cấu hình phiếu bốc thăm.",
        );
      }
    }

    if (action === "syncProducts") {
      try {
        return await synchronizePosProducts({
          actorId: request.auth.uid,
          actionTime: new Date().toISOString(),
          requestId: randomUUID(),
          source: "JPOS",
          warehouseId: device.warehouseId,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        logger.error("[getPosAuthSession] Product synchronization failed", {
          uid: request.auth.uid,
          errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined,
        });
        throw new HttpsError(
          "internal",
          "Đồng bộ sản phẩm thất bại. Vui lòng thử lại.",
        );
      }
    }

    if (typeof action === "string") {
      throw new HttpsError(
        "invalid-argument",
        `Chức năng ${action} chưa được hỗ trợ trên phiên bản máy chủ này.`,
      );
    }

    try {
      return await loadPosAuthSession(request.auth.uid, device.warehouseId);
    } catch (error: unknown) {
      if (error instanceof PosAuthDomainError) {
        if (error.code === "USER_NOT_FOUND") {
          throw new HttpsError("not-found", "Không tìm thấy hồ sơ người dùng.");
        }
        if (error.code === "USER_ACCOUNT_NOT_ACTIVE") {
          throw new HttpsError(
            "permission-denied",
            "Tài khoản đã bị vô hiệu hóa hoặc tạm khóa.",
          );
        }
        throw new HttpsError(
          "failed-precondition",
          "Hồ sơ người dùng không đúng định dạng của bduck-system.",
        );
      }

      logger.error("[getPosAuthSession] Failed", {
        uid: request.auth.uid,
        error,
      });
      throw new HttpsError(
        "internal",
        "Không thể xác minh phiên đăng nhập POS.",
      );
    }
  },
);
