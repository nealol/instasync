import type { YSweetProviderParams } from "@y-sweet/client";
import { MuxWebSocket } from "./mux";

/**
 * `YSweetProvider` options that route every provider's socket through the shared
 * single-socket multiplexer (`/dmux`) instead of opening one WebSocket per
 * document. See `src/sync/mux.ts`.
 */
export function muxProviderOptions(): Partial<YSweetProviderParams> {
  return {
    WebSocketPolyfill: MuxWebSocket as unknown as YSweetProviderParams["WebSocketPolyfill"],
  };
}
