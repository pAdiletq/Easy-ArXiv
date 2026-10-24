/** Local, bounded real-valued math. No eval, generated code, network or paper catalog. */
const LIMITS = Object.freeze({ chars: 2000, depth: 32, nodes: 300, variables: 16, size: 16, operations: 50000, samples: 201 });
const LETTER = /[\p{L}_]/u;
const WORD = /[\p{L}\p{N}_]/u;
const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const RESERVED = new Set(('__proto__ prototype constructor import export eval evaluate parse compile simplify derivative resolve createunit reviver globalthis window document self process require module exports function new class return await async let var const this fetch xmlhttprequest websocket worker chrome browser object reflect proxy json math buffer array number infinity nan true false null undefined to').split(' '));
const CONSTANTS = new Map([['pi', Math.PI], ['π', Math.PI], ['e', Math.E]]);
const ARITY = new Map([
  ...['sqrt', 'cbrt', 'exp', 'log10', 'log2', 'abs', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'floor', 'ceil', 'round', 'sign', 'transpose', 'norm', 'softmax', 'mean'].map(name => [name, [1, 1]]),
  ['log', [1, 2]], ['ln', [1, 1]], ['min', [1, 16]], ['max', [1, 16]], ['pow', [2, 2]], ['atan2', [2, 2]],
  ['dot', [2, 2]], ['matmul', [2, 2]], ['at', [2, 3]], ['sum', [4, 4]], ['integrate', [4, 4]],
]);

export class FormulaError extends Error {
  constructor(code, message) { super(message); this.name = 'FormulaError'; this.code = code; }
}
function fail(code, message) { throw new FormulaError(code, message); }
function validName(name) { return typeof name === 'string' && IDENTIFIER.test(name) && !RESERVED.has(name.toLowerCase()); }
function requireText(text) {
  if (typeof text !== 'string' || !text.trim()) fail('EMPTY', 'Select a formula or enter an expression.');
  if (text.length > LIMITS.chars) fail('LIMIT', 'The formula is too long: the limit is 2000 characters.');
}

const GREEK = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ϵ', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', pi: 'pi' };
const SUPERSCRIPTS = Object.fromEntries([...('⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁽⁾ⁿⁱᵀ')].map((character, index) => [character, '0123456789+-()niT'[index]]));
const SUBSCRIPTS = Object.fromEntries([...('₀₁₂₃₄₅₆₇₈₉₊₋ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ')].map((character, index) => [character, '0123456789+-aehijklmnoprstuvx'[index]]));

function latexGroup(text, position) {
  while (/\s/.test(text[position] || '') && position < text.length) position++;
  if (text[position] !== '{') return null;
  const start = ++position;
  let depth = 1;
  for (; position < text.length; position++) {
    if (text[position] === '{' && ++depth > LIMITS.depth) fail('LIMIT', 'The brackets are nested too deeply.');
    if (text[position] === '}' && --depth === 0) return { text: text.slice(start, position), end: position + 1 };
  }
  fail('SYNTAX', 'A closing brace is missing from the formula.');
}

