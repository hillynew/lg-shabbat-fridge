// Timer stays active through body consumption. Never follow credential redirects.
export async function requestJson(url, options = {}, fetcher = fetch, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let kind = 'transport', httpStatus = null;
  try {
    // Workers supports manual/follow, not redirect:error. Reject all non-2xx below.
    const response = await fetcher(url, { ...options, signal: controller.signal, redirect: 'manual' });
    if (!response.ok) {
      kind = 'http';
      httpStatus = Number.isInteger(response.status) ? response.status : null;
      throw new Error('upstream_http_error');
    }
    kind = 'body';
    return await response.json();
  } catch {
    const error = new Error('upstream_request_failed');
    error.kind = controller.signal.aborted ? 'timeout' : kind;
    error.httpStatus = httpStatus;
    throw error;
  } finally { clearTimeout(timeout); }
}
