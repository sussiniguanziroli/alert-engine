const evaluate = (value, condition, threshold) => {
  const v = parseFloat(value);
  const t = parseFloat(threshold);
  if (isNaN(v) || isNaN(t)) return false;
  switch (condition) {
    case '>':  return v >  t;
    case '<':  return v <  t;
    case '>=': return v >= t;
    case '<=': return v <= t;
    case '==': return v === t;
    case '!=': return v !== t;
    default:   return false;
  }
};

module.exports = { evaluate };