function convertLatex(text, warnings, depth = 0) {
  if (depth > LIMITS.depth) fail('LIMIT', 'The formula is nested too deeply.');
  let result = '';
  for (let index = 0; index < text.length;) {
    if (text[index] === '_' && text[index + 1] === '{') {
      const group = latexGroup(text, index + 1);
      if (/^[\p{L}\p{N}_]+$/u.test(group.text.trim())) result += '_' + group.text.trim();
      else { result += text.slice(index, group.end); warnings.add('Clarify this compound subscript. Use at(A, i) for an array element.'); }
      index = group.end; continue;
    }
    if (text[index] === '^' && text[index + 1] === '{') {
      const group = latexGroup(text, index + 1);
      result += '^(' + convertLatex(group.text, warnings, depth + 1) + ')'; index = group.end; continue;
    }
    if (text[index] !== '\\') { result += text[index++]; continue; }
    const command = /^\\([A-Za-z]+|[,;! ])/.exec(text.slice(index));
    if (!command) { result += text[index++]; continue; }
    const name = command[1];
    index += command[0].length;
    if (['left', 'right', ',', ';', '!', ' ', 'quad', 'qquad'].includes(name)) { result += ' '; continue; }
    if (['times', 'cdot', 'div'].includes(name)) { result += name === 'div' ? '/' : '*'; continue; }
    if (Object.hasOwn(GREEK, name)) { result += GREEK[name]; continue; }
    if (['frac', 'dfrac', 'tfrac', 'sqrt', 'operatorname', 'mathrm'].includes(name)) {
      const first = latexGroup(text, index);
      if (!first) { result += '\\' + name; warnings.add(`Use brackets to clarify the scope of \\${name}.`); continue; }
      if (['frac', 'dfrac', 'tfrac'].includes(name)) {
        const second = latexGroup(text, first.end);
        if (!second) fail('SYNTAX', 'The fraction is missing a denominator in braces.');
        result += '((' + convertLatex(first.text, warnings, depth + 1) + ')/(' + convertLatex(second.text, warnings, depth + 1) + '))'; index = second.end;
      } else if (name === 'sqrt') {
        result += 'sqrt(' + convertLatex(first.text, warnings, depth + 1) + ')'; index = first.end;
      } else if (IDENTIFIER.test(first.text.trim())) { result += first.text.trim(); index = first.end; }
      else { result += '\\' + name + '{' + first.text + '}'; index = first.end; warnings.add('This text command contains unsupported notation.'); }
      continue;
    }
    if (ARITY.has(name)) {
      const group = latexGroup(text, index);
      if (group) { result += name + '(' + convertLatex(group.text, warnings, depth + 1) + ')'; index = group.end; }
      else result += name;
      continue;
    }
    result += '\\' + name;
    warnings.add(`Rewrite \\${name} as an explicit supported operation.`);
  }
  return result;
}

export function prepareExpression(rawText) {
  requireText(rawText);
  const warnings = new Set();
  if (/[\r\n]/.test(rawText)) warnings.add('PDF text may lose fraction bars and line order. Check the numerator, denominator and brackets.');
  let expression = rawText.trim();
  if (expression.startsWith('$$') && expression.endsWith('$$')) expression = expression.slice(2, -2);
  else if (expression.startsWith('$') && expression.endsWith('$')) expression = expression.slice(1, -1);
  else if ((expression.startsWith('\\(') && expression.endsWith('\\)')) || (expression.startsWith('\\[') && expression.endsWith('\\]'))) expression = expression.slice(2, -2);
  expression = expression.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁽⁾ⁿⁱᵀ]+/gu, sequence => {
    if (sequence.includes('ᵀ')) warnings.add('A superscript T may mean transpose. Use transpose(A) if that is intended.');
    const exponent = [...sequence].map(character => SUPERSCRIPTS[character]).join('');
    return '^(' + exponent + ')';
  }).replace(/[₀₁₂₃₄₅₆₇₈₉₊₋ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]+/gu, sequence => {
    const subscript = [...sequence].map(character => SUBSCRIPTS[character]).join('');
    if (/[+-]/.test(subscript)) warnings.add('Clarify arithmetic in this subscript manually.');
    return '_' + subscript;
  });
  expression = convertLatex(expression, warnings)
    .normalize('NFKC').replace(/[×·⋅]/g, '*').replace(/[÷⁄]/g, '/').replace(/[−–﹣]/g, '-')
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  if (expression.includes('√')) {
    warnings.add('Check the expression under the root: brackets determine its scope.');
    expression = expression.replace(/√\s*\(/g, 'sqrt(')
      .replace(/√\s*([\p{L}_][\p{L}\p{N}_]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/gu, 'sqrt($1)');
  }
  if (/[∑∫∂∇]/u.test(expression)) warnings.add('Sums, integrals and derivatives need explicit definitions and bounds. You can write sum(expr,i,a,b) or integrate(expr,x,a,b).');
  if (/\s+\(\d+\)\s*$/.test(expression)) warnings.add('The trailing number may be an equation label. Remove it or insert * before the intended factor.');
  if (/\/[\s\d.]+[\p{L}_]/u.test(expression)) warnings.add('Check brackets after division: a/2*x and a/(2*x) produce different results.');
  requireText(expression);
  return { expression, warnings: [...warnings], changed: expression !== rawText };
}

function tokenize(text) {
  const tokens = [];
  for (let position = 0; position < text.length;) {
    const character = text[position];
    if (/\s/.test(character)) { position++; continue; }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(position));
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) fail('NON_FINITE', 'This numerical constant is outside the finite real-number range.');
      tokens.push({ type: 'number', value }); position += number[0].length;
    } else if (LETTER.test(character)) {
      let end = position + 1;
      while (end < text.length && WORD.test(text[end])) end++;
      const name = text.slice(position, end);
      if (!validName(name)) fail('UNSAFE', 'This name is not available in mathematical expressions.');
      tokens.push({ type: 'symbol', value: name }); position = end;
    } else if ('+-*/^(),[]'.includes(character)) { tokens.push({ type: character, value: character }); position++; }
    else if (character === '.' || [';', ':', '"', "'", '`'].includes(character)) fail('UNSAFE', 'Property access, strings and JavaScript commands are not allowed.');
    else fail('UNSUPPORTED', `Unsupported character at position ${position + 1}. Clarify the formula notation.`);
    if (tokens.length > 600) fail('LIMIT', 'The formula contains too many elements.');
  }
  tokens.push({ type: 'end' });
  return tokens;
}

