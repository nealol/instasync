/** Polls `predicate` until it returns truthy or the timeout elapses. */
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<void> {
	const timeout = opts.timeout ?? 10_000;
	const interval = opts.interval ?? 25;
	const start = Date.now();
	for (;;) {
		if (await predicate()) return;
		if (Date.now() - start > timeout) {
			throw new Error(`waitFor timed out${opts.label ? `: ${opts.label}` : ""}`);
		}
		await new Promise((r) => setTimeout(r, interval));
	}
}

/** A random doc guid so tests don't collide in the shared y-sweet server. */
export function freshGuid(): string {
	return "test-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
}
