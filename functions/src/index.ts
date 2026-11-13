export { onMemberProfileChange, retryMemberProfileChanges } from "./member/profileSyncWorker";
export { onMemberImportCacheChanged } from "./member/memberImportJobs";
export { onMemberRegistrationCreated, recoverMemberRegistration } from "./member/registrationRecoveryWorker";
export { onMemberCardReturnJob, processMemberCardReturnJob } from "./member/cardReturnWorker";
export { deliverShadowCommand } from "./order/shadowDeliveryWorker";
export { onPartnerCardRecovery } from "./member/partnerCardRecoveryWorker";
// =============================================================================
// Firebase Cloud Functions — POS Sync Worker
// =============================================================================

export {
  getPosAuthSession,
  resolvePosLoginIdentifier,
} from "./auth/functions";
export {
  onOrderLocalPaid,
  retryFailedOrderSyncs,
} from "./order/functions";
export { onPosOrderSummaryChanged } from "./order/orderSummary";
export { payosWebhook } from "./payment/payosWebhook";
export { payosPayment } from "./payment/payosCallable";
export { reconcilePendingPayOSPayments } from "./payment/payosReconciliation";

import * as logger from "firebase-functions/logger";
import { randomUUID } from "crypto";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  joyworldPassSecret,
  joyworldUserSecret,
} from "./services/joyworldCatalogService";
import { assertActivePosDevice } from "./services/posDeviceAccessService";
import {
  loadPosProductCatalog,
  synchronizePosProducts,
} from "./services/productSyncService";
export { syncProductsFromJpulse } from "./services/jpulseProductSyncFunction";

// =============================================================================
// getPosProducts — authenticated, read-only product catalog
// =============================================================================

export const getPosProducts = onCall(
  { region: "asia-southeast1", cors: true },
  async (request) => {
    await assertActivePosDevice(request.data);
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Bạn phải đăng nhập để tải danh sách sản phẩm.",
      );
    }

    return loadPosProductCatalog();
  },
);

// =============================================================================
// syncProducts — compatibility callable using the canonical sync service
// =============================================================================

export const syncProducts = onCall(
  {
    region: "asia-southeast1",
    cors: true,
    secrets: [joyworldUserSecret, joyworldPassSecret],
  },
  async (request) => {
    const device = await assertActivePosDevice(request.data);
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Bạn phải đăng nhập để đồng bộ sản phẩm.",
      );
    }

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
      logger.error("[syncProducts] Product synchronization failed", {
        uid: request.auth.uid,
        errorMessage,
        errorStack: error instanceof Error ? error.stack : undefined,
      });
      throw new HttpsError(
        "internal",
        "Đồng bộ sản phẩm thất bại. Vui lòng thử lại.",
      );
    }
  },
);