class Parser {
  constructor(tokens) { this.tokens = tokens; this.position = 0; this.nodes = 0; }
  peek() { return this.tokens[this.position].type; }
  take(type) {
    if (this.peek() !== type) fail('SYNTAX', `Expected ${type === 'end' ? 'the end of the expression' : 'the symbol ' + type}. Check brackets and operators.`);
    return this.tokens[this.position++];
  }
  node(value) { if (++this.nodes > LIMITS.nodes) fail('LIMIT', 'The formula exceeds 300 nodes. Simplify the expression.'); return value; }
  expression(minimum = 0, depth = 0) {
    if (depth > LIMITS.depth) fail('LIMIT', 'The expression exceeds 32 nesting levels.');
    let left;
    const token = this.tokens[this.position++];
    if (token.type === 'number') left = this.node({ type: 'number', value: token.value });
    else if (token.type === 'symbol') {
      if (this.peek() === '(') {
        if (!ARITY.has(token.value)) fail('UNKNOWN_FUNCTION', `Function ${token.value} is not defined. Enter its explicit expression; use * for multiplication.`);
        this.take('('); const args = [];
        if (this.peek() !== ')') {
          for (;;) {
            args.push(this.expression(0, depth + 1));
            if (args.length > 16) fail('LIMIT', 'The function has too many arguments.');
            if (this.peek() !== ',') break;
            this.take(',');
          }
        }
        this.take(')');
        left = this.node({ type: 'call', name: token.value, args });
      } else {
        if (ARITY.has(token.value)) fail('SYNTAX', `Function ${token.value} needs brackets, for example ${token.value}(x).`);
        left = this.node({ type: 'symbol', name: token.value });
      }
    } else if (token.type === '+' || token.type === '-') {
      left = this.node({ type: 'unary', op: token.type, arg: this.expression(25, depth + 1) });
    } else if (token.type === '(') { left = this.expression(0, depth + 1); this.take(')'); }
    else if (token.type === '[') {
      const items = [];
      if (this.peek() === ']') fail('SHAPE', 'Empty vectors and matrices are not supported.');
      for (;;) {
        items.push(this.expression(0, depth + 1));
        if (items.length > LIMITS.size) fail('LIMIT', 'A vector or matrix row can contain at most 16 elements.');
        if (this.peek() !== ',') break;
        this.take(',');
      }
      this.take(']'); left = this.node({ type: 'array', items });
    } else fail('SYNTAX', 'Expected a number, parameter, function or bracketed expression.');

    for (;;) {
      const next = this.peek();
      const implicit = next === 'symbol' || next === '(';
      const operator = implicit ? '*' : next;
      const precedence = operator === '^' ? 30 : ['*', '/'].includes(operator) ? 20 : ['+', '-'].includes(operator) ? 10 : -1;
      if (precedence < minimum) break;
      if (!implicit) this.position++;
      const right = this.expression(operator === '^' ? precedence : precedence + 1, depth + 1);
      left = this.node({ type: 'binary', op: operator, left, right, ...(implicit ? { implicit: true } : {}) });
    }
    return left;
  }
}

