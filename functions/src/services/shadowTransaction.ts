import type { Transaction } from "firebase-admin/firestore";
import { db } from "../config/firebase";
import {
  isShadowPackageOperation,
  isShadowSyncOperation,
  sendShadowPackage,
  sendShadowPayment,
  sendShadowSync,
  type ShadowOrderBefore,
  type ShadowPackageOperation,
  type ShadowPaymentOperation,
  type ShadowSyncOperation,
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
 * db.runTransaction for an order write that has a parallel-run shadow command:
 * a write of the QR payment flow, of the 鲸舰 synchronization, or of a member
 * package sale. Call recordShadow where the transaction writes the order; the
 * command is sent only after the commit, and never when the transaction wrote
 * nothing.
 */
export async function runShadowedTransaction<T>(
  operation: ShadowPaymentOperation | ShadowSyncOperation | ShadowPackageOperation,
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
    if (isShadowSyncOperation(operation)) {
      await sendShadowSync(operation, before, values);
    } else if (isShadowPackageOperation(operation)) {
      await sendShadowPackage(operation, before, values);
    } else {
      await sendShadowPayment(operation, before, values, before.updatedAt ?? null);
    }
  }
  return result;
}
