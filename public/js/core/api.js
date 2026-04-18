export async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await res.json()
    : await res.text();

  if (!res.ok) {
    const message =
      payload && typeof payload === 'object' && payload.error
        ? payload.error
        : typeof payload === 'string' && payload.trim()
          ? payload.trim()
          : `Request failed (${res.status})`;
    throw new Error(message);
  }

  return payload;
}