function validateAst(ast) {
  let nodes = 0;
  function visit(node, depth = 0) {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) fail('LIMIT', 'The expression is too complex or nested too deeply.');
    if (!node || typeof node !== 'object' || Array.isArray(node)) fail('INVALID_PROGRAM', 'The formula data is invalid. Enter the expression again.');
    switch (node.type) {
      case 'number': if (typeof node.value !== 'number' || !Number.isFinite(node.value)) fail('NON_FINITE', 'A constant must be a finite real number.'); break;
      case 'symbol': if (!validName(node.name) || ARITY.has(node.name)) fail('UNSAFE', 'Invalid parameter name.'); break;
      case 'unary': if (!['+', '-'].includes(node.op)) fail('UNSUPPORTED', 'Unknown unary operator.'); visit(node.arg, depth + 1); break;
      case 'binary': if (!['+', '-', '*', '/', '^'].includes(node.op)) fail('UNSUPPORTED', 'Unknown arithmetic operator.'); visit(node.left, depth + 1); visit(node.right, depth + 1); break;
      case 'array':
        if (!Array.isArray(node.items) || !node.items.length || node.items.length > LIMITS.size) fail('SHAPE', 'An array must contain 1 to 16 elements.');
        Array.from(node.items).forEach(child => visit(child, depth + 1)); break;
      case 'call': {
        const arity = ARITY.get(node.name);
        if (!arity) fail('UNKNOWN_FUNCTION', 'This function is not defined in the local engine.');
        if (!Array.isArray(node.args) || node.args.length < arity[0] || node.args.length > arity[1]) fail('ARITY', `Check the number of arguments for ${node.name}.`);
        if (['sum', 'integrate'].includes(node.name) && (node.args[1]?.type !== 'symbol' || CONSTANTS.has(node.args[1].name))) fail('SYNTAX', 'The second argument of sum/integrate must be a variable name, not a constant.');
        Array.from(node.args).forEach(child => visit(child, depth + 1)); break;
      }
      default: fail('UNSUPPORTED', 'This construct is not supported. Code execution and object access are not allowed.');
    }
  }
  visit(ast);
}

function symbolsOf(ast) {
  const symbols = new Set();
  function visit(node, bound = new Set()) {
    if (node.type === 'symbol') { if (!CONSTANTS.has(node.name) && !bound.has(node.name)) symbols.add(node.name); }
    else if (node.type === 'unary') visit(node.arg, bound);
    else if (node.type === 'binary') { visit(node.left, bound); visit(node.right, bound); }
    else if (node.type === 'array') node.items.forEach(child => visit(child, bound));
    else if (node.type === 'call') {
      if (['sum', 'integrate'].includes(node.name)) {
        visit(node.args[0], new Set([...bound, node.args[1].name]));
        visit(node.args[2], bound); visit(node.args[3], bound);
      } else node.args.forEach(child => visit(child, bound));
    }
  }
  visit(ast);
  if (symbols.size > LIMITS.variables) fail('LIMIT', 'The formula has more than 16 free parameters.');
  return [...symbols];
}

