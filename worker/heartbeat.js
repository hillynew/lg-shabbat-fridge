const pingURL = /^https:\/\/hc-ping\.com\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export function createHeartbeat(url, fetcher, log) {
  if (!url) return null;
  if (!pingURL.test(url)) {
    log(JSON.stringify({ event: 'healthchecks_config_invalid' }));
    return null;
  }

  return async function ping(phase) {
    try {
      const endpoint = phase === 'success' ? url : `${url}/${phase}`;
      const response = await fetcher(endpoint, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 200) return;
    } catch {
      // Report below without including the secret URL or network error.
    }
    log(JSON.stringify({ event: 'healthchecks_ping_failed', phase }));
  };
}
