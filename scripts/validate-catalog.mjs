import { readFileSync } from 'node:fs';

const catalogPath = new URL('../data/randori-catalog-v1.json', import.meta.url);
const provenancePath = new URL('../data/randori-catalog-provenance-v1.json', import.meta.url);
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
const { validateCatalog } = await import('../api/_catalog.js');
const result = validateCatalog(catalog, undefined, provenance);

console.log(`Catalogue and provenance valid: ${result.exerciseCount} exercises`);
