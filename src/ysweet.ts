import type RealtimePlugin from "./main";

/** Subset of the y-sweet client token needed to connect (see y-sweet SDK). */
export type ClientToken = {
  url: string;
  baseUrl: string;
  docId: string;
  token?: string;
  authorization?: "full" | "read-only";
};

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
 * Obtains a y-sweet {@link ClientToken} for a document by asking the Realtime
 * auth server to mint one. The server performs the access checks and relays to
 * y-sweet, so the plugin never talks to y-sweet's HTTP API directly.
 *
 * `docId` is the *namespaced* id (`{vaultId}` for the index, `{vaultId}__{guid}`
 * for a file); the vault is always the active vault.
 */
export async function getClientToken(plugin: RealtimePlugin, docId: string): Promise<ClientToken> {
  const vaultId = plugin.settings.activeVaultId;
  if (!vaultId) {
    throw new Error("Realtime: no active vault; sign in and set up a vault before syncing.");
  }

  const release = await waitForTokenAttemptSlot();
  try {
    const waitMs = nextTokenAttemptAt - Date.now();
    if (waitMs > 0) await delay(waitMs);

    const token = await plugin.auth.docToken(vaultId, docId);
    nextTokenAttemptAt = 0;
    if (!token || !token.url) {
      throw new Error(`Realtime: auth server returned an invalid token for "${docId}".`);
    }
    return token;
  } catch (e) {
    nextTokenAttemptAt = Date.now() + tokenRetryDelayMs;
    throw e;
  } finally {
    release();
  }
}
