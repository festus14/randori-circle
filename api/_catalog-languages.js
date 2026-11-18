// Deterministic language adapters, not new exercise content. The reviewed JS
// definition remains canonical; no prompts, examples, cases or oracles here.
// Adding bespoke starters instead requires versioned provenance review.
export function deriveExerciseLanguages(exercise) {
  const js = exercise.languages.javascript;
  const match = js.signature.match(/^function\s+[A-Za-z_$][\w$]*\(([^)]*)\)/);
  if (!match) throw new Error(`Cannot derive language signatures: ${exercise.slug}@${exercise.version}`);
  const parameters = match[1].split(',').map(value => value.trim()).filter(Boolean);
  if (!parameters.every(value => /^[A-Za-z_][\w]*$/.test(value)) || !/^[A-Za-z_][\w]*$/.test(js.entrypoint)) {
    throw new Error(`Cannot derive portable identifiers: ${exercise.slug}@${exercise.version}`);
  }
  const tsSignature = `function ${js.entrypoint}(${parameters.map(name => `${name}: any`).join(', ')}): any`;
  const goSignature = `func ${js.entrypoint}(${parameters.map(name => `${name} interface{}`).join(', ')}) interface{}`;
  return {
    typescript: { entrypoint: js.entrypoint, signature: tsSignature,
      starter: `${tsSignature} {\n  // Implement using erasable TypeScript; no imports or exports.\n  return null;\n}` },
    go: { entrypoint: js.entrypoint, signature: goSignature,
      starter: `package main\n\n// JSON: numbers are float64, arrays []interface{}, objects map[string]interface{}.\n// You may use typed parameters instead. Return a JSON-compatible value.\n// Standard-library imports only; do not define main.\n${goSignature} {\n  return nil\n}\n` },
  };
}
