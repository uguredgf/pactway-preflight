/** Exact decimal arithmetic. Public amounts are strings; units are internal BigInts. */
export const DECIMAL_SCALE = 100000000n;
export const DECIMAL_PLACES = 8;

export function parseDecimal(value) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,8})?$/.test(value)) {
    throw new TypeError('Amount must be a decimal string with at most 8 fractional digits');
  }
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const units = BigInt(whole) * DECIMAL_SCALE + BigInt(fraction.padEnd(DECIMAL_PLACES, '0'));
  return negative ? -units : units;
}

export function formatDecimal(units) {
  if (typeof units !== 'bigint') throw new TypeError('Units must be a BigInt');
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const fraction = (absolute % DECIMAL_SCALE).toString().padStart(DECIMAL_PLACES, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${absolute / DECIMAL_SCALE}${fraction ? '.' + fraction : ''}`;
}

export function normalizeDecimal(value) { return formatDecimal(parseDecimal(value)); }
export function addDecimal(left, right) { return formatDecimal(parseDecimal(left) + parseDecimal(right)); }
export function subtractDecimal(left, right) { return formatDecimal(parseDecimal(left) - parseDecimal(right)); }

/** Mathematical floor, including for negative values. */
export function floorDivide(numerator, denominator) {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint' || denominator <= 0n) {
    throw new TypeError('Integer numerator and positive denominator required');
  }
  const quotient = numerator / denominator;
  return numerator < 0n && numerator % denominator !== 0n ? quotient - 1n : quotient;
}

export function ceilDivide(numerator, denominator) { return -floorDivide(-numerator, denominator); }

export function mulDecimal(left, right, rounding = 'down') {
  const product = parseDecimal(left) * parseDecimal(right);
  if (rounding !== 'down' && rounding !== 'up') throw new TypeError('Unknown rounding mode');
  return formatDecimal(rounding === 'up' ? ceilDivide(product, DECIMAL_SCALE) : floorDivide(product, DECIMAL_SCALE));
}

export function divDecimal(left, right, rounding = 'down') {
  const denominator = parseDecimal(right);
  if (denominator <= 0n) throw new RangeError('Divisor must be positive');
  if (rounding !== 'down' && rounding !== 'up') throw new TypeError('Unknown rounding mode');
  const numerator = parseDecimal(left) * DECIMAL_SCALE;
  return formatDecimal(rounding === 'up' ? ceilDivide(numerator, denominator) : floorDivide(numerator, denominator));
}

export function roundDownToStep(value, step) {
  const units = parseDecimal(value), increment = parseDecimal(step);
  if (units < 0n || increment <= 0n) throw new RangeError('Nonnegative value and positive step required');
  return formatDecimal((units / increment) * increment);
}
