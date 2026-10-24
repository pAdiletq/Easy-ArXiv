import {compileFormula, evaluateFormula, sampleFormula} from './formula-engine.js';

const errorInfo = error => ({
  code: typeof error?.code === 'string' ? error.code : 'calculation-error',
  message: typeof error?.message === 'string' ? error.message : 'The calculation could not be completed.'
});

self.onmessage = event => {
  const request = event.data;
  if (!request || !Number.isSafeInteger(request.id) || typeof request.expression !== 'string') return;
  const {id} = request;
  try {
    const program = compileFormula(request.expression);
    const bindings = Object.create(null);
    for (const name of program.variables) {
      bindings[name] = request.bindings && Object.hasOwn(request.bindings, name)
        ? request.bindings[name] : program.suggestedBindings[name];
    }
    const metadata = {
      expression: program.expression, variables: program.variables,
      suggestedBindings: program.suggestedBindings, explanation: program.explanation,
      assignment: program.assignment, ast:program.ast
    };
    let value = null, valueError = null, plot = null;
    try { value = evaluateFormula(program, bindings); }
    catch (error) { valueError = errorInfo(error); }
    if (!Array.isArray(value)) {
      const view = request.view;
      const fallback = ['x','t','z'].find(name=>program.variables.includes(name)) || program.variables.find(name=>typeof bindings[name]==='number');
      const variable = view?.variable === '' ? null : program.variables.includes(view?.variable) ? view.variable : fallback;
      if (variable && typeof bindings[variable] === 'number') {
        const min = Number.isFinite(view.min) ? view.min : -4;
        const max = Number.isFinite(view.max) ? view.max : 4;
        if (min < max && Math.abs(min) <= 1e6 && Math.abs(max) <= 1e6) {
          try {plot = {variable, min, max, points: sampleFormula(program, bindings, {variable, min, max, count:121})};}
          catch (error) {if (!valueError) valueError=errorInfo(error);}
        }
      }
    }
    self.postMessage({id, ok:true, program:metadata, bindings, value, valueError, plot});
  } catch (error) {
    self.postMessage({id, ok:false, error:errorInfo(error)});
  }
};
