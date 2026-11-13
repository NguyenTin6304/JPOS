import { onTaskDispatched } from "firebase-functions/v2/tasks";
import {
  SHADOW_QUEUE_MAX_ATTEMPTS,
  SHADOW_QUEUE_REGION,
  handleShadowTask,
  shadowStoreTokensSecret,
  type ShadowTask,
} from "../services/shadowBackend";

// =============================================================================
// Queued delivery of parallel-run shadow commands (services/shadowBackend.ts)
// =============================================================================
// With SHADOW_DELIVERY=queue, the functions that write POS orders put each
// shadow command on this function's Cloud Tasks queue instead of waiting for
// the JJL Data Sync backend. Cloud Tasks retries a command while the backend is
// unreachable or defers it (HTTP 409: the write before it has not arrived yet).
//
// - About 1.5 hours of retries (10 s, doubling up to 10 min); after that the
//   command is dropped with an error log and the backend's nightly heal copies
//   the order from Firestore.
// - One command at a time keeps commands roughly in order; the backend's
//   previousUpdatedAt check does the rest. At most 5 per second stays under the
//   backend's rate limit.
// - Cloud Tasks calls this function with the OIDC token of the account that
//   enqueued the command. On test-jw-system the order functions run as the QA
//   runtime account, so that account is the invoker; it also runs this function
//   (it already reads SHADOW_STORE_TOKENS; this function does not use Firestore).
//   It needs roles/cloudtasks.enqueuer to enqueue.
// =============================================================================

const QA_RUNTIME_ACCOUNT = "pos-payment-qa@test-jw-system.iam.gserviceaccount.com";
const ON_TEST_PROJECT = process.env.GCLOUD_PROJECT === "test-jw-system";

export const deliverShadowCommand = onTaskDispatched<ShadowTask>(
  {
    region: SHADOW_QUEUE_REGION,
    timeoutSeconds: 30,
    retryConfig: {
      maxAttempts: SHADOW_QUEUE_MAX_ATTEMPTS,
      minBackoffSeconds: 10,
      maxBackoffSeconds: 600,
      maxDoublings: 5,
    },
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 5 },
    secrets: [shadowStoreTokensSecret],
    ...(ON_TEST_PROJECT
      ? { serviceAccount: QA_RUNTIME_ACCOUNT, invoker: QA_RUNTIME_ACCOUNT }
      : {}),
  },
  async (request) => {
    await handleShadowTask(request.data, request.retryCount);
  },
);
