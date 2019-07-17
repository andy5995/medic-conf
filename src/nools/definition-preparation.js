function prepare(definition) {
  var targetContext = {};
  bindAllFunctionsToContext(definition, targetContext);
  targetContext.definition = deepCopy(definition);
}

function bindAllFunctionsToContext(obj, context) {
  var keys = Object.keys(obj);
  for (var i in keys) {
    var key = keys[i];
    switch(typeof obj[key]) {
      case 'object':
        bindAllFunctionsToContext(obj[key], context);
        break;
      case 'function':
        obj[key] = obj[key].bind(context);
        break;
    }
  }
}

function deepCopy(obj) {
  var copy = Object.assign({}, obj);
  var keys = Object.keys(copy);
  for (var i in keys) {
    var key = keys[i];
    if (Array.isArray(copy[key])) {
      copy[key] = copy[key].slice(0);
      for (var j = 0; j < copy[key].length; ++j) {
        if (typeof copy[key][j] === 'object') {
          copy[key][j] = deepCopy(copy[key][j]);
        }
      }
    } else if (typeof copy[key] === 'object') {
      copy[key] = deepCopy(copy[key]);
    }
  }
  return copy;
}

module.exports = prepare;