function operationExplanation(ast, assignment) {
  const operations = new Set();
  const names = { '+': 'addition', '-': 'subtraction', '*': 'multiplication', '/': 'division', '^': 'power' };
  function visit(node) {
    if (node.type === 'binary') { visit(node.left); visit(node.right); operations.add(names[node.op]); }
    else if (node.type === 'unary') { visit(node.arg); if (node.op === '-') operations.add('negation'); }
    else if (node.type === 'array') node.items.forEach(visit);
    else if (node.type === 'call') { node.args.forEach(visit); operations.add(node.name === 'integrate' ? 'numerical integral: Simpson method, 128 intervals' : node.name); }
  }
  visit(ast);
  if (operations.has('numerical integral: Simpson method, 128 intervals')) return 'The definite integral is estimated numerically using Simpson’s method with 128 intervals. The value is approximate.';
  if (operations.has('sum')) return 'The expression is added over the specified range of integer indices. Changing the bounds changes the number of terms.';
  if (operations.has('softmax')) return operations.has('matmul')
    ? 'Softmax converts scores into weights that sum to 1. Matrix multiplication combines these weights with the supplied values.'
    : 'Softmax converts scores into normalized weights that sum to 1. Change the scores to explore the weight distribution.';
  if (operations.has('matmul')) return 'Rows of the first matrix are multiplied by columns of the second, then their pairwise products are added. Matrix dimensions must agree.';
  if (operations.has('dot')) return 'Pairwise products of two vectors are added into one number. Elements with the same index are paired.';
  if (operations.has('exp')) return 'The exponential maps its argument to a positive number. Other operations set the scale and how the result depends on the parameters.';
  if (operations.has('sin') || operations.has('cos')) return `${operations.has('sin') && operations.has('cos') ? 'Sine and cosine create' : operations.has('sin') ? 'Sine creates' : 'Cosine creates'} a periodic component. Angles are measured in radians.`;
  if (operations.has('min') || operations.has('max')) return `${operations.has('min') && operations.has('max') ? 'The smallest and largest values are selected' : operations.has('min') ? 'The smallest value is selected' : 'The largest value is selected'}. Parameters can switch which branch of the expression is selected.`;
  if (operations.has('norm')) return 'The norm measures the magnitude of a vector or matrix. Vectors use the Euclidean norm; matrices use the Frobenius norm.';
  if (operations.has('transpose')) return 'The rows and columns of a matrix are exchanged. Its numerical entries stay the same.';
  if (operations.has('sqrt')) return 'The square root gives a nonlinear dependence on its argument. A real result requires a nonnegative expression under the root.';
  return assignment
    ? 'The right-hand side is calculated from the supplied parameters. The name on the left labels the result; this does not solve an equation.'
    : 'This formula calculates a value from the supplied parameters. Change the parameters to compare results.';
}

