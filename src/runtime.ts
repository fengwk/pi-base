export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

export async function throwIfAbortedAfter<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	const value = await promise;
	throwIfAborted(signal);
	return value;
}
