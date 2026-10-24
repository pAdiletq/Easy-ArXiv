/**
 * A bounded, illustrative calculation of Attention(Q,K,V) = softmax(QKᵀ/√d_k)V.
 * Every key/query/value vector in this toy example has two components, so d_k
 * stays 2. These numbers are editable examples, not learned Transformer weights.
 * Optional temperature is a separate experiment; the original formula uses 1.
 * Pure ES module: no browser APIs, network, evaluation, model calls, or state.
 */

export const ATTENTION_DIMENSION = 2;
export const MAX_ATTENTION_ROWS = 6;
export const MAX_VECTOR_NORM = 100;
export const MIN_TEMPERATURE = 0.1;
export const MAX_TEMPERATURE = 5;

function matrix(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of row vectors.`);
  if (value.length < 1 || value.length > MAX_ATTENTION_ROWS) {
    throw new RangeError(`${name} must contain between 1 and ${MAX_ATTENTION_ROWS} rows.`);
  }
  return Array.from(value, row => {
    if (!Array.isArray(row) || row.length !== ATTENTION_DIMENSION) {
      throw new RangeError(`Every ${name} row must contain exactly ${ATTENTION_DIMENSION} numbers.`);
    }
    // Explicit components also reject sparse arrays rather than skipping holes.
    const vector = [row[0], row[1]];
    if (vector.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
      throw new TypeError(`${name} components must be finite numbers.`);
    }
    if (Math.hypot(vector[0], vector[1]) > MAX_VECTOR_NORM) {
      throw new RangeError(`Every ${name} row must have a Euclidean norm at most ${MAX_VECTOR_NORM}.`);
    }
    return vector;
  });
}

function stableSoftmax(row) {
  // Subtracting the maximum leaves the probabilities unchanged and prevents
  // exp(large score) from overflowing. Underflow of negligible weights is safe.
  const maximum = Math.max(...row);
  const exponentials = row.map(score => Math.exp(score - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map(value => value / total);
}

export function computeAttention({ Q, K, V, temperature = 1 } = {}) {
  const queries = matrix(Q, 'Q'), keys = matrix(K, 'K'), values = matrix(V, 'V');
  if (keys.length !== values.length) throw new RangeError('K and V must contain the same number of rows.');
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
    throw new TypeError('Temperature must be a finite number.');
  }
  if (temperature < MIN_TEMPERATURE || temperature > MAX_TEMPERATURE) {
    throw new RangeError(`Temperature must be between ${MIN_TEMPERATURE} and ${MAX_TEMPERATURE}.`);
  }

  const rawDotProducts = queries.map(query => keys.map(key => query[0] * key[0] + query[1] * key[1]));
  const scaledScores = rawDotProducts.map(row => row.map(value => value / Math.sqrt(ATTENTION_DIMENSION)));
  const scores = scaledScores.map(row => row.map(value => value / temperature));
  const weights = scores.map(stableSoftmax);
  const output = weights.map(row => Array.from({ length: ATTENTION_DIMENSION }, (_, component) =>
    row.reduce((sum, weight, index) => sum + weight * values[index][component], 0)));

  return { d_k: ATTENTION_DIMENSION, temperature, rawDotProducts, scaledScores, scores, weights, output };
}

export function createAttentionExample() {
  // Return fresh arrays so editing or resetting one panel never changes another.
  return {
    tokens: ['The', 'cat', 'sat'],
    selectedQueryIndex: 0,
    Q: [[1, 0]],
    K: [[1, 0], [0, 1], [0.7, 0.7]],
    V: [[1, 0], [0, 1], [0.5, 0.5]],
    temperature: 1,
  };
}
