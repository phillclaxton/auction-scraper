// Small logging helper. Output goes to stdout/stderr, which is what the
// Home Assistant add-on log pane shows, so these lines are the primary way to
// diagnose a failing scrape.

const DEBUG = process.env.LOG_LEVEL === 'debug';

function stamp(level, scope) {
  return `${new Date().toISOString()} ${level} [${scope}]`;
}

const log = {
  debug(scope, ...args) {
    if (DEBUG) console.log(stamp('DEBUG', scope), ...args);
  },
  info(scope, ...args) {
    console.log(stamp('INFO ', scope), ...args);
  },
  warn(scope, ...args) {
    console.warn(stamp('WARN ', scope), ...args);
  },
  error(scope, ...args) {
    console.error(stamp('ERROR', scope), ...args);
  },
  debugEnabled: DEBUG,
};

// Plain-English hints for the low-level codes Node reports. Without these the
// logs only ever say "fetch failed", which is not actionable.
const HINTS = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    'the site did not send its full TLS certificate chain — the bundled intermediate CA in certs/extra-ca.pem may be missing or out of date',
  SELF_SIGNED_CERT_IN_CHAIN:
    'a self-signed certificate is in the chain — something may be intercepting HTTPS traffic',
  CERT_HAS_EXPIRED: 'the site TLS certificate has expired',
  ERR_TLS_CERT_ALTNAME_INVALID: 'the TLS certificate does not match the hostname',
  ENOTFOUND: 'DNS lookup failed — check the container has DNS/network access',
  EAI_AGAIN: 'temporary DNS failure — check the container has DNS/network access',
  ECONNREFUSED: 'the site refused the connection',
  ECONNRESET: 'the connection was reset by the site',
  ETIMEDOUT: 'the connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'the connection timed out',
  ABORT_ERR: 'the request exceeded REQUEST_TIMEOUT_MS and was aborted',
};

// Node's fetch throws a bare "fetch failed" and buries the real reason in
// err.cause. Unwrap it into one readable line.
function describeError(err) {
  if (!err) return 'unknown error';

  const parts = [];
  if (err.message) parts.push(err.message);

  const cause = err.cause;
  if (cause) {
    const detail = [cause.code, cause.message].filter(Boolean).join(': ');
    if (detail && detail !== err.message) parts.push(`cause: ${detail}`);
    if (cause.hostname) parts.push(`host: ${cause.hostname}`);
  }

  const code = (cause && cause.code) || err.code || err.name;
  if (HINTS[code]) parts.push(`hint: ${HINTS[code]}`);

  return parts.join(' | ');
}

module.exports = { log, describeError };
