// Language support is explicit, provider-owned and default OFF for additions.
// Keep this module dependency-free for workspace selection validation too.
export const EXECUTION_LANGUAGES = Object.freeze(['javascript', 'python', 'typescript', 'go']);
export const BASE_EXECUTION_LANGUAGES = Object.freeze(['javascript', 'python']);
export const PROVIDER_LANGUAGES = Object.freeze({
  'vercel-sandbox': Object.freeze(['javascript', 'python', 'typescript']),
  piston: EXECUTION_LANGUAGES,
});
export function normalizeExecutionLanguage(value) {
  const name = String(value || 'javascript').toLowerCase();
  return ({ js: 'javascript', py: 'python', ts: 'typescript' })[name]
    || (EXECUTION_LANGUAGES.includes(name) ? name : null);
}
export function executionLanguageEnabled(language, env = process.env) {
  if (BASE_EXECUTION_LANGUAGES.includes(language)) return true;
  if (language === 'typescript') return env.EXECUTION_LANGUAGE_TYPESCRIPT_ENABLED === 'true';
  if (language === 'go') return env.EXECUTION_LANGUAGE_GO_ENABLED === 'true';
  return false;
}
export function providerSupportsLanguage(provider, language) {
  return PROVIDER_LANGUAGES[provider]?.includes(language) === true;
}
export function availableExecutionLanguages(env = process.env) {
  const provider = String(env.EXECUTION_PROVIDER || '').trim().toLowerCase();
  let configured = provider === 'vercel-sandbox';
  if (provider === 'piston') {
    try {
      const url = new URL(String(env.EXECUTION_API_URL || '').trim());
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      configured = url.protocol === 'https:' && !url.username && !url.password
        && host !== 'emkc.org' && !host.endsWith('.emkc.org');
    } catch { configured = false; }
  }
  return EXECUTION_LANGUAGES.filter(language => executionLanguageEnabled(language, env)
    && (BASE_EXECUTION_LANGUAGES.includes(language) || (configured && providerSupportsLanguage(provider, language))));
}
