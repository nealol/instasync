import type { YSweetProvider } from "@y-sweet/client";

const pendingConnects = new WeakMap<YSweetProvider, Promise<void>>();

/** Coalesce manual provider connects so app-level nudges don't race y-sweet's loop. */
export function connectYSweetProvider(provider: YSweetProvider): Promise<void> {
  const pending = pendingConnects.get(provider);
  if (pending) return pending;

  const next = provider.connect().finally(() => {
    if (pendingConnects.get(provider) === next) pendingConnects.delete(provider);
  });
  pendingConnects.set(provider, next);
  return next;
}
