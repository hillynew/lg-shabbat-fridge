// Timer stays active through body consumption. Response bodies and URLs never enter errors.
export async function requestJson(url, options = {}, fetcher = fetch, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...options, signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error('upstream_http_error');
    return await response.json();
  } catch { throw new Error('upstream_request_failed'); }
  finally { clearTimeout(timeout); }
}