export function compileFormula(expression) {
  requireText(expression);
  if (/[;:'"`]/.test(expression) || /(?:=>|==|\+=|-=|\*=|\/=|:=)/.test(expression)) fail('UNSAFE', 'JavaScript commands, strings and assignments are not allowed.');
  if (/\d\s*(?:kg|cm|mm|km|ms|Hz|Pa|eV|mol|deg|rad|inch)\b/u.test(expression)) fail('UNITS', 'Units are not calculated yet. Enter numerical values in consistent units.');
  if (/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*i\b/u.test(expression)) fail('COMPLEX', 'Complex numbers are not supported yet. If i is a numerical parameter, write multiplication explicitly: 2*i.');
  if (/\s+\(\d+\)\s*$/.test(expression)) fail('AMBIGUOUS', 'The trailing number may be an equation label. Remove it or insert * before the intended factor.');
  let assignment = null, body = expression.trim(), declared = [];
  const pieces = body.split('=');
  if (pieces.length > 2) fail('RELATIONSHIP', 'A chain of equalities is not one evaluable expression. Select one right-hand side.');
  if (pieces.length === 2) {
    const label = pieces[0].trim();
    const functionLabel = /^([\p{L}_][\p{L}\p{N}_]*)\s*\(([^()]*)\)$/u.exec(label);
    if (functionLabel) {
      declared = functionLabel[2].split(',').map(value => value.trim());
      if (!validName(functionLabel[1]) || ARITY.has(functionLabel[1]) || !declared.length || declared.some(value => !validName(value) || CONSTANTS.has(value) || ARITY.has(value)) || new Set(declared).size !== declared.length) {
        fail('RELATIONSHIP', 'The left-hand side must be a result name or a function label such as f(x).');
      }
      assignment = functionLabel[1] + '(' + declared.join(', ') + ')';
    } else if (validName(label) && !CONSTANTS.has(label) && !ARITY.has(label)) assignment = label;
    else fail('RELATIONSHIP', 'The engine evaluates expressions but does not solve arbitrary equations. Select the right-hand side or write a function f(x).');
    body = pieces[1].trim();
    if (!body) fail('SYNTAX', 'An expression is missing after the equals sign.');
  }
  const parser = new Parser(tokenize(body));
  const ast = parser.expression(); parser.take('end'); validateAst(ast);
  const variables = symbolsOf(ast);
  if (assignment && !assignment.includes('(') && variables.includes(assignment)) fail('RELATIONSHIP', 'The result variable also occurs on the right. This equation needs a separate solving method.');
  for (const variable of declared) if (!variables.includes(variable)) variables.push(variable);
  if (variables.length > LIMITS.variables) fail('LIMIT', 'At most 16 parameters are allowed.');
  const suggestedBindings = Object.fromEntries(variables.map(name => [name, ['x', 't'].includes(name) ? 0 : 1]));
  return { ast, variables, suggestedBindings, explanation: operationExplanation(ast, assignment), expression, assignment };
}

function tick(state, amount = 1) { if ((state.operations += amount) > LIMITS.operations) fail('LIMIT', 'The calculation is too complex. Reduce matrix dimensions, sample count or sum bounds.'); }
function finite(value) { if (typeof value !== 'number' || !Number.isFinite(value)) fail('DOMAIN', 'The result is not a finite real number. Check the domain and parameter values.'); return value; }
export function classifyValue(value) {
  if (typeof value === 'number') { finite(value); return { kind: 'scalar', shape: [] }; }
  if (!Array.isArray(value) || !value.length || value.length > LIMITS.size) fail('SHAPE', 'Enter a number, a vector of up to 16 elements or a matrix of up to 16×16.');
  const components = Array.from(value);
  if (components.every(component => typeof component === 'number')) { components.forEach(finite); return { kind: 'vector', shape: [value.length] }; }
  if (!components.every(row => Array.isArray(row) && row.length && row.length <= LIMITS.size && row.length === value[0]?.length && Array.from(row).every(component => typeof component === 'number'))) fail('SHAPE', 'A matrix needs equally sized numerical rows, with dimensions no larger than 16×16.');
  value.forEach(row => row.forEach(finite)); return { kind: 'matrix', shape: [value.length, value[0].length] };
}
function scalar(value) { if (typeof value !== 'number') fail('SHAPE', 'This operation needs a number. For vectors and matrices, use dot, matmul, norm or softmax.'); return finite(value); }
function copyValue(value) { const type = classifyValue(value); return type.kind === 'scalar' ? value : type.kind === 'vector' ? [...value] : value.map(row => [...row]); }
function mapValue(value, operation, state) {
  if (typeof value === 'number') { tick(state); return finite(operation(value)); }
  return value.map(component => mapValue(component, operation, state));
}
function elementwise(left, right, operation, state) {
  const a = classifyValue(left), b = classifyValue(right);
  if (a.kind !== b.kind || a.shape.some((size, index) => size !== b.shape[index])) fail('SHAPE', 'Array shapes must match for addition and subtraction.');
  if (a.kind === 'scalar') { tick(state); return finite(operation(left, right)); }
  return left.map((value, index) => elementwise(value, right[index], operation, state));
}
function multiplyMatrices(left, right, state) {
  const a = classifyValue(left), b = classifyValue(right);
  if (a.kind === 'scalar' || b.kind === 'scalar') fail('SHAPE', 'matmul needs vectors or matrices; use * for a number.');
  if (a.kind === 'vector' && b.kind === 'vector') fail('SHAPE', 'Use dot(a,b) for the dot product of two vectors.');
  const rows = a.kind === 'vector' ? [left] : left;
  const columns = b.kind === 'vector' ? right.map(value => [value]) : right;
  if (rows[0].length !== columns.length) fail('SHAPE', 'The column count of the first matrix must equal the row count of the second.');
  const output = rows.map(row => Array.from({ length: columns[0].length }, (_, column) => {
    let value = 0;
    for (let index = 0; index < row.length; index++) { tick(state); value = finite(value + finite(row[index] * columns[index][column])); }
    return value;
  }));
  return a.kind === 'vector' ? output[0] : b.kind === 'vector' ? output.map(row => row[0]) : output;
}

function callFunction(name, args, state) {
  if (name === 'dot') {
    const a = classifyValue(args[0]), b = classifyValue(args[1]);
    if (a.kind !== 'vector' || b.kind !== 'vector' || a.shape[0] !== b.shape[0]) fail('SHAPE', 'dot needs two numerical vectors of equal length.');
    return args[0].reduce((sum, value, index) => { tick(state); return finite(sum + finite(value * args[1][index])); }, 0);
  }
  if (name === 'matmul') return multiplyMatrices(args[0], args[1], state);
  if (name === 'transpose') {
    const type = classifyValue(args[0]);
    if (type.kind !== 'matrix') fail('SHAPE', 'transpose needs a matrix written as rows: [[...],[...]].');
    return args[0][0].map((_, column) => args[0].map(row => { tick(state); return row[column]; }));
  }
  if (name === 'softmax') {
    const type = classifyValue(args[0]);
    if (type.kind === 'scalar') fail('SHAPE', 'softmax needs a vector or matrix; matrices are processed row by row.');
    const softmax = row => {
      tick(state, row.length * 2);
      const maximum = Math.max(...row), exponents = row.map(value => Math.exp(value - maximum));
      const total = exponents.reduce((sum, value) => sum + value, 0);
      return exponents.map(value => finite(value / total));
    };
    return type.kind === 'vector' ? softmax(args[0]) : args[0].map(softmax);
  }
  if (name === 'norm' || name === 'mean' || ((name === 'min' || name === 'max') && args.length === 1 && Array.isArray(args[0]))) {
    const type = classifyValue(args[0]);
    const values = type.kind === 'scalar' ? [args[0]] : type.kind === 'vector' ? args[0] : args[0].flat();
    tick(state, values.length);
    if (name === 'norm') return finite(Math.hypot(...values));
    if (name === 'mean') return finite(values.reduce((sum, value) => finite(sum + value), 0) / values.length);
    return name === 'min' ? Math.min(...values) : Math.max(...values);
  }
  if (name === 'at') {
    const type = classifyValue(args[0]);
    const row = scalar(args[1]), column = args.length === 3 ? scalar(args[2]) : null;
    if (!Number.isInteger(row) || row < 1 || row > type.shape[0]) fail('DOMAIN', 'An at index must be an integer inside the array; indexing starts at 1.');
    if (type.kind === 'vector' && args.length === 2) return args[0][row - 1];
    if (type.kind === 'matrix' && Number.isInteger(column) && column >= 1 && column <= type.shape[1]) return args[0][row - 1][column - 1];
    fail('SHAPE', 'Use at(v,i) for a vector or at(A,i,j) for a matrix. Indices start at 1.');
  }
  const values = args.map(scalar);
  const unary = { sqrt: Math.sqrt, cbrt: Math.cbrt, exp: Math.exp, ln: Math.log, log10: Math.log10, log2: Math.log2, abs: Math.abs,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign };
  if (Object.hasOwn(unary, name)) return finite(unary[name](values[0]));
  if (name === 'log') {
    if (values.length === 2 && (values[1] <= 0 || values[1] === 1)) fail('DOMAIN', 'The logarithm base must be positive and different from 1.');
    return finite(values.length === 1 ? Math.log(values[0]) : Math.log(values[0]) / Math.log(values[1]));
  }
  if (name === 'pow') return finite(Math.pow(values[0], values[1]));
  if (name === 'atan2') return finite(Math.atan2(values[0], values[1]));
  if (name === 'min') return Math.min(...values);
  if (name === 'max') return Math.max(...values);
  fail('UNKNOWN_FUNCTION', 'This function is not defined in the local engine.');
}

function evaluateNode(node, scope, state) {
  tick(state);
  switch (node.type) {
    case 'number': return node.value;
    case 'symbol': {
      if (CONSTANTS.has(node.name)) return CONSTANTS.get(node.name);
      if (!scope.has(node.name)) fail('MISSING_BINDING', `Enter a value for parameter ${node.name}.`);
      return scope.get(node.name);
    }
    case 'array': { const value = node.items.map(child => evaluateNode(child, scope, state)); classifyValue(value); return value; }
    case 'unary': { const value = evaluateNode(node.arg, scope, state); return node.op === '+' ? value : mapValue(value, component => -component, state); }
    case 'binary': {
      const left = evaluateNode(node.left, scope, state), right = evaluateNode(node.right, scope, state);
      if (node.op === '+') return elementwise(left, right, (a, b) => a + b, state);
      if (node.op === '-') return elementwise(left, right, (a, b) => a - b, state);
      if (node.op === '*') {
        if (typeof left === 'number') return mapValue(right, value => left * value, state);
        if (typeof right === 'number') return mapValue(left, value => value * right, state);
        if (classifyValue(left).kind === 'matrix' && classifyValue(right).kind === 'matrix') return multiplyMatrices(left, right, state);
        fail('SHAPE', 'For vector products, explicitly choose dot(a,b) or matmul(A,v).');
      }
      if (node.op === '/') {
        const denominator = scalar(right);
        if (denominator === 0) fail('DOMAIN', 'Division by zero is undefined.');
        return mapValue(left, value => value / denominator, state);
      }
      return finite(Math.pow(scalar(left), scalar(right)));
    }
    case 'call': {
      if (node.name === 'sum' || node.name === 'integrate') {
        const lower = scalar(evaluateNode(node.args[2], scope, state)), upper = scalar(evaluateNode(node.args[3], scope, state));
        const local = new Map(scope), variable = node.args[1].name;
        if (CONSTANTS.has(variable)) fail('SYNTAX', 'A sum or integral variable cannot be a mathematical constant.');
        if (node.name === 'sum') {
          if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper)) fail('DOMAIN', 'Sum bounds must be safe integers.');
          if (upper - lower + 1 > 1000) fail('LIMIT', 'A sum can contain at most 1000 terms.');
          let result = 0;
          for (let index = lower; index <= upper; index++) { local.set(variable, index); result = finite(result + scalar(evaluateNode(node.args[0], local, state))); }
          return result;
        }
        if (lower === upper) return 0;
        const intervals = 128, step = finite((upper - lower) / intervals);
        let total = 0;
        for (let index = 0; index <= intervals; index++) {
          local.set(variable, finite(lower + step * index));
          const weight = index === 0 || index === intervals ? 1 : index % 2 ? 4 : 2;
          total = finite(total + weight * scalar(evaluateNode(node.args[0], local, state)));
        }
        return finite(total * step / 3);
      }
      return callFunction(node.name, node.args.map(child => evaluateNode(child, scope, state)), state);
    }
    default: fail('INVALID_PROGRAM', 'The formula data is invalid.');
  }
}

