import { readFileSync } from 'node:fs';

const path = new URL('../data/randori-catalog-v1.json', import.meta.url);
const catalog = JSON.parse(readFileSync(path, 'utf8'));
const { validateCatalog } = await import('../api/_catalog.js');
const result = validateCatalog(catalog);

console.log(`Catalogue valid: ${result.exerciseCount} exercises`);
