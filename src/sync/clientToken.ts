import type RealtimePlugin from "../main";
import { getDocumentEpoch } from "../documentEpoch";

/** Token fields used by Realtime's native document provider. */
export type ClientToken = {
  url: string;
  baseUrl: string;
  docId: string;
  token?: string;
  authorization?: "full" | "read-only";
  epoch?: number;
};

export class DocumentEpochChangedError extends Error {
  constructor(
    readonly documentId: string,
    readonly epoch: number,
  ) {
    super(`Realtime: document "${documentId}" moved to epoch ${epoch}; reconnecting.`);
    this.name = "DocumentEpochChangedError";
  }
}

export class DocumentEpochPendingError extends Error {
  constructor(
    readonly documentId: string,
    readonly localEpoch: number,
    readonly serverEpoch: number,
  ) {
    super(
      `Realtime: document "${documentId}" is waiting for epoch ${localEpoch} to activate; retrying.`,
    );
    this.name = "DocumentEpochPendingError";
  }
}

const TOKEN_RETRY_DELAY_MS = 30_000;

let tokenRetryDelayMs = TOKEN_RETRY_DELAY_MS;
let nextTokenAttemptAt = 0;
let tokenAttemptQueue: Promise<void> = Promise.resolve();

/**
 * Test-only: clear the module-global token backoff/queue and optionally shrink
 * the retry delay. The backoff state is shared by every provider in the
 * process, so without a reset one transient token failure in a test run stalls
 * every later connection for 30s.
 */
export function resetTokenRetryStateForTests(delayMs = TOKEN_RETRY_DELAY_MS): void {
  tokenRetryDelayMs = delayMs;
  nextTokenAttemptAt = 0;
  tokenAttemptQueue = Promise.resolve();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForTokenAttemptSlot(): Promise<() => void> {
  let release!: () => void;
  const previous = tokenAttemptQueue;
  tokenAttemptQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

/**
 * Obtains a {@link ClientToken} for a document from the Realtime server. The
 * server performs the access check and terminates the Yjs connection itself.
 *
 * `docId` is the *namespaced* id (`{vaultId}` for the index, `{vaultId}__{guid}`
 * for a file); the vault is always the active vault.
 */
export async function getClientToken(
  plugin: RealtimePlugin,
  docId: string,
  path?: string,
): Promise<ClientToken> {
  const vaultId = plugin.settings.activeVaultId;
  if (!vaultId) {
    throw new Error("Realtime: no active vault; sign in and set up a vault before syncing.");
  }

  const release = await waitForTokenAttemptSlot();
  try {
    const waitMs = nextTokenAttemptAt - Date.now();
    if (waitMs > 0) await delay(waitMs);

    const token = await plugin.auth.docToken(vaultId, docId, path);
    nextTokenAttemptAt = 0;
    if (!token || !token.url) {
      throw new Error(`Realtime: auth server returned an invalid token for "${docId}".`);
    }
    const serverEpoch = token.epoch ?? 0;
    const localEpoch = getDocumentEpoch(plugin, docId);
    if (serverEpoch > localEpoch) {
      plugin.acceptDocumentEpoch(docId, serverEpoch);
      throw new DocumentEpochChangedError(docId, serverEpoch);
    }
    if (serverEpoch < localEpoch) {
      throw new DocumentEpochPendingError(docId, localEpoch, serverEpoch);
    }
    return token;
  } catch (e) {
    if (!(e instanceof DocumentEpochChangedError)) {
      nextTokenAttemptAt = Date.now() + tokenRetryDelayMs;
    }
    throw e;
  } finally {
    release();
  }
}
