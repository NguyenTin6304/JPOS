import type { Transaction } from "firebase-admin/firestore";
import { db } from "../config/firebase";
import {
  sendShadowPayment,
  type ShadowOrderBefore,
  type ShadowPaymentOperation,
} from "./shadowBackend";

/**
 * Record the shadow command of the order write. `before` is the order as this
 * transaction read it, before writing: its updatedAt orders the command
 * (previousUpdatedAt). Never pass the order as written.
 */
export type RecordShadow = (
  before: ShadowOrderBefore,
  values: Record<string, unknown>,
) => void;

interface PendingShadow {
  before: ShadowOrderBefore;
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
    return body(transaction, (before, values) => {
      pending.write = { before, values };
    });
  });
  if (pending.write) {
    const { before, values } = pending.write;
    await sendShadowPayment(operation, before, values, before.updatedAt ?? null);
  }
  return result;
}
