// Timer stays active through body consumption. Never follow credential redirects.
export async function requestJson(url, options = {}, fetcher = fetch, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let kind = 'transport', httpStatus = null, lgCode = null;
  try {
    // Workers supports manual/follow, not redirect:error. Reject all non-2xx below.
    const response = await fetcher(url, { ...options, signal: controller.signal, redirect: 'manual' });
    if (response.headers?.get('cf-mitigated') === 'challenge') {
      kind = 'challenge';
      httpStatus = response.status;
      throw new Error('upstream_challenge');
    }
    if (!response.ok) {
      kind = 'http';
      httpStatus = Number.isInteger(response.status) ? response.status : null;
      if (httpStatus === 400) {
        // Only retain known rejection codes. Never log the response body.
        const result = await response.json().catch(() => null);
        if (['9006', '9012'].includes(result?.resultCode)) lgCode = result.resultCode;
      }
      throw new Error('upstream_http_error');
    }
    kind = 'body';
    return await response.json();
  } catch {
    const error = new Error('upstream_request_failed');
    error.kind = controller.signal.aborted ? 'timeout' : kind;
    error.httpStatus = httpStatus;
    error.lgCode = lgCode;
    error.accessRejected = kind === 'challenge' || lgCode !== null || [401, 403, 429].includes(httpStatus)
      || (httpStatus >= 300 && httpStatus < 400);
    throw error;
  } finally { clearTimeout(timeout); }
}
