import type { Transaction } from "firebase-admin/firestore";
import { db } from "../config/firebase";
import {
  sendShadowPayment,
  type ShadowOrderRef,
  type ShadowPaymentOperation,
} from "./shadowBackend";

export type RecordShadow = (
  order: ShadowOrderRef,
  values: Record<string, unknown>,
) => void;

interface PendingShadow {
  order: ShadowOrderRef;
  values: Record<string, unknown>;
}

/**
 * db.runTransaction for a QR payment write that has a parallel-run shadow
 * command. Call recordShadow where the transaction writes the order; the command
 * is sent only after the commit, and never when the transaction wrote nothing.
 */
export async function runShadowedTransaction<T>(
  operation: ShadowPaymentOperation,
  body: (transaction: Transaction, recordShadow: RecordShadow) => Promise<T>,
): Promise<T> {
  const pending: { write: PendingShadow | null } = { write: null };
  const result = await db.runTransaction((transaction) => {
    // Firestore may run the body again: only the run that committed counts.
    pending.write = null;
    return body(transaction, (order, values) => {
      pending.write = { order, values };
    });
  });
  if (pending.write) {
    await sendShadowPayment(operation, pending.write.order, pending.write.values);
  }
  return result;
}
