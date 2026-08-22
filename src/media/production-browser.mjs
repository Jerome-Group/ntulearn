export function throwIfProviderAborted(signal) {
  if (signal?.aborted)
    throw signal.reason ?? new Error("Provider work interrupted. Retry it later.");
}

export function abortableProviderWork(promise, signal) {
  if (!signal) return promise;
  throwIfProviderAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new Error("Provider work interrupted. Retry it later."));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
