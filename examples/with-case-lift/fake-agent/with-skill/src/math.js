export function add(a, b) {
  return a + b
}

/**
 * Subtracts one number from another.
 * @param {number} a
 * @param {number} b
 * @returns {number} a minus b
 */
export function subtract(a, b) {
  return a - b
}

/**
 * Multiplies two numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number} a times b
 */
export function multiply(a, b) {
  return a * b
}

/**
 * Divides one number by another.
 * @param {number} a
 * @param {number} b
 * @returns {number} a divided by b
 */
export function divide(a, b) {
  return a / b
}

/**
 * Raises a number to a power.
 * @param {number} a
 * @param {number} b
 * @returns {number} a to the power of b
 */
export function power(a, b) {
  return a ** b
}

/**
 * The larger of two numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number} a or b, whichever is larger
 */
export function max(a, b) {
  return Math.max(a, b)
}

/**
 * The smaller of two numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number} a or b, whichever is smaller
 */
export function min(a, b) {
  return Math.min(a, b)
}
