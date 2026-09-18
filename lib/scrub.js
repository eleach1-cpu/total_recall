'use strict';

const TOKEN = '[scrubbed]';

const SIMPLE = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
];
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g;
const NEAR_KEYWORD = /\b(token|key|secret|password)\b([^\n]{0,40}?)([A-Fa-f0-9]{32,}|[A-Za-z0-9+/=]{32,})/gi;
const ENV_LINE = /^([A-Za-z0-9_]*(?:_KEY|_SECRET|_TOKEN|PASSWORD))=.*$/gm;

function scrub(text) {
  let out = String(text ?? '');
  for (const re of SIMPLE) out = out.replace(re, TOKEN);
  out = out.replace(BEARER, `Bearer ${TOKEN}`);
  out = out.replace(NEAR_KEYWORD, (m, kw, mid) => `${kw}${mid}${TOKEN}`);
  out = out.replace(ENV_LINE, (m, key) => `${key}=${TOKEN}`);
  return out;
}

module.exports = { scrub, TOKEN };
