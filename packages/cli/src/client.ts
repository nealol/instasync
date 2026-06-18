/** Build SDK clients from a folder's `.rtmd` credentials. */

import {
  CursorClient,
  OAuthClient,
  OAuthTokenProvider,
  RealtimeClient,
  type OAuthTokens,
  type VaultHandle,
} from "@realtime-md/sdk";
import { CliError, writeRtmd, type OAuthStoredTokens, type Workspace } from "./config";

export interface BoundClients {
  /** Vault operations in every auth mode. */
  vault: VaultHandle;
  /** Present only in `user` mode. */
  realtime?: RealtimeClient;
  authMode: "user" | "cursor" | "cursor-oauth";
}

export function storedToLiveTokens(stored: OAuthStoredTokens): OAuthTokens {
  return {
    accessToken: stored.accessToken,
    tokenType: stored.tokenType,
    refreshToken: stored.refreshToken,
    scope: stored.scope,
    expiresIn: Math.max(0, Math.floor((stored.expiresAt - Date.now()) / 1000)),
  };
}

export function liveToStoredTokens(tokens: OAuthTokens): OAuthStoredTokens {
  return {
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    refreshToken: tokens.refreshToken,
    scope: tokens.scope,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
  };
}

export function makeClients(ws: Workspace): BoundClients {
  const { config } = ws;
  const auth = config.auth;
  if (!auth) {
    throw new CliError(
      `this folder is bound to vault "${config.vaultName ?? config.vaultId}" but has no credentials ` +
        "(rtmd logout was run?). Run `rtmd login` to sign in again.",
    );
  }
  switch (auth.mode) {
    case "user": {
      const realtime = new RealtimeClient({ baseUrl: config.baseUrl, token: auth.token });
      return { realtime, vault: realtime.vault(config.vaultId), authMode: "user" };
    }
    case "cursor": {
      const cursor = new CursorClient({
        baseUrl: config.baseUrl,
        vaultId: config.vaultId,
        token: auth.token,
      });
      return { vault: cursor.vault, authMode: "cursor" };
    }
    case "cursor-oauth": {
      const oauth = new OAuthClient({ baseUrl: config.baseUrl });
      const provider = new OAuthTokenProvider({
        oauth,
        clientId: auth.clientId,
        tokens: storedToLiveTokens(auth.tokens),
      });
      // Persist rotated refresh tokens or the next run's token is dead.
      provider.onTokens = (fresh) => {
        auth.tokens = liveToStoredTokens(fresh);
        writeRtmd(ws.dir, config);
      };
      const cursor = new CursorClient({
        baseUrl: config.baseUrl,
        vaultId: config.vaultId,
        tokenProvider: provider,
      });
      return { vault: cursor.vault, authMode: "cursor-oauth" };
    }
  }
}

/** For commands that act as the user (members, cursors, rollback, …). */
export function requireUserClient(ws: Workspace): RealtimeClient {
  const clients = makeClients(ws);
  if (!clients.realtime) {
    const auth = ws.config.auth;
    const name = auth && "cursorName" in auth && auth.cursorName ? ` '${auth.cursorName}'` : "";
    throw new CliError(
      `this command needs a user login, but this folder is authenticated as remote cursor${name}. ` +
        "Run `rtmd login` here to switch to your user account.",
    );
  }
  return clients.realtime;
}
