import type { YSweetProviderParams } from "@y-sweet/client";
import type RealtimePlugin from "../main";
import { MuxWebSocket } from "./mux";

/**
 * Extra `YSweetProvider` options that route the provider's socket through the
 * shared single-socket multiplexer when {@link RealtimeSettings.singleSocketSync}
 * is enabled. Returns `{}` otherwise so the provider opens its own WebSocket.
 */
export function muxProviderOptions(plugin: RealtimePlugin): Partial<YSweetProviderParams> {
  if (!plugin.settings.singleSocketSync) return {};
  return {
    WebSocketPolyfill: MuxWebSocket as unknown as YSweetProviderParams["WebSocketPolyfill"],
  };
}
