import { randomInt } from 'node:crypto';

export function defaultRandom() {
  return randomInt(0, 0x100000000) / 0x100000000;
}

export function randomUnit(random) {
  if (typeof random !== 'function') throw new TypeError('random must be a function');
  const value = Number(random());
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('random must return a finite number in [0, 1)');
  }
  return value;
}

export function randomInteger(random, minimum, maximum) {
  return minimum + Math.floor(randomUnit(random) * (maximum - minimum + 1));
}