function buildScope(bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) fail('INVALID_BINDING', 'Parameters must be a record of names and numerical values.');
  const scope = new Map();
  for (const [name, value] of Object.entries(bindings)) {
    if (!validName(name) || CONSTANTS.has(name) || ARITY.has(name)) fail('INVALID_BINDING', 'Invalid parameter name.');
    scope.set(name, copyValue(value));
    if (scope.size > LIMITS.variables) fail('LIMIT', 'At most 16 parameters are allowed.');
  }
  return scope;
}

export function evaluateFormula(program, bindings = {}) {
  validateAst(program?.ast);
  const result = evaluateNode(program.ast, buildScope(bindings), { operations: 0 });
  classifyValue(result); return copyValue(result);
}

export function sampleFormula(program, bindings, { variable, min, max, count = 101 } = {}) {
  validateAst(program?.ast);
  if (!validName(variable) || !program.variables?.includes(variable)) fail('INVALID_AXIS', 'Choose a free parameter of the formula for the horizontal axis.');
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max || !Number.isFinite(max - min)) fail('INVALID_RANGE', 'Enter finite bounds with a minimum smaller than the maximum.');
  if (!Number.isInteger(count) || count < 2 || count > LIMITS.samples) fail('LIMIT', 'A plot can contain 2 to 201 sample points.');
  const scope = buildScope(bindings || {}), state = { operations: 0 }, points = [];
  for (let index = 0; index < count; index++) {
    const x = index === count - 1 ? max : min + (max - min) * (index / (count - 1));
    scope.set(variable, x);
    try { points.push([x, scalar(evaluateNode(program.ast, scope, state))]); }
    catch (error) {
      if (error instanceof FormulaError && error.code === 'DOMAIN') points.push([x, null]);
      else throw error;
    }
  }
  return points;
}
