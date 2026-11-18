// First-use module: fetched only when the server catalogue advertises an
// enabled provider-supported addition. Never infer support from browser flags.
export const LANGUAGE_LABELS = Object.freeze({ typescript: 'TypeScript', go: 'Go' });
export function syncLanguageOptions(select, questions, doc = document) {
  if (!select) return;
  for (const [language, label] of Object.entries(LANGUAGE_LABELS)) {
    const enabled = questions.some(question => question.languages?.[language]);
    const option = [...select.options].find(item => item.value === language);
    if (enabled && !option) {
      const added = doc.createElement('option');
      added.value = language; added.textContent = label;
      select.appendChild(added);
    } else if (!enabled && option) option.remove();
  }
  // A server-pinned workspace can hydrate before this lazy module/catalogue.
  // Restore that selection silently; never dispatch an edit or replace code.
  const pending = select.dataset?.pendingLanguage;
  if (pending && [...select.options].some(option => option.value === pending)) {
    select.value = pending;
    delete select.dataset.pendingLanguage;
  }
}
if (typeof window !== 'undefined' && !window.RandoriExecutionLanguages) {
  window.RandoriExecutionLanguages = Object.freeze({
    sync: questions => syncLanguageOptions(document.getElementById('langSelect'), questions),
  });
}
