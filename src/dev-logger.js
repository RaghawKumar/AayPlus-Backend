const privateKey = /token|authorization|cookie|password|secret|code|phone|email|bytes|photos|videos|photo_url/i;
export function sanitize(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return '[binary omitted]';
  if (Array.isArray(value)) return [...value.slice(0, 10).map(item => sanitize(item, depth + 1)), ...(value.length > 10 ? [`[${value.length - 10} more items]`] : [])];
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, privateKey.test(key) ? '[redacted]' : sanitize(item, depth + 1)]));
  return typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}…` : value;
}
export function developmentLogging(logger) {
  return (req, res, next) => {
    const start = performance.now();
    const path = req.path; // Query strings and headers can contain private data.
    let response;
    const json = res.json;
    res.json = function(body) { response = sanitize(body); return json.call(this, body); };
    res.on('finish', () => {
      logger.info?.('[AayPlus API]', {
        requestId: res.get('X-Request-Id'), method: req.method, path,
        status: res.statusCode, durationMs: Math.round(performance.now() - start),
        request: sanitize(req.body), response: response ?? '[non-JSON response]',
      });
    });
    next();
  };
}
