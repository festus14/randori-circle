import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { validateCatalog } from '../api/_catalog.js';

export const CATALOG_PATH = new URL('../data/randori-catalog-v1.json', import.meta.url);
export const PROVENANCE_PATH = new URL('../data/randori-catalog-provenance-v1.json', import.meta.url);

export function validateCatalogFiles({ catalogPath = CATALOG_PATH, provenancePath = PROVENANCE_PATH } = {}) {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  return validateCatalog(catalog, undefined, provenance);
}

export function main({ stdout = process.stdout, ...paths } = {}) {
  const result = validateCatalogFiles(paths);
  stdout.write(`Catalogue and provenance valid: ${result.exerciseCount} exercises\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
