import type { Webhook, WebhookData } from "@payos/node";
import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { db } from "../config/firebase";
import { POS_COLLECTIONS } from "../config/collections";
import {
  cancelSupersededPayOSAttempt,
  markPayOSPaymentPaid,
} from "./payosFunctions";
import {
  getPayOS,
  payosApiKeySecret,
  payosChecksumKeySecret,
  payosClientIdSecret,
} from "../services/payosService";
import { shadowStoreTokensSecret } from "../services/shadowBackend";

export const payosWebhook = onRequest(
  {
    region: "asia-southeast1",
    timeoutSeconds: 60,
    maxInstances: 20,
    cors: false,
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
  async (request, response) => {
    const webhookReceivedAt = new Date().toISOString();
    if (request.method !== "POST") {
      response.set("Allow", "POST").status(405).json({ success: false });
      return;
    }

    let webhookData: WebhookData;
    try {
      webhookData = await getPayOS().webhooks.verify(request.body as Webhook);
    } catch (error: unknown) {
      logger.warn("[PayOS webhook] Chữ ký không hợp lệ", { error });
      response.status(400).json({ success: false });
      return;
    }

    if (webhookData.code !== "00") {
      logger.info("[PayOS webhook] Bỏ qua thông báo không thành công", {
        orderCode: webhookData.orderCode,
        code: webhookData.code,
        description: webhookData.desc,
      });
      response.status(200).json({ success: true });
      return;
    }
    if (
      !Number.isSafeInteger(webhookData.orderCode) ||
      webhookData.orderCode <= 0 ||
      !Number.isSafeInteger(webhookData.amount) ||
      webhookData.amount <= 0 ||
      webhookData.currency !== "VND" ||
      typeof webhookData.paymentLinkId !== "string" ||
      webhookData.paymentLinkId.length === 0
    ) {
      logger.warn("[PayOS webhook] Dữ liệu webhook không hợp lệ", {
        orderCode: webhookData.orderCode,
      });
      response.status(400).json({ success: false });
      return;
    }

    try {
      const orderQuery = await db
        .collection(POS_COLLECTIONS.orders)
        .where("payosOrderCodes", "array-contains", webhookData.orderCode)
        .limit(2)
        .get();

      if (orderQuery.empty) {
        logger.warn("[PayOS webhook] Không tìm thấy đơn hàng", {
          orderCode: webhookData.orderCode,
        });
        response.status(200).json({ success: true });
        return;
      }

      if (orderQuery.size !== 1) {
        logger.error("[PayOS webhook] Mã PayOS trùng trên nhiều đơn hàng", {
          orderCode: webhookData.orderCode,
          count: orderQuery.size,
        });
        response.status(500).json({ success: false });
        return;
      }

      const paymentResult = await markPayOSPaymentPaid(
        orderQuery.docs[0].ref,
        webhookData.orderCode,
        {
          code: webhookData.code,
          orderCode: webhookData.orderCode,
          amount: webhookData.amount,
          currency: webhookData.currency,
          paymentLinkId: webhookData.paymentLinkId,
          reference: webhookData.reference,
          transactionDateTime: webhookData.transactionDateTime,
          confirmationSource: "WEBHOOK",
          webhookReceivedAt,
        },
      );
      if (paymentResult === "REJECTED") {
        logger.error("[PayOS webhook] Không thể xác nhận thanh toán", {
          localOrderId: orderQuery.docs[0].id,
          orderCode: webhookData.orderCode,
        });
        response.status(400).json({ success: false });
        return;
      }
      await cancelSupersededPayOSAttempt(
        orderQuery.docs[0].ref,
        webhookData.orderCode,
      );
      logger.info("[PayOS webhook] Đã xử lý webhook", {
        localOrderId: orderQuery.docs[0].id,
        orderCode: webhookData.orderCode,
        result: paymentResult,
        webhookReceivedAt,
      });
      response.status(200).json({ success: true });
    } catch (error: unknown) {
      logger.error("[PayOS webhook] Xử lý webhook thất bại", {
        orderCode: webhookData.orderCode,
        error,
      });
      response.status(500).json({ success: false });
    }
  },
);
