import * as logger from "firebase-functions/logger";
import { withPosRequestContext } from "../services/posRequestContext";
import { createPaymentWatch } from "./paymentStatusProjection";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  payosApiKeySecret,
  payosChecksumKeySecret,
  payosClientIdSecret,
} from "../services/payosService";
import { shadowStoreTokensSecret } from "../services/shadowBackend";
import {
  cancelPayOSPaymentForUser,
  confirmPayOSPaymentManuallyForUser,
  createPayOSPaymentForUser,
  getPayOSPaymentStatusForUser,
  handlePayOSPaymentTimeoutForUser,
  recreatePayOSPaymentForUser,
  resumePayOSPaymentForUser,
} from "./payosFunctions";
import {
  getFixedTransferSettingsForUser,
  saveFixedTransferSettingsForUser,
} from "./fixedTransferFunctions";
import { assertActivePosDevice } from "../services/posDeviceAccessService";
import { handlePayOSReconciliation } from "./payosReconciliation";

export const payosPayment = onCall(
  {
    region: "asia-southeast1",
    cors: true,
    timeoutSeconds: 60,
    maxInstances: 20,
    ...(process.env.GCLOUD_PROJECT === "test-jw-system"
      ? { serviceAccount: "pos-payment-qa@test-jw-system.iam.gserviceaccount.com" }
      : {}),
    secrets: [
      payosClientIdSecret,
      payosApiKeySecret,
      payosChecksumKeySecret,
      shadowStoreTokensSecret,
    ],
  },
  async (request) => withPosRequestContext(async () => {
    const device = await assertActivePosDevice(request.data);
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Bạn phải đăng nhập để sử dụng thanh toán PayOS.",
      );
    }

    const action = request.data?.action;
    const userId = request.auth.uid;
    const payload = request.data?.payload;
    if (
      typeof payload?.warehouseId === "string" &&
      payload.warehouseId !== device.warehouseId
    ) {
      throw new HttpsError(
        "permission-denied",
        "Máy POS không được phép thanh toán tại cửa hàng này.",
      );
    }
    const result = await (async () => {
      try {
        if (["reconcile-list", "reconcile-check", "reconcile-ack", "reconcile-closeout"].includes(action)) {
          return await handlePayOSReconciliation(userId, device, action, payload ?? {});
        }
        if (action === "watch") {
          return await createPaymentWatch(userId, device, payload?.localOrderId);
        }
        if (action === "create") {
          return await createPayOSPaymentForUser(userId, {
            ...payload,
            deviceId: device.id,
          });
        }
        if (action === "status") {
          return await getPayOSPaymentStatusForUser(userId, payload);
        }
        if (action === "timeout") {
          return await handlePayOSPaymentTimeoutForUser(
            userId,
            payload,
          );
        }
        if (action === "resume") {
          return await resumePayOSPaymentForUser(userId, payload);
        }
        if (action === "recreate") {
          return await recreatePayOSPaymentForUser(userId, payload);
        }
        if (action === "cancel") {
          return await cancelPayOSPaymentForUser(userId, payload);
        }
        if (action === "manual-confirm") {
          return await confirmPayOSPaymentManuallyForUser(
            userId,
            payload,
          );
        }
        if (action === "get-fallback-settings") {
          return await getFixedTransferSettingsForUser(
            userId,
            payload,
            device.id,
          );
        }
        if (action === "save-fallback-settings") {
          return await saveFixedTransferSettingsForUser(
            userId,
            payload,
            device.id,
          );
        }
        throw new HttpsError("invalid-argument", "Thao tác PayOS không hợp lệ.");
      } catch (error: unknown) {
        if (error instanceof HttpsError) throw error;
        logger.error("[PayOS callable] Xử lý thanh toán thất bại", {
          uid: userId,
          action,
          error,
        });
        throw new HttpsError(
          "internal",
          "Không thể xử lý thanh toán PayOS. Vui lòng thử lại.",
        );
      }
    })();
    return {
      ...result,
      paymentRuntime: {
        realtimeEnabled: device.paymentLatencyOptimizationEnabled,
        pollingIntervalMs: device.paymentLatencyOptimizationEnabled ? 5000 : 15000,
      },
    };
  }),
);
