export function hlsFailureDetails(job) {
  const failure = job?.failure;
  if (!failure) return { error: job?.error || 'No request details available.' };
  const describe = value => {
    try {
      const url = new URL(value);
      return { address: `${url.origin}${url.pathname}`, queryParameters: [...new Set(url.searchParams.keys())] };
    } catch { return { address: 'Unavailable' }; }
  };
  return { stage: failure.stage, httpStatus: failure.status, request: describe(failure.url),
    response: describe(failure.responseUrl), transport: failure.transport,
    serviceWorkerControlled: failure.serviceWorkerControlled ?? null, pageRetry: failure.pageError || null };
}
