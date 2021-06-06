/**
 * @license
 * Copyright 2013 Google LLC
 * Modifications Copyright 2021 John Daniels
 * SPDX-License-Identifier: Apache-2.0
 */

import acorn from 'acorn';
import InterpreterObject from './object.js';

// Try to load Node's vm module.
let nodevm;
try {
    nodevm = import('vm');
} catch (e) {
    nodevm = null;
}

const Completion = {
    NORMAL: 0,
    BREAK: 1,
    CONTINUE: 2,
    RETURN: 3,
    THROW: 4
};

const PARSE_OPTIONS: acorn.Options = {
    ecmaVersion: 5
};


/**
 * Property descriptor of readonly properties.
 */
const READONLY_DESCRIPTOR = {
    configurable: true,
    enumerable: true,
    writable: false
};
  
/**
 * Property descriptor of non-enumerable properties.
 */
const NONENUMERABLE_DESCRIPTOR = {
    configurable: true,
    enumerable: false,
    writable: true
};
  
/**
 * Property descriptor of readonly, non-enumerable properties.
 */
const READONLY_NONENUMERABLE_DESCRIPTOR = {
    configurable: true,
    enumerable: false,
    writable: false
};
  
/**
 * Property descriptor of non-configurable, readonly, non-enumerable properties.
 * E.g. NaN, Infinity.
 */
const NONCONFIGURABLE_READONLY_NONENUMERABLE_DESCRIPTOR = {
    configurable: false,
    enumerable: false,
    writable: false
};

/**
 * Property descriptor of variables.
 */
const VARIABLE_DESCRIPTOR = {
    configurable: false,
    enumerable: true,
    writable: true
};

/**
 * Unique symbol for indicating that a step has encountered an error, has
 * added it to the stack, and will be thrown within the user's program.
 * When STEP_ERROR is thrown in the JS-Interpreter, the error can be ignored.
 */
const STEP_ERROR = {'STEP_ERROR': true};

/**
 * Unique symbol for indicating that a reference is a variable on the scope,
 * not an object property.
 */
const SCOPE_REFERENCE = {'SCOPE_REFERENCE': true};

/**
 * Unique symbol for indicating, when used as the value of the value
 * parameter in calls to setProperty and friends, that the value
 * should be taken from the property descriptor instead.
 */
const VALUE_IN_DESCRIPTOR = {'VALUE_IN_DESCRIPTOR': true};

/**
 * Unique symbol for indicating that a RegExp timeout has occurred in a VM.
 */
const REGEXP_TIMEOUT = {'REGEXP_TIMEOUT': true};

/**
 * Class for a state.
 * @param {!Object} node AST node for the state.
 * @param {!Interpreter.Scope} scope Scope object for the state.
 * @constructor
 */
class State {
    node: any;
    scope: any;
    labels: any;
    components: any;
    done: boolean;
    doneCallee_: boolean;
    funcThis_: any;
    func_: any;
    doneArgs_: boolean;
    arguments_: any;
    throwValue: any;
    constructor(node, scope) {
        this.node = node;
        this.scope = scope;
    }
}

/**
 * Class for a scope.
 * @param {Interpreter.Scope} parentScope Parent scope.
 * @param {boolean} strict True if "use strict".
 * @param {!Interpreter.Object} object Object containing scope's variables.
 * @struct
 * @constructor
 */
class Scope{
    parentScope: Scope;
    strict: boolean;
    object: InterpreterObject;
    constructor(parentScope, strict, object) {
        this.parentScope = parentScope;
        this.strict = strict;
        this.object = object;
    }
}

/**
 * Is a value a legal integer for an array length?
 * @param {Interpreter.Value} x Value to check.
 * @return {number} Zero, or a positive integer if the value can be
 *     converted to such.  NaN otherwise.
 */
function legalArrayLength(x: number) {
    const n = x >>> 0;
    // Array length must be between 0 and 2^32-1 (inclusive).
    return (n === Number(x)) ? n : NaN;
}
  
/**
 * Is a value a legal integer for an array index?
 * @param {Interpreter.Value} x Value to check.
 * @return {number} Zero, or a positive integer if the value can be
 *     converted to such.  NaN otherwise.
 */
function legalArrayIndex(x: any) {
    const n = x >>> 0;
    // Array index cannot be 2^32-1, otherwise length would be 2^32.
    // 0xffffffff is 2^32-1.
    return (String(n) === String(x) && n !== 0xffffffff) ? n : NaN;
}

/**
 * Remove start and end values from AST, or set start and end values to a
 * constant value.  Used to remove highlighting from polyfills and to set
 * highlighting in an eval to cover the entire eval expression.
 * @param {!Object} node AST node.
 * @param {number=} start Starting character of all nodes, or undefined.
 * @param {number=} end Ending character of all nodes, or undefined.
 * @private
 */
function stripLocations_(node, start, end) {
    if (start) {
        node['start'] = start;
    } else {
        delete node['start'];
    }
    if (end) {
        node['end'] = end;
    } else {
        delete node['end'];
    }
    for (const name in node) {
        if (Object.prototype.hasOwnProperty.call(node, name)) {
            const prop = node[name];
            if (prop && typeof prop === 'object') {
                stripLocations_(prop, start, end);
            }
        }
    }
}

const nativeGlobal: any = this;
const PLACEHOLDER_GETTER = function() {throw Error('Placeholder getter') };
const PLACEHOLDER_SETTER = function() {throw Error('Placeholder setter') };
const WORKER_CODE = [
    "onmessage = function(e) {",
      "var result;",
      "var data = e.data;",
      "switch (data[0]) {",
        "case 'split':",
          // ['split', string, separator, limit]
          "result = data[1].split(data[2], data[3]);",
          "break;",
        "case 'match':",
          // ['match', string, regexp]
          "result = data[1].match(data[2]);",
          "break;",
        "case 'search':",
          // ['search', string, regexp]
          "result = data[1].search(data[2]);",
          "break;",
        "case 'replace':",
          // ['replace', string, regexp, newSubstr]
          "result = data[1].replace(data[2], data[3]);",
          "break;",
        "case 'exec':",
          // ['exec', regexp, lastIndex, string]
          "var regexp = data[1];",
          "regexp.lastIndex = data[2];",
          "result = [regexp.exec(data[3]), data[1].lastIndex];",
          "break;",
        "default:",
          "throw Error('Unknown RegExp operation: ' + data[0]);",
      "}",
      "postMessage(result);",
    "};"];

export default class Interpreter {

    STRING_PROTO: InterpreterObject;
    FUNCTION_PROTO: InterpreterObject;
    OBJECT_PROTO: InterpreterObject;
    ARRAY_PROTO: InterpreterObject;
    REGEXP_PROTO: InterpreterObject;
    DATE_PROTO: InterpreterObject;
    BOOLEAN_PROTO: InterpreterObject;
    NUMBER_PROTO: InterpreterObject;

    STRING: InterpreterObject;
    FUNCTION: InterpreterObject;
    OBJECT: InterpreterObject
    ARRAY: InterpreterObject;
    REGEXP: InterpreterObject;
    DATE: InterpreterObject;
    BOOLEAN: InterpreterObject;
    ERROR: InterpreterObject;
    NUMBER: InterpreterObject;

    EVAL_ERROR: InterpreterObject;
    RANGE_ERROR: InterpreterObject;
    REFERENCE_ERROR: InterpreterObject;
    SYNTAX_ERROR: InterpreterObject;
    TYPE_ERROR: InterpreterObject;
    URI_ERROR: InterpreterObject;

    ast: any;
    initFunc_: any;
    paused_: boolean;
    polyfills_: any[];
    functionCounter_: number;
    stepFunctions_: any;
    globalScope: any;
    globalObject: any;
    nodeConstructor: any;
    stateStack: any;
    value: any;
    getterStep_: any;
    setterStep_: any;
    prototype: any;

    constructor(code, opt_initFunc) {
        if (typeof code === 'string') {
            code = acorn.parse(code, PARSE_OPTIONS);
        }
        // Get a handle on Acorn's node_t object.
        this.nodeConstructor = code.constructor;
        // Clone the root 'Program' node so that the AST may be modified.
        const ast = new this.nodeConstructor({options:{}});
        for (const prop in code) {
            ast[prop] = (prop === 'body') ? code[prop].slice() : code[prop];
        }
        this.ast = ast;
        this.initFunc_ = opt_initFunc;
        this.paused_ = false;
        this.polyfills_ = [];
        // Unique identifier for native functions.  Used in serialization.
        this.functionCounter_ = 0;
        // Map node types to our step function names; a property lookup is faster
        // than string concatenation with "step" prefix.
        this.stepFunctions_ = Object.create(null);
        const stepMatch = /^step([A-Z]\w*)$/;
        for (const methodName of Object.getOwnPropertyNames(Interpreter.prototype)) {
            let m;
            if ((typeof this[methodName] === 'function') &&
                (m = methodName.match(stepMatch))) {
                const method: any = this[methodName];
                this.stepFunctions_[m[1]] = method.bind(this);
            }
        }
        // Create and initialize the global scope.
        this.globalScope = this.createScope(this.ast, null);
        this.globalObject = this.globalScope.object;
        // Run the polyfills.
        this.ast = acorn.parse(this.polyfills_.join('\n'), PARSE_OPTIONS);
        this.polyfills_ = undefined;  // Allow polyfill strings to garbage collect.
        stripLocations_(this.ast, undefined, undefined);
        const state1 = new State(this.ast, this.globalScope);
        state1.done = false;
        this.stateStack = [state1];
        this.run();
        this.value = undefined;
        // Point at the main program.
        this.ast = ast;
        const state2 = new State(this.ast, this.globalScope);
        state2.done = false;
        this.stateStack.length = 0;
        this.stateStack[0] = state2;
    }

    initGlobal(globalObject) {
        // Initialize uneditable global properties.
        this.setProperty(globalObject, 'NaN', NaN,
            NONCONFIGURABLE_READONLY_NONENUMERABLE_DESCRIPTOR);
        this.setProperty(globalObject, 'Infinity', Infinity,
            NONCONFIGURABLE_READONLY_NONENUMERABLE_DESCRIPTOR);
        this.setProperty(globalObject, 'undefined', undefined,
            NONCONFIGURABLE_READONLY_NONENUMERABLE_DESCRIPTOR);
        this.setProperty(globalObject, 'window', globalObject,
            READONLY_DESCRIPTOR);
        this.setProperty(globalObject, 'this', globalObject,
            NONCONFIGURABLE_READONLY_NONENUMERABLE_DESCRIPTOR);
        this.setProperty(globalObject, 'self', globalObject);  // Editable.
      
        // Create the objects which will become Object.prototype and
        // Function.prototype, which are needed to bootstrap everything else.
        this.OBJECT_PROTO = new InterpreterObject(null);
        this.FUNCTION_PROTO = new InterpreterObject(this.OBJECT_PROTO);
        // Initialize global objects.
        this.initFunction(globalObject);
        this.initObject(globalObject);
        // Unable to set globalObject's parent prior (OBJECT did not exist).
        // Note that in a browser this would be `Window`, whereas in Node.js it would
        // be `Object`.  This interpreter is closer to Node in that it has no DOM.
        globalObject.proto = this.OBJECT_PROTO;
        this.setProperty(globalObject, 'constructor', this.OBJECT,
            NONENUMERABLE_DESCRIPTOR);
        this.initArray(globalObject);
        this.initString(globalObject);
        this.initBoolean(globalObject);
        this.initNumber(globalObject);
        this.initDate(globalObject);
        this.initRegExp(globalObject);
        this.initError(globalObject);
        this.initMath(globalObject);
        this.initJSON(globalObject);
      
        // Initialize global functions.
        const thisInterpreter = this;
        const func = this.createNativeFunction(
            function() {throw EvalError("Can't happen");}, false);
        func.eval = true;
        this.setProperty(globalObject, 'eval', func,
            NONENUMERABLE_DESCRIPTOR);
      
        this.setProperty(globalObject, 'parseInt',
            this.createNativeFunction(parseInt, false),
            NONENUMERABLE_DESCRIPTOR);
        this.setProperty(globalObject, 'parseFloat',
            this.createNativeFunction(parseFloat, false),
            NONENUMERABLE_DESCRIPTOR);
      
        this.setProperty(globalObject, 'isNaN',
            this.createNativeFunction(isNaN, false),
            NONENUMERABLE_DESCRIPTOR);
      
        this.setProperty(globalObject, 'isFinite',
            this.createNativeFunction(isFinite, false),
            NONENUMERABLE_DESCRIPTOR);
      
        const strFunctions: [any, string][] = [
          [escape, 'escape'], [unescape, 'unescape'],
          [decodeURI, 'decodeURI'], [decodeURIComponent, 'decodeURIComponent'],
          [encodeURI, 'encodeURI'], [encodeURIComponent, 'encodeURIComponent']
        ];
        for (let i = 0; i < strFunctions.length; i++) {
          const wrapper = (function(nativeFunc: any) {
            return function(str) {
              try {
                return nativeFunc(str);
              } catch (e) {
                // decodeURI('%xy') will throw an error.  Catch and rethrow.
                thisInterpreter.throwException(thisInterpreter.URI_ERROR, e.message);
              }
            };
          })(strFunctions[i][0]);
          this.setProperty(globalObject, strFunctions[i][1],
              this.createNativeFunction(wrapper, false),
              NONENUMERABLE_DESCRIPTOR);
        }
      
        // Run any user-provided initialization.
        if (this.initFunc_) {
          this.initFunc_(this, globalObject);
        }
    }


    /**
     * Initialize the Function class.
     * @param {!Interpreter.Object} globalObject Global object.
     */
    initFunction(globalObject) {
        const thisInterpreter = this;
        let wrapper;
        const identifierRegexp = /^[A-Za-z_$][\w$]*$/;
        // Function constructor.
        wrapper = function Function(...var_args) {
            let code;
            if (var_args.length) {
                code = String(var_args[var_args.length - 1]);
            } else {
                code = '';
            }
            let argsStr = Array.prototype.slice.call(var_args, 0, -1).join(',').trim();
            if (argsStr) {
                const args = argsStr.split(/\s*,\s*/);
                for (let i = 0; i < args.length; i++) {
                    const name = args[i];
                    if (!identifierRegexp.test(name)) {
                        thisInterpreter.throwException(thisInterpreter.SYNTAX_ERROR,
                            'Invalid function argument: ' + name);
                    }
                }
                argsStr = args.join(', ');
            }
            // Acorn needs to parse code in the context of a function or else `return`
            // statements will be syntax errors.
            let ast;
            try {
                ast = acorn.parse('(function(' + argsStr + ') {' + code + '})',
                    PARSE_OPTIONS);
            } catch (e) {
                // Acorn threw a SyntaxError.  Rethrow as a trappable error.
                thisInterpreter.throwException(thisInterpreter.SYNTAX_ERROR,
                    'Invalid code: ' + e.message);
            }
            if (ast['body'].length !== 1) {
                // Function('a', 'return a + 6;}; {alert(1);');
                thisInterpreter.throwException(thisInterpreter.SYNTAX_ERROR,
                    'Invalid code in function body.');
            }
            const node = ast['body'][0]['expression'];
            // Note that if this constructor is called as `new Function()` the function
            // object created by stepCallExpression and assigned to `this` is discarded.
            // Interestingly, the scope for constructed functions is the global scope,
            // even if they were constructed in some other scope.
            return thisInterpreter.createFunction(node, thisInterpreter.globalScope, 'anonymous');
        };
        this.FUNCTION = this.createNativeFunction(wrapper, true);
    
        this.setProperty(globalObject, 'Function', this.FUNCTION,
            NONENUMERABLE_DESCRIPTOR);
        // Throw away the created prototype and use the root prototype.
        this.setProperty(this.FUNCTION, 'prototype', this.FUNCTION_PROTO,
            NONENUMERABLE_DESCRIPTOR);
    
        // Configure Function.prototype.
        this.setProperty(this.FUNCTION_PROTO, 'constructor', this.FUNCTION,
            NONENUMERABLE_DESCRIPTOR);
        this.FUNCTION_PROTO.nativeFunc = function() {
            // Do Nothing
        };
        this.FUNCTION_PROTO.nativeFunc.id = this.functionCounter_++;
        this.FUNCTION_PROTO.illegalConstructor = true;
        this.setProperty(this.FUNCTION_PROTO, 'length', 0,
            READONLY_NONENUMERABLE_DESCRIPTOR);
        this.FUNCTION_PROTO.class = 'Function';
    
        wrapper = function apply(thisArg, args) {
            const state =
                thisInterpreter.stateStack[thisInterpreter.stateStack.length - 1];
            // Rewrite the current CallExpression state to apply a different function.
            state.func_ = this;
            // Assign the `this` object.
            state.funcThis_ = thisArg;
            // Bind any provided arguments.
            state.arguments_ = [];
            if (args !== null && args !== undefined) {
                if (args instanceof InterpreterObject) {
                state.arguments_ = thisInterpreter.arrayPseudoToNative(args);
                } else {
                thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                    'CreateListFromArrayLike called on non-object');
                }
            }
            state.doneExec_ = false;
        };
        this.setNativeFunctionPrototype(this.FUNCTION, 'apply', wrapper);
    
        wrapper = function call(thisArg, ...var_args) {
            const state =
                thisInterpreter.stateStack[thisInterpreter.stateStack.length - 1];
            // Rewrite the current CallExpression state to call a different function.
            state.func_ = this;
            // Assign the `this` object.
            state.funcThis_ = thisArg;
            // Bind any provided arguments.
            state.arguments_ = [];
            for (let i = 0; i < var_args.length; i++) {
                state.arguments_.push(var_args[i]);
            }
            state.doneExec_ = false;
        };
        this.setNativeFunctionPrototype(this.FUNCTION, 'call', wrapper);
    
        this.polyfills_.push(
            // Polyfill copied from:
            // developer.mozilla.org/en/docs/Web/JavaScript/Reference/Global_objects/Function/bind
            "Object.defineProperty(Function.prototype, 'bind',",
                "{configurable: true, writable: true, value:",
                "function bind(oThis) {",
                "if (typeof this !== 'function') {",
                    "throw TypeError('What is trying to be bound is not callable');",
                "}",
                "var aArgs   = Array.prototype.slice.call(arguments, 1),",
                    "fToBind = this,",
                    "fNOP    = function() {},",
                    "fBound  = function() {",
                        "return fToBind.apply(this instanceof fNOP",
                            "? this",
                            ": oThis,",
                            "aArgs.concat(Array.prototype.slice.call(arguments)));",
                    "};",
                "if (this.prototype) {",
                    "fNOP.prototype = this.prototype;",
                "}",
                "fBound.prototype = new fNOP();",
                "return fBound;",
                "}",
            "});",
            "");
    
        // Function has no parent to inherit from, so it needs its own mandatory
        // toString and valueOf functions.
        wrapper = function toString() {
        return String(this);
        };
        this.setNativeFunctionPrototype(this.FUNCTION, 'toString', wrapper);
        this.setProperty(this.FUNCTION, 'toString',
            this.createNativeFunction(wrapper, false),
            NONENUMERABLE_DESCRIPTOR);
        wrapper = function valueOf() {
        return this.valueOf();
        };
        this.setNativeFunctionPrototype(this.FUNCTION, 'valueOf', wrapper);
        this.setProperty(this.FUNCTION, 'valueOf',
            this.createNativeFunction(wrapper, false),
            NONENUMERABLE_DESCRIPTOR);
    }
  
  /**
   * Initialize the Object class.
   * @param {!Interpreter.Object} globalObject Global object.
   */
    initObject(globalObject) {
        const thisInterpreter = this;
        let wrapper;
        // Object constructor.
        wrapper = function Object(value) {
            if (value === undefined || value === null) {
                // Create a new object.
                if (thisInterpreter.calledWithNew()) {
                // Called as `new Object()`.
                return this;
                } else {
                // Called as `Object()`.
                return thisInterpreter.createObjectProto(thisInterpreter.OBJECT_PROTO);
                }
            }
            if (!(value instanceof InterpreterObject)) {
                // Wrap the value as an object.
                const box: any = thisInterpreter.createObjectProto(
                    thisInterpreter.getPrototype(value));
                box.data = value;
                return box;
            }
            // Return the provided object.
            return value;
        };
        this.OBJECT = this.createNativeFunction(wrapper, true);
        // Throw away the created prototype and use the root prototype.
        this.setProperty(this.OBJECT, 'prototype', this.OBJECT_PROTO,
                        NONENUMERABLE_DESCRIPTOR);
        this.setProperty(this.OBJECT_PROTO, 'constructor', this.OBJECT,
                        NONENUMERABLE_DESCRIPTOR);
        this.setProperty(globalObject, 'Object', this.OBJECT,
            NONENUMERABLE_DESCRIPTOR);
    
        /**
         * Checks if the provided value is null or undefined.
         * If so, then throw an error in the call stack.
         * @param {Interpreter.Value} value Value to check.
         */
        const throwIfNullUndefined = function(value) {
            if (value === undefined || value === null) {
                thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                    "Cannot convert '" + value + "' to object");
            }
        };
    
        // Static methods on Object.
        wrapper = function getOwnPropertyNames(obj) {
            throwIfNullUndefined(obj);
            const props = (obj instanceof InterpreterObject) ? obj.properties : obj;
            return thisInterpreter.arrayNativeToPseudo(
                Object.getOwnPropertyNames(props));
        };
        this.setProperty(this.OBJECT, 'getOwnPropertyNames',
            this.createNativeFunction(wrapper, false),
            NONENUMERABLE_DESCRIPTOR);
    
        wrapper = function keys(obj) {
            throwIfNullUndefined(obj);
            if (obj instanceof InterpreterObject) {
                obj = obj.properties;
            }
            return thisInterpreter.arrayNativeToPseudo(Object.keys(obj));
        };
        this.setProperty(this.OBJECT, 'keys',
            this.createNativeFunction(wrapper, false),
            NONENUMERABLE_DESCRIPTOR);
    
        wrapper = function create_(proto) {
            // Support for the second argument is the responsibility of a polyfill.
            if (proto === null) {
                return thisInterpreter.createObjectProto(null);
            }
            if (!(proto instanceof InterpreterObject)) {
                thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                    'Object prototype may only be an Object or null');
            }
            return thisInterpreter.createObjectProto(proto);
        };
        this.setProperty(this.OBJECT, 'create',
            this.createNativeFunction(wrapper, false),
            NONENUMERABLE_DESCRIPTOR);
    
        // Add a polyfill to handle create's second argument.
        this.polyfills_.push(
        "(function() {",
            "var create_ = Object.create;",
            "Object.create = function create(proto, props) {",
            "var obj = create_(proto);",
            "props && Object.defineProperties(obj, props);",
            "return obj;",
            "};",
        "})();",
        "");
  
        wrapper = function defineProperty(obj, prop, descriptor) {
            prop = String(prop);
            if (!(obj instanceof InterpreterObject)) {
                thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                    'Object.defineProperty called on non-object');
            }
            if (!(descriptor instanceof InterpreterObject)) {
                thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                    'Property description must be an object');
            }
            if (!obj.properties[prop] && obj.preventExtensions) {
                thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                    "Can't define property '" + prop + "', object is not extensible");
            }
            // The polyfill guarantees no inheritance and no getter functions.
            // Therefore the descriptor properties map is the native object needed.
            thisInterpreter.setProperty(obj, prop, VALUE_IN_DESCRIPTOR,
                                        descriptor.properties);
            return obj;
        };
        this.setProperty(this.OBJECT, 'defineProperty',
            this.createNativeFunction(wrapper, false),
            NONENUMERABLE_DESCRIPTOR);
    
        this.polyfills_.push(
        // Flatten the descriptor to remove any inheritance or getter functions.
        "(function() {",
            "var defineProperty_ = Object.defineProperty;",
            "Object.defineProperty = function defineProperty(obj, prop, d1) {",
            "var d2 = {};",
            "if ('configurable' in d1) d2.configurable = d1.configurable;",
            "if ('enumerable' in d1) d2.enumerable = d1.enumerable;",
            "if ('writable' in d1) d2.writable = d1.writable;",
            "if ('value' in d1) d2.value = d1.value;",
            "if ('get' in d1) d2.get = d1.get;",
            "if ('set' in d1) d2.set = d1.set;",
            "return defineProperty_(obj, prop, d2);",
            "};",
        "})();",
        
        "Object.defineProperty(Object, 'defineProperties',",
            "{configurable: true, writable: true, value:",
            "function defineProperties(obj, props) {",
            "var keys = Object.keys(props);",
            "for (var i = 0; i < keys.length; i++) {",
                "Object.defineProperty(obj, keys[i], props[keys[i]]);",
            "}",
            "return obj;",
            "}",
        "});",
        "");
  
        wrapper = function getOwnPropertyDescriptor(obj, prop) {
            if (!(obj instanceof InterpreterObject)) {
                thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                    'Object.getOwnPropertyDescriptor called on non-object');
            }
            prop = String(prop);
            if (!(prop in obj.properties)) {
                return undefined;
            }
            const descriptor = Object.getOwnPropertyDescriptor(obj.properties, prop);
            const getter = obj.getter[prop];
            const setter = obj.setter[prop];
        
            const pseudoDescriptor =
                thisInterpreter.createObjectProto(thisInterpreter.OBJECT_PROTO);
            if (getter || setter) {
                thisInterpreter.setProperty(pseudoDescriptor, 'get', getter);
                thisInterpreter.setProperty(pseudoDescriptor, 'set', setter);
            } else {
                thisInterpreter.setProperty(pseudoDescriptor, 'value',
                    descriptor.value);
                thisInterpreter.setProperty(pseudoDescriptor, 'writable',
                    descriptor.writable);
            }
            thisInterpreter.setProperty(pseudoDescriptor, 'configurable',
                descriptor.configurable);
            thisInterpreter.setProperty(pseudoDescriptor, 'enumerable',
                descriptor.enumerable);
            return pseudoDescriptor;
        };
        this.setProperty(this.OBJECT, 'getOwnPropertyDescriptor',
            this.createNativeFunction(wrapper, false),
            NONENUMERABLE_DESCRIPTOR);
    
        wrapper = function getPrototypeOf(obj) {
        throwIfNullUndefined(obj);
        return thisInterpreter.getPrototype(obj);
        };
        this.setProperty(this.OBJECT, 'getPrototypeOf',
            this.createNativeFunction(wrapper, false),
            NONENUMERABLE_DESCRIPTOR);
    
        wrapper = function isExtensible(obj) {
        return Boolean(obj) && !obj.preventExtensions;
        };
        this.setProperty(this.OBJECT, 'isExtensible',
            this.createNativeFunction(wrapper, false),
            NONENUMERABLE_DESCRIPTOR);
    
        wrapper = function preventExtensions(obj) {
        if (obj instanceof InterpreterObject) {
            obj.preventExtensions = true;
        }
        return obj;
        };
        this.setProperty(this.OBJECT, 'preventExtensions',
            this.createNativeFunction(wrapper, false),
            NONENUMERABLE_DESCRIPTOR);
    
        // Instance methods on Object.
        this.setNativeFunctionPrototype(this.OBJECT, 'toString',
            InterpreterObject.prototype.toString);
        this.setNativeFunctionPrototype(this.OBJECT, 'toLocaleString',
            InterpreterObject.prototype.toString);
        this.setNativeFunctionPrototype(this.OBJECT, 'valueOf',
            InterpreterObject.prototype.valueOf);
    
        wrapper = function hasOwnProperty(prop) {
            throwIfNullUndefined(this);
            if (this instanceof InterpreterObject) {
                return String(prop) in this.properties;
            }
            // Primitive.
            return Object.prototype.hasOwnProperty.call(this, prop);
        };
        this.setNativeFunctionPrototype(this.OBJECT, 'hasOwnProperty', wrapper);
    
        wrapper = function propertyIsEnumerable(prop) {
            throwIfNullUndefined(this);
            if (this instanceof InterpreterObject) {
                return Object.prototype.propertyIsEnumerable.call(this.properties, prop);
            }
            // Primitive.
            return Object.prototype.propertyIsEnumerable.call(this, prop);
        };
        this.setNativeFunctionPrototype(this.OBJECT, 'propertyIsEnumerable', wrapper);
    
        wrapper = function isPrototypeOf(obj) {
            for (;;) {
                // Note, circular loops shouldn't be possible.
                obj = thisInterpreter.getPrototype(obj);
                if (!obj) {
                    // No parent; reached the top.
                    return false;
                }
                if (obj === this) {
                    return true;
                }
            }
        };
        this.setNativeFunctionPrototype(this.OBJECT, 'isPrototypeOf',  wrapper);
    }
  
  /**
   * Initialize the Array class.
   * @param {!Interpreter.Object} globalObject Global object.
   */
  initArray(globalObject) {
        const thisInterpreter = this;
        let wrapper;
        // Array constructor.
        wrapper = function Array(...var_args) {
            let newArray;
            if (thisInterpreter.calledWithNew()) {
                // Called as `new Array()`.
                newArray = this;
            } else {
                // Called as `Array()`.
                newArray = thisInterpreter.createArray();
            }
            const first = var_args[0];
            if (var_args.length === 1 && typeof first === 'number') {
                if (isNaN(legalArrayLength(first))) {
                thisInterpreter.throwException(thisInterpreter.RANGE_ERROR,
                                                'Invalid array length');
                }
                newArray.properties.length = first;
            } else {
                let i;
                for (i = 0; i < var_args.length; i++) {
                    newArray.properties[i] = var_args[i];
                }
                newArray.properties.length = i;
            }
            return newArray;
        };
        this.ARRAY = this.createNativeFunction(wrapper, true);
        this.ARRAY_PROTO = this.ARRAY.properties['prototype'];
        this.setProperty(globalObject, 'Array', this.ARRAY,
            NONENUMERABLE_DESCRIPTOR);
    
        // Static methods on Array.
        wrapper = function isArray(obj) {
        return obj && obj.class === 'Array';
        };
        this.setProperty(this.ARRAY, 'isArray',
                        this.createNativeFunction(wrapper, false),
                        NONENUMERABLE_DESCRIPTOR);
    
        // Instance methods on Array.
        this.setProperty(this.ARRAY_PROTO, 'length', 0,
            {configurable: false, enumerable: false, writable: true});
        this.ARRAY_PROTO.class = 'Array';
    
        this.polyfills_.push(
            "Object.defineProperty(Array.prototype, 'pop',",
                "{configurable: true, writable: true, value:",
                "function pop() {",
                "if (!this) throw TypeError();",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "if (!len || len < 0) {",
                    "o.length = 0;",
                    "return undefined;",
                "}",
                "len--;",
                "var x = o[len];",
                "delete o[len];",  // Needed for non-arrays.
                "o.length = len;",
                "return x;",
                "}",
            "});",
            
            "Object.defineProperty(Array.prototype, 'push',",
                "{configurable: true, writable: true, value:",
                "function push(var_args) {",
                "if (!this) throw TypeError();",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "for (var i = 0; i < arguments.length; i++) {",
                    "o[len] = arguments[i];",
                    "len++;",
                "}",
                "o.length = len;",
                "return len;",
                "}",
            "});",
            
            "Object.defineProperty(Array.prototype, 'shift',",
                "{configurable: true, writable: true, value:",
                "function shift() {",
                "if (!this) throw TypeError();",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "if (!len || len < 0) {",
                    "o.length = 0;",
                    "return undefined;",
                "}",
                "var value = o[0];",
                "for (var i = 0; i < len - 1; i++) {",
                    "o[i] = o[i + 1];",
                "}",
                "delete o[i];",  // Needed for non-arrays.
                "o.length = len - 1;",
                "return value;",
                "}",
            "});",
            
            "Object.defineProperty(Array.prototype, 'unshift',",
                "{configurable: true, writable: true, value:",
                "function unshift(var_args) {",
                "if (!this) throw TypeError();",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "if (!len || len < 0) {",
                    "len = 0;",
                "}",
                "for (var i = len - 1; i >= 0; i--) {",
                    "o[i + arguments.length] = o[i];",
                "}",
                "for (var i = 0; i < arguments.length; i++) {",
                    "o[i] = arguments[i];",
                "}",
                "return o.length = len + arguments.length;",
                "}",
            "});",
            
            "Object.defineProperty(Array.prototype, 'reverse',",
                "{configurable: true, writable: true, value:",
                "function reverse() {",
                "if (!this) throw TypeError();",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "if (!len || len < 2) {",
                    "return o;",  // Not an array, or too short to reverse.
                "}",
                "for (var i = 0; i < len / 2 - 0.5; i++) {",
                    "var x = o[i];",
                    "o[i] = o[len - i - 1];",
                    "o[len - i - 1] = x;",
                "}",
                "return o;",
                "}",
            "});",
            
            "Object.defineProperty(Array.prototype, 'indexOf',",
                "{configurable: true, writable: true, value:",
                "function indexOf(searchElement, fromIndex) {",
                "if (!this) throw TypeError();",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "var n = fromIndex | 0;",
                "if (!len || n >= len) {",
                    "return -1;",
                "}",
                "var i = Math.max(n >= 0 ? n : len - Math.abs(n), 0);",
                "while (i < len) {",
                    "if (i in o && o[i] === searchElement) {",
                    "return i;",
                    "}",
                    "i++;",
                "}",
                "return -1;",
                "}",
            "});",
            
            "Object.defineProperty(Array.prototype, 'lastIndexOf',",
                "{configurable: true, writable: true, value:",
                "function lastIndexOf(searchElement, fromIndex) {",
                "if (!this) throw TypeError();",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "if (!len) {",
                    "return -1;",
                "}",
                "var n = len - 1;",
                "if (arguments.length > 1) {",
                    "n = fromIndex | 0;",
                    "if (n) {",
                    "n = (n > 0 || -1) * Math.floor(Math.abs(n));",
                    "}",
                "}",
                "var i = n >= 0 ? Math.min(n, len - 1) : len - Math.abs(n);",
                "while (i >= 0) {",
                    "if (i in o && o[i] === searchElement) {",
                    "return i;",
                    "}",
                    "i--;",
                "}",
                "return -1;",
                "}",
            "});",
            
            "Object.defineProperty(Array.prototype, 'slice',",
                "{configurable: true, writable: true, value:",
                "function slice(start, end) {",
                "if (!this) throw TypeError();",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                // Handle negative value for "start"
                "start |= 0;",
                "start = (start >= 0) ? start : Math.max(0, len + start);",
                // Handle negative value for "end"
                "if (typeof end !== 'undefined') {",
                    "if (end !== Infinity) {",
                    "end |= 0;",
                    "}",
                    "if (end < 0) {",
                    "end = len + end;",
                    "} else {",
                    "end = Math.min(end, len);",
                    "}",
                "} else {",
                    "end = len;",
                "}",
                "var size = end - start;",
                "var cloned = [];",
                "for (var i = 0; i < size; i++) {",
                    "cloned[i] = o[start + i];",
                "}",
                "return cloned;",
                "}",
            "});",
            
            "Object.defineProperty(Array.prototype, 'splice',",
                "{configurable: true, writable: true, value:",
                "function splice(start, deleteCount, var_args) {",
                "if (!this) throw TypeError();",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "start |= 0;",
                "if (start < 0) {",
                    "start = Math.max(len + start, 0);",
                "} else {",
                    "start = Math.min(start, len);",
                "}",
                "if (arguments.length < 1) {",
                    "deleteCount = len - start;",
                "} else {",
                    "deleteCount |= 0;",
                    "deleteCount = Math.max(0, Math.min(deleteCount, len - start));",
                "}",
                "var removed = [];",
                // Remove specified elements.
                "for (var i = start; i < start + deleteCount; i++) {",
                    "removed[removed.length++] = o[i];",
                    "o[i] = o[i + deleteCount];",
                "}",
                // Move other element to fill the gap.
                "for (var i = start + deleteCount; i < len - deleteCount; i++) {",
                    "o[i] = o[i + deleteCount];",
                "}",
                // Delete superfluous properties.
                "for (var i = len - deleteCount; i < len; i++) {",
                    "delete o[i];",
                "}",
                "len -= deleteCount;",
                // Insert specified items.
                "for (var i = len - 1; i >= start; i--) {",
                    "o[i + arguments.length - 2] = o[i];",
                "}",
                "len += arguments.length - 2;",
                "for (var i = 2; i < arguments.length; i++) {",
                    "o[start + i - 2] = arguments[i];",
                "}",
                "o.length = len;",
                "return removed;",
                "}",
            "});",
            
            "Object.defineProperty(Array.prototype, 'concat',",
                "{configurable: true, writable: true, value:",
                "function concat(var_args) {",
                "if (!this) throw TypeError();",
                "var o = Object(this);",
                "var cloned = [];",
                "for (var i = -1; i < arguments.length; i++) {",
                    "var value = (i === -1) ? o : arguments[i];",
                    "if (Array.isArray(value)) {",
                    "cloned.push.apply(cloned, value);",
                    "} else {",
                    "cloned.push(value);",
                    "}",
                "}",
                "return cloned;",
                "}",
            "});",
            
            "Object.defineProperty(Array.prototype, 'join',",
                "{configurable: true, writable: true, value:",
                "function join(opt_separator) {",
                "if (!this) throw TypeError();",
                "var o = Object(this);",
                "var sep = typeof opt_separator === 'undefined' ?",
                    "',' : ('' + opt_separator);",
                "var str = '';",
                "for (var i = 0; i < o.length; i++) {",
                    "if (i && sep) {",
                    "str += sep;",
                    "}",
                    "str += o[i];",
                "}",
                "return str;",
                "}",
            "});",
            
            // Polyfill copied from:
            // developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/every
            "Object.defineProperty(Array.prototype, 'every',",
                "{configurable: true, writable: true, value:",
                "function every(callbackfn, thisArg) {",
                "if (!this || typeof callbackfn !== 'function') throw TypeError();",
                "var t, k;",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "if (arguments.length > 1) t = thisArg;",
                "k = 0;",
                "while (k < len) {",
                    "if (k in o && !callbackfn.call(t, o[k], k, o)) return false;",
                    "k++;",
                "}",
                "return true;",
                "}",
            "});",
            
            // Polyfill copied from:
            // developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/filter
            "Object.defineProperty(Array.prototype, 'filter',",
                "{configurable: true, writable: true, value:",
                "function filter(fun, var_args) {",
                "if (this === void 0 || this === null || typeof fun !== 'function') throw TypeError();",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "var res = [];",
                "var thisArg = arguments.length >= 2 ? arguments[1] : void 0;",
                "for (var i = 0; i < len; i++) {",
                    "if (i in o) {",
                    "var val = o[i];",
                    "if (fun.call(thisArg, val, i, o)) res.push(val);",
                    "}",
                "}",
                "return res;",
                "}",
            "});",
            
            // Polyfill copied from:
            // developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/forEach
            "Object.defineProperty(Array.prototype, 'forEach',",
                "{configurable: true, writable: true, value:",
                "function forEach(callback, thisArg) {",
                "if (!this || typeof callback !== 'function') throw TypeError();",
                "var t, k;",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "if (arguments.length > 1) t = thisArg;",
                "k = 0;",
                "while (k < len) {",
                    "if (k in o) callback.call(t, o[k], k, o);",
                    "k++;",
                "}",
                "}",
            "});",
            
            // Polyfill copied from:
            // developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/map
            "Object.defineProperty(Array.prototype, 'map',",
                "{configurable: true, writable: true, value:",
                "function map(callback, thisArg) {",
                "if (!this || typeof callback !== 'function') throw TypeError();",
                "var t, a, k;",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "if (arguments.length > 1) t = thisArg;",
                "a = new Array(len);",
                "k = 0;",
                "while (k < len) {",
                    "if (k in o) a[k] = callback.call(t, o[k], k, o);",
                    "k++;",
                "}",
                "return a;",
                "}",
            "});",
            
            // Polyfill copied from:
            // developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/Reduce
            "Object.defineProperty(Array.prototype, 'reduce',",
                "{configurable: true, writable: true, value:",
                "function reduce(callback /*, initialValue*/) {",
                "if (!this || typeof callback !== 'function') throw TypeError();",
                "var o = Object(this), len = o.length >>> 0, k = 0, value;",
                "if (arguments.length === 2) {",
                    "value = arguments[1];",
                "} else {",
                    "while (k < len && !(k in o)) k++;",
                    "if (k >= len) {",
                    "throw TypeError('Reduce of empty array with no initial value');",
                    "}",
                    "value = o[k++];",
                "}",
                "for (; k < len; k++) {",
                    "if (k in o) value = callback(value, o[k], k, o);",
                "}",
                "return value;",
                "}",
            "});",
            
            // Polyfill copied from:
            // developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/ReduceRight
            "Object.defineProperty(Array.prototype, 'reduceRight',",
                "{configurable: true, writable: true, value:",
                "function reduceRight(callback /*, initialValue*/) {",
                "if (null === this || 'undefined' === typeof this || 'function' !== typeof callback) throw TypeError();",
                "var o = Object(this), len = o.length >>> 0, k = len - 1, value;",
                "if (arguments.length >= 2) {",
                    "value = arguments[1];",
                "} else {",
                    "while (k >= 0 && !(k in o)) k--;",
                    "if (k < 0) {",
                    "throw TypeError('Reduce of empty array with no initial value');",
                    "}",
                    "value = o[k--];",
                "}",
                "for (; k >= 0; k--) {",
                    "if (k in o) value = callback(value, o[k], k, o);",
                "}",
                "return value;",
                "}",
            "});",
            
            // Polyfill copied from:
            // developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/some
            "Object.defineProperty(Array.prototype, 'some',",
                "{configurable: true, writable: true, value:",
                "function some(fun/*, thisArg*/) {",
                "if (!this || typeof fun !== 'function') throw TypeError();",
                "var o = Object(this);",
                "var len = o.length >>> 0;",
                "var thisArg = arguments.length >= 2 ? arguments[1] : void 0;",
                "for (var i = 0; i < len; i++) {",
                    "if (i in o && fun.call(thisArg, o[i], i, o)) {",
                    "return true;",
                    "}",
                "}",
                "return false;",
                "}",
            "});",
            
            
            "Object.defineProperty(Array.prototype, 'sort',",
                "{configurable: true, writable: true, value:",
                "function sort(opt_comp) {",  // Bubble sort!
                "if (!this) throw TypeError();",
                "if (typeof opt_comp !== 'function') {",
                    "opt_comp = undefined;",
                "}",
                "for (var i = 0; i < this.length; i++) {",
                    "var changes = 0;",
                    "for (var j = 0; j < this.length - i - 1; j++) {",
                    "if (opt_comp ? (opt_comp(this[j], this[j + 1]) > 0) :",
                        "(String(this[j]) > String(this[j + 1]))) {",
                        "var swap = this[j];",
                        "this[j] = this[j + 1];",
                        "this[j + 1] = swap;",
                        "changes++;",
                    "}",
                    "}",
                    "if (!changes) break;",
                "}",
                "return this;",
                "}",
            "});",
            
            "Object.defineProperty(Array.prototype, 'toLocaleString',",
                "{configurable: true, writable: true, value:",
                "function toLocaleString() {",
                "if (!this) throw TypeError();",
                "var o = Object(this);",
                "var out = [];",
                "for (var i = 0; i < o.length; i++) {",
                    "out[i] = (o[i] === null || o[i] === undefined) ? '' : o[i].toLocaleString();",
                "}",
                "return out.join(',');",
                "}",
            "});",
            "");
        }
  
    /**
     * Initialize the String class.
     * @param {!Interpreter.Object} globalObject Global object.
     */
    initString(globalObject) {
        const thisInterpreter: Interpreter = this;
        let wrapper;
        // String constructor.
        wrapper = function String(value) {
            value = arguments.length ? nativeGlobal.String(value) : '';
            if (thisInterpreter.calledWithNew()) {
                // Called as `new String()`.
                this.data = value;
                return this;
            } else {
                // Called as `String()`.
                return value;
            }
        };
        this.STRING = this.createNativeFunction(wrapper, true);
        this.setProperty(globalObject, 'String', this.STRING,
            NONENUMERABLE_DESCRIPTOR);
  
        // Static methods on String.
        this.setProperty(this.STRING, 'fromCharCode',
            this.createNativeFunction(String.fromCharCode, false),
            NONENUMERABLE_DESCRIPTOR);
    
        // Instance methods on String.
        // Methods with exclusively primitive arguments.
        const functions = ['charAt', 'charCodeAt', 'concat', 'indexOf', 'lastIndexOf',
            'slice', 'substr', 'substring', 'toLocaleLowerCase', 'toLocaleUpperCase',
            'toLowerCase', 'toUpperCase', 'trim'];
        for (let i = 0; i < functions.length; i++) {
            this.setNativeFunctionPrototype(this.STRING, functions[i],
                                        String.prototype[functions[i]]);
        }
    
        wrapper = function localeCompare(compareString, locales, options) {
            locales = thisInterpreter.pseudoToNative(locales);
            options = thisInterpreter.pseudoToNative(options);
            try {
                return String(this).localeCompare(compareString, locales, options);
            } catch (e) {
                thisInterpreter.throwException(thisInterpreter.ERROR,
                    'localeCompare: ' + e.message);
            }
        };
        this.setNativeFunctionPrototype(this.STRING, 'localeCompare', wrapper);
    
        wrapper = function split(separator, limit, callback) {
            const string = String(this);
            limit = limit ? Number(limit) : undefined;
            // Example of catastrophic split RegExp:
            // 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaac'.split(/^(a+)+b/)
            if (thisInterpreter.isa(separator, thisInterpreter.REGEXP)) {
                separator = separator.data;
                thisInterpreter.maybeThrowRegExp(separator, callback);
                if (thisInterpreter['REGEXP_MODE'] === 2) {
                if (nodevm) {
                    // Run split in vm.
                    const sandbox = {
                        'string': string,
                        'separator': separator,
                        'limit': limit
                    };
                    const code = 'string.split(separator, limit)';
                    const jsList =
                        thisInterpreter.vmCall(code, sandbox, separator, callback);
                    if (jsList !== REGEXP_TIMEOUT) {
                        callback(thisInterpreter.arrayNativeToPseudo(jsList));
                    }
                } else {
                    // Run split in separate thread.
                    const splitWorker = thisInterpreter.createWorker();
                    const pid = thisInterpreter.regExpTimeout(separator, splitWorker,
                        callback);
                    splitWorker.onmessage = function(e) {
                    clearTimeout(pid);
                    callback(thisInterpreter.arrayNativeToPseudo(e.data));
                    };
                    splitWorker.postMessage(['split', string, separator, limit]);
                }
                return;
                }
            }
            // Run split natively.
            const jsList = string.split(separator, limit);
            callback(thisInterpreter.arrayNativeToPseudo(jsList));
        };
        this.setAsyncFunctionPrototype(this.STRING, 'split', wrapper);
    
        wrapper = function match(regexp, callback) {
            const string = String(this);
            if (thisInterpreter.isa(regexp, thisInterpreter.REGEXP)) {
                regexp = regexp.data;
            } else {
                regexp = new RegExp(regexp);
            }
            // Example of catastrophic match RegExp:
            // 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaac'.match(/^(a+)+b/)
            thisInterpreter.maybeThrowRegExp(regexp, callback);
            if (thisInterpreter['REGEXP_MODE'] === 2) {
                if (nodevm) {
                    // Run match in vm.
                    const sandbox = {
                        'string': string,
                        'regexp': regexp
                    };
                    const code = 'string.match(regexp)';
                    const m = thisInterpreter.vmCall(code, sandbox, regexp, callback);
                    if (m !== REGEXP_TIMEOUT) {
                        callback(m && thisInterpreter.arrayNativeToPseudo(m));
                    }
                } else {
                    // Run match in separate thread.
                    const matchWorker = thisInterpreter.createWorker();
                    const pid = thisInterpreter.regExpTimeout(regexp, matchWorker, callback);
                    matchWorker.onmessage = function(e) {
                        clearTimeout(pid);
                        callback(e.data && thisInterpreter.arrayNativeToPseudo(e.data));
                    };
                    matchWorker.postMessage(['match', string, regexp]);
                }
                return;
            }
            // Run match natively.
            const match = string.match(regexp);
            callback(match && thisInterpreter.arrayNativeToPseudo(match));
        };
        this.setAsyncFunctionPrototype(this.STRING, 'match', wrapper);
    
        wrapper = function search(regexp, callback) {
            const string = String(this);
            if (thisInterpreter.isa(regexp, thisInterpreter.REGEXP)) {
                regexp = regexp.data;
            } else {
                regexp = new RegExp(regexp);
            }
            // Example of catastrophic search RegExp:
            // 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaac'.search(/^(a+)+b/)
            thisInterpreter.maybeThrowRegExp(regexp, callback);
            if (thisInterpreter['REGEXP_MODE'] === 2) {
                if (nodevm) {
                    // Run search in vm.
                    const sandbox = {
                        'string': string,
                        'regexp': regexp
                    };
                    const code = 'string.search(regexp)';
                    const n = thisInterpreter.vmCall(code, sandbox, regexp, callback);
                    if (n !== REGEXP_TIMEOUT) {
                        callback(n);
                    }
                } else {
                    // Run search in separate thread.
                    const searchWorker = thisInterpreter.createWorker();
                    const pid = thisInterpreter.regExpTimeout(regexp, searchWorker, callback);
                    searchWorker.onmessage = function(e) {
                        clearTimeout(pid);
                        callback(e.data);
                    };
                    searchWorker.postMessage(['search', string, regexp]);
                }
                return;
            }
            // Run search natively.
            callback(string.search(regexp));
        };
        this.setAsyncFunctionPrototype(this.STRING, 'search', wrapper);
    
        wrapper = function replace_(substr, newSubstr, callback) {
            // Support for function replacements is the responsibility of a polyfill.
            const string = String(this);
            newSubstr = String(newSubstr);
            // Example of catastrophic replace RegExp:
            // 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaac'.replace(/^(a+)+b/, '')
            if (thisInterpreter.isa(substr, thisInterpreter.REGEXP)) {
                substr = substr.data;
                thisInterpreter.maybeThrowRegExp(substr, callback);
                if (thisInterpreter['REGEXP_MODE'] === 2) {
                    if (nodevm) {
                        // Run replace in vm.
                        const sandbox = {
                        'string': string,
                        'substr': substr,
                        'newSubstr': newSubstr
                        };
                        const code = 'string.replace(substr, newSubstr)';
                        const str = thisInterpreter.vmCall(code, sandbox, substr, callback);
                        if (str !== REGEXP_TIMEOUT) {
                            callback(str);
                        }
                    } else {
                        // Run replace in separate thread.
                        const replaceWorker = thisInterpreter.createWorker();
                        const pid = thisInterpreter.regExpTimeout(substr, replaceWorker,
                            callback);
                        replaceWorker.onmessage = function(e) {
                        clearTimeout(pid);
                        callback(e.data);
                        };
                        replaceWorker.postMessage(['replace', string, substr, newSubstr]);
                    }
                    return;
                }
            }
            // Run replace natively.
            callback(string.replace(substr, newSubstr));
        };
        this.setAsyncFunctionPrototype(this.STRING, 'replace', wrapper);
        // Add a polyfill to handle replace's second argument being a function.
        this.polyfills_.push(
        "(function() {",
            "var replace_ = String.prototype.replace;",
            "String.prototype.replace = function replace(substr, newSubstr) {",
            "if (typeof newSubstr !== 'function') {",
                // string.replace(string|regexp, string)
                "return replace_.call(this, substr, newSubstr);",
            "}",
            "var str = this;",
            "if (substr instanceof RegExp) {",  // string.replace(regexp, function)
                "var subs = [];",
                "var m = substr.exec(str);",
                "while (m) {",
                "m.push(m.index, str);",
                "var inject = newSubstr.apply(null, m);",
                "subs.push([m.index, m[0].length, inject]);",
                "m = substr.global ? substr.exec(str) : null;",
                "}",
                "for (var i = subs.length - 1; i >= 0; i--) {",
                "str = str.substring(0, subs[i][0]) + subs[i][2] + " +
                    "str.substring(subs[i][0] + subs[i][1]);",
                "}",
            "} else {",                         // string.replace(string, function)
                "var i = str.indexOf(substr);",
                "if (i !== -1) {",
                "var inject = newSubstr(str.substr(i, substr.length), i, str);",
                "str = str.substring(0, i) + inject + " +
                    "str.substring(i + substr.length);",
                "}",
            "}",
            "return str;",
            "};",
        "})();",
        "");
    }
  
    /**
     * Initialize the Boolean class.
     * @param {!Interpreter.Object} globalObject Global object.
     */
    initBoolean(globalObject) {
        const thisInterpreter = this;
        // Boolean constructor.
        const wrapper = function Boolean(value) {
            value = nativeGlobal.Boolean(value);
            if (thisInterpreter.calledWithNew()) {
                // Called as `new Boolean()`.
                this.data = value;
                return this;
            } else {
                // Called as `Boolean()`.
                return value;
            }
        };
        this.BOOLEAN = this.createNativeFunction(wrapper, true);
        this.setProperty(globalObject, 'Boolean', this.BOOLEAN,
            NONENUMERABLE_DESCRIPTOR);
    }
  
  /**
   * Initialize the Number class.
   * @param {!Interpreter.Object} globalObject Global object.
   */
    initNumber(globalObject) {
        const thisInterpreter = this;
        let wrapper;
        // Number constructor.
        wrapper = function Number(value) {
            value = arguments.length ? nativeGlobal.Number(value) : 0;
            if (thisInterpreter.calledWithNew()) {
                // Called as `new Number()`.
                this.data = value;
                return this;
            } else {
                // Called as `Number()`.
                return value;
            }
        };
        this.NUMBER = this.createNativeFunction(wrapper, true);
        this.setProperty(globalObject, 'Number', this.NUMBER,
            NONENUMERABLE_DESCRIPTOR);
  
        const numConsts = ['MAX_VALUE', 'MIN_VALUE', 'NaN', 'NEGATIVE_INFINITY',
                        'POSITIVE_INFINITY'];
        for (let i = 0; i < numConsts.length; i++) {
            this.setProperty(this.NUMBER, numConsts[i], Number[numConsts[i]],
                NONCONFIGURABLE_READONLY_NONENUMERABLE_DESCRIPTOR);
        }
  
        // Instance methods on Number.
        wrapper = function toExponential(fractionDigits) {
        try {
                return Number(this).toExponential(fractionDigits);
        } catch (e) {
            // Throws if fractionDigits isn't within 0-20.
                thisInterpreter.throwException(thisInterpreter.ERROR, e.message);
        }
        };
        this.setNativeFunctionPrototype(this.NUMBER, 'toExponential', wrapper);
    
        wrapper = function toFixed(digits) {
        try {
            return Number(this).toFixed(digits);
        } catch (e) {
            // Throws if digits isn't within 0-20.
            thisInterpreter.throwException(thisInterpreter.ERROR, e.message);
        }
        };
        this.setNativeFunctionPrototype(this.NUMBER, 'toFixed', wrapper);
    
        wrapper = function toPrecision(precision) {
            try {
                return Number(this).toPrecision(precision);
            } catch (e) {
                // Throws if precision isn't within range (depends on implementation).
                thisInterpreter.throwException(thisInterpreter.ERROR, e.message);
            }
        };
        this.setNativeFunctionPrototype(this.NUMBER, 'toPrecision', wrapper);
  
        wrapper = function toString(radix) {
            try {
                return Number(this).toString(radix);
            } catch (e) {
                // Throws if radix isn't within 2-36.
                thisInterpreter.throwException(thisInterpreter.ERROR, e.message);
            }
        };
        this.setNativeFunctionPrototype(this.NUMBER, 'toString', wrapper);
  
        wrapper = function toLocaleString(locales, options) {
            locales = locales ? thisInterpreter.pseudoToNative(locales) : undefined;
            options = options ? thisInterpreter.pseudoToNative(options) : undefined;
            return Number(this).toLocaleString(locales, options);
        };
        this.setNativeFunctionPrototype(this.NUMBER, 'toLocaleString', wrapper);
    }
  
    /**
     * Initialize the Date class.
     * @param {!Interpreter.Object} globalObject Global object.
     */
    initDate(globalObject) {
        const thisInterpreter = this;
        let wrapper;
        // Date constructor.
        wrapper = function Date(value, ...var_args) {
            if (!thisInterpreter.calledWithNew()) {
                // Called as `Date()`.
                // Calling Date() as a function returns a string, no arguments are heeded.
                return nativeGlobal.Date();
            }
            // Called as `new Date()`.
            const args = [null].concat(Array.from(var_args));
            this.data = new (Function.prototype.bind.apply(
                nativeGlobal.Date, args));
            return this;
        };
        this.DATE = this.createNativeFunction(wrapper, true);
        this.DATE_PROTO = this.DATE.properties['prototype'];
        this.setProperty(globalObject, 'Date', this.DATE,
            NONENUMERABLE_DESCRIPTOR);
    
        // Static methods on Date.
        this.setProperty(this.DATE, 'now', this.createNativeFunction(Date.now, false),
            NONENUMERABLE_DESCRIPTOR);
    
        this.setProperty(this.DATE, 'parse',
            this.createNativeFunction(Date.parse, false),
            NONENUMERABLE_DESCRIPTOR);
    
        this.setProperty(this.DATE, 'UTC', this.createNativeFunction(Date.UTC, false),
            NONENUMERABLE_DESCRIPTOR);
    
        // Instance methods on Date.
        const functions = ['getDate', 'getDay', 'getFullYear', 'getHours',
            'getMilliseconds', 'getMinutes', 'getMonth', 'getSeconds', 'getTime',
            'getTimezoneOffset', 'getUTCDate', 'getUTCDay', 'getUTCFullYear',
            'getUTCHours', 'getUTCMilliseconds', 'getUTCMinutes', 'getUTCMonth',
            'getUTCSeconds', 'getYear',
            'setDate', 'setFullYear', 'setHours', 'setMilliseconds',
            'setMinutes', 'setMonth', 'setSeconds', 'setTime', 'setUTCDate',
            'setUTCFullYear', 'setUTCHours', 'setUTCMilliseconds', 'setUTCMinutes',
            'setUTCMonth', 'setUTCSeconds', 'setYear',
            'toDateString', 'toISOString', 'toJSON', 'toGMTString',
            'toLocaleDateString', 'toLocaleString', 'toLocaleTimeString',
            'toTimeString', 'toUTCString'];
        for (let i = 0; i < functions.length; i++) {
            wrapper = (function(nativeFunc) {
                return function(...var_args) {
                    const date = this.data;
                    if (!(date instanceof Date)) {
                        thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                            nativeFunc + ' not called on a Date');
                    }
                    const args = [];
                    for (let i = 0; i < var_args.length; i++) {
                        args[i] = thisInterpreter.pseudoToNative(var_args[i]);
                    }
                    return date[nativeFunc](...args);
                };
            })(functions[i]);
            this.setNativeFunctionPrototype(this.DATE, functions[i], wrapper);
        }
    }
  
    /**
     * Initialize Regular Expression object.
     * @param {!Interpreter.Object} globalObject Global object.
     */
    initRegExp(globalObject) {
        const thisInterpreter = this;
        let wrapper;
        // RegExp constructor.
        wrapper = function RegExp(pattern, flags) {
            let rgx;
            if (thisInterpreter.calledWithNew()) {
                // Called as `new RegExp()`.
                rgx = this;
            } else {
                // Called as `RegExp()`.
                rgx = thisInterpreter.createObjectProto(thisInterpreter.REGEXP_PROTO);
            }
            pattern = pattern ? String(pattern) : '';
            flags = flags ? String(flags) : '';
            thisInterpreter.populateRegExp(rgx,
                new nativeGlobal.RegExp(pattern, flags));
            return rgx;
        };
        this.REGEXP = this.createNativeFunction(wrapper, true);
        this.REGEXP_PROTO = this.REGEXP.properties['prototype'];
        this.setProperty(globalObject, 'RegExp', this.REGEXP,
            NONENUMERABLE_DESCRIPTOR);
  
        this.setProperty(this.REGEXP.properties['prototype'], 'global', undefined,
            READONLY_NONENUMERABLE_DESCRIPTOR);
        this.setProperty(this.REGEXP.properties['prototype'], 'ignoreCase', undefined,
            READONLY_NONENUMERABLE_DESCRIPTOR);
        this.setProperty(this.REGEXP.properties['prototype'], 'multiline', undefined,
            READONLY_NONENUMERABLE_DESCRIPTOR);
        this.setProperty(this.REGEXP.properties['prototype'], 'source', '(?:)',
            READONLY_NONENUMERABLE_DESCRIPTOR);
  
        // Use polyfill to avoid complexity of regexp threads.
        this.polyfills_.push(
        "Object.defineProperty(RegExp.prototype, 'test',",
            "{configurable: true, writable: true, value:",
            "function test(str) {",
            "return String(str).search(this) !== -1",
            "}",
        "});");
  
        wrapper = function exec(string, callback) {
            const regexp = this.data;
            string = String(string);
            // Get lastIndex from wrapped regexp, since this is settable.
            regexp.lastIndex = Number(thisInterpreter.getProperty(this, 'lastIndex'));
            // Example of catastrophic exec RegExp:
            // /^(a+)+b/.exec('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaac')
            thisInterpreter.maybeThrowRegExp(regexp, callback);
            if (thisInterpreter['REGEXP_MODE'] === 2) {
                if (nodevm) {
                    // Run exec in vm.
                    const sandbox = {
                        'string': string,
                        'regexp': regexp
                    };
                    const code = 'regexp.exec(string)';
                    const match = thisInterpreter.vmCall(code, sandbox, regexp, callback);
                    if (match !== REGEXP_TIMEOUT) {
                        thisInterpreter.setProperty(this, 'lastIndex', regexp.lastIndex);
                        callback(matchToPseudo(match));
                    }
                } else {
                    // Run exec in separate thread.
                    // Note that lastIndex is not preserved when a RegExp is passed to a
                    // Web Worker.  Thus it needs to be passed back and forth separately.
                    const execWorker = thisInterpreter.createWorker();
                    const pid = thisInterpreter.regExpTimeout(regexp, execWorker, callback);
                    const thisPseudoRegExp = this;
                    execWorker.onmessage = function(e) {
                            clearTimeout(pid);
                            // Return tuple: [result, lastIndex]
                            thisInterpreter.setProperty(thisPseudoRegExp, 'lastIndex', e.data[1]);
                            callback(matchToPseudo(e.data[0]));
                    };
                    execWorker.postMessage(['exec', regexp, regexp.lastIndex, string]);
                }
                return;
            }
            // Run exec natively.
            const match = regexp.exec(string);
            thisInterpreter.setProperty(this, 'lastIndex', regexp.lastIndex);
            callback(matchToPseudo(match));
        
            function matchToPseudo(match) {
                if (match) {
                    const result = thisInterpreter.arrayNativeToPseudo(match);
                    // match has additional properties.
                    thisInterpreter.setProperty(result, 'index', match.index);
                    thisInterpreter.setProperty(result, 'input', match.input);
                    return result;
                }
                return null;
            }
        };
        this.setAsyncFunctionPrototype(this.REGEXP, 'exec', wrapper);
    }
    
    /**
     * Initialize the Error class.
     * @param {!Interpreter.Object} globalObject Global object.
     */
    initError(globalObject) {
        const thisInterpreter = this;
        // Error constructor.
        this.ERROR = this.createNativeFunction(function Error(opt_message) {
            let newError;
            if (thisInterpreter.calledWithNew()) {
                // Called as `new Error()`.
                newError = this;
            } else {
                // Called as `Error()`.
                newError = thisInterpreter.createObject(thisInterpreter.ERROR);
            }
            if (opt_message) {
                thisInterpreter.setProperty(newError, 'message', String(opt_message),
                    NONENUMERABLE_DESCRIPTOR);
            }
            return newError;
            }, true);
        this.setProperty(globalObject, 'Error', this.ERROR,
            NONENUMERABLE_DESCRIPTOR);
        this.setProperty(this.ERROR.properties['prototype'], 'message', '',
            NONENUMERABLE_DESCRIPTOR);
        this.setProperty(this.ERROR.properties['prototype'], 'name', 'Error',
            NONENUMERABLE_DESCRIPTOR);
    
        function createErrorSubclass(name) {
            const constructor = thisInterpreter.createNativeFunction(
                function(opt_message) {
                    let newError;
                    if (thisInterpreter.calledWithNew()) {
                        // Called as `new XyzError()`.
                        newError = this;
                    } else {
                        // Called as `XyzError()`.
                        newError = thisInterpreter.createObject(constructor);
                    }
                    if (opt_message) {
                        thisInterpreter.setProperty(newError, 'message',
                            String(opt_message), NONENUMERABLE_DESCRIPTOR);
                    }
                    return newError;
                }, true);
            thisInterpreter.setProperty(constructor, 'prototype',
                thisInterpreter.createObject(thisInterpreter.ERROR),
                NONENUMERABLE_DESCRIPTOR);
            thisInterpreter.setProperty(constructor.properties['prototype'], 'name',
                name, NONENUMERABLE_DESCRIPTOR);
            thisInterpreter.setProperty(globalObject, name, constructor,
                NONENUMERABLE_DESCRIPTOR);
        
            return constructor;
        }
  
        this.EVAL_ERROR = createErrorSubclass('EvalError');
        this.RANGE_ERROR = createErrorSubclass('RangeError');
        this.REFERENCE_ERROR = createErrorSubclass('ReferenceError');
        this.SYNTAX_ERROR = createErrorSubclass('SyntaxError');
        this.TYPE_ERROR = createErrorSubclass('TypeError');
        this.URI_ERROR = createErrorSubclass('URIError');
    }
  
    /**
     * Initialize Math object.
     * @param {!Interpreter.Object} globalObject Global object.
     */
    initMath(globalObject) {
        const myMath = this.createObjectProto(this.OBJECT_PROTO);
        this.setProperty(globalObject, 'Math', myMath,
            NONENUMERABLE_DESCRIPTOR);
        const mathConsts = ['E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI',
                        'SQRT1_2', 'SQRT2'];
        for (let i = 0; i < mathConsts.length; i++) {
            this.setProperty(myMath, mathConsts[i], Math[mathConsts[i]],
                READONLY_NONENUMERABLE_DESCRIPTOR);
        }
        const numFunctions = ['abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos',
                            'exp', 'floor', 'log', 'max', 'min', 'pow', 'random',
                            'round', 'sin', 'sqrt', 'tan'];
        for (let i = 0; i < numFunctions.length; i++) {
            this.setProperty(myMath, numFunctions[i],
                this.createNativeFunction(Math[numFunctions[i]], false),
                NONENUMERABLE_DESCRIPTOR);
        }
    }
  
    /**
     * Initialize JSON object.
     * @param {!Interpreter.Object} globalObject Global object.
     */
    initJSON(globalObject) {
        const thisInterpreter = this;
        const myJSON = thisInterpreter.createObjectProto(this.OBJECT_PROTO);
        this.setProperty(globalObject, 'JSON', myJSON,
            NONENUMERABLE_DESCRIPTOR);
    
        const wrapper = function parse(text) {
            let nativeObj;
            try {
                nativeObj = JSON.parse(String(text));
            } catch (e) {
                thisInterpreter.throwException(thisInterpreter.SYNTAX_ERROR, e.message);
            }
            return thisInterpreter.nativeToPseudo(nativeObj);
        };
        this.setProperty(myJSON, 'parse', this.createNativeFunction(wrapper, false));
    
        const stringifyWrapper = function stringify(value, replacer, space) {
            if (replacer && replacer.class === 'Function') {
                thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                    'Function replacer on JSON.stringify not supported');
            } else if (replacer && replacer.class === 'Array') {
                replacer = thisInterpreter.arrayPseudoToNative(replacer);
                replacer = replacer.filter(function(word) {
                // Spec says we should also support boxed primitives here.
                return typeof word === 'string' || typeof word === 'number';
                });
            } else {
                replacer = null;
            }
            // Spec says we should also support boxed primitives here.
            if (typeof space !== 'string' && typeof space !== 'number') {
                space = undefined;
            }
        
            const nativeObj = thisInterpreter.pseudoToNative(value);
            let str;
            try {
                str = JSON.stringify(nativeObj, replacer, space);
            } catch (e) {
                thisInterpreter.throwException(thisInterpreter.TYPE_ERROR, e.message);
            }
            return str;
        };
        this.setProperty(myJSON, 'stringify',
            this.createNativeFunction(stringifyWrapper, false));
    }

    /**
     * Is an object of a certain class?
     * @param {Interpreter.Value} child Object to check.
     * @param {Interpreter.Object} constructor Constructor of object.
     * @return {boolean} True if object is the class or inherits from it.
     *     False otherwise.
     */
    isa(child, constructor) {
        if (child === null || child === undefined || !constructor) {
            return false;
        }
        const proto = constructor.properties['prototype'];
        if (child === proto) {
            return true;
        }
        // The first step up the prototype chain is harder since the child might be
        // a primitive value.  Subsequent steps can just follow the .proto property.
        child = this.getPrototype(child);
        while (child) {
            if (child === proto) {
                return true;
            }
            child = child.proto;
        }
        return false;
    }
  
    /**
     * Initialize a pseudo regular expression object based on a native regular
     * expression object.
     * @param {!Interpreter.Object} pseudoRegexp The existing object to set.
     * @param {!RegExp} nativeRegexp The native regular expression.
     */
    populateRegExp(pseudoRegexp, nativeRegexp) {
        pseudoRegexp.data = new RegExp(nativeRegexp.source, nativeRegexp.flags);
        // lastIndex is settable, all others are read-only attributes
        this.setProperty(pseudoRegexp, 'lastIndex', nativeRegexp.lastIndex,
            NONENUMERABLE_DESCRIPTOR);
        this.setProperty(pseudoRegexp, 'source', nativeRegexp.source,
            READONLY_NONENUMERABLE_DESCRIPTOR);
        this.setProperty(pseudoRegexp, 'global', nativeRegexp.global,
            READONLY_NONENUMERABLE_DESCRIPTOR);
        this.setProperty(pseudoRegexp, 'ignoreCase', nativeRegexp.ignoreCase,
            READONLY_NONENUMERABLE_DESCRIPTOR);
        this.setProperty(pseudoRegexp, 'multiline', nativeRegexp.multiline,
            READONLY_NONENUMERABLE_DESCRIPTOR);
    }

    static createWorkerBlob: any;
  
    /**
     * Create a Web Worker to execute regular expressions.
     * Using a separate file fails in Chrome when run locally on a file:// URI.
     * Using a data encoded URI fails in IE and Edge.
     * Using a blob works in IE11 and all other browsers.
     * @return {!Worker} Web Worker with regexp execution code loaded.
     */
    createWorker() {
        let blob = Interpreter.createWorkerBlob;
        if (!blob) {
            blob = new Blob([WORKER_CODE.join('\n')],
                {type: 'application/javascript'});
            // Cache the blob, so it doesn't need to be created next time.
            Interpreter.createWorkerBlob = blob;
        }
        return new Worker(URL.createObjectURL(blob));
    }
  
    /**
     * Execute regular expressions in a node vm.
     * @param {string} code Code to execute.
     * @param {!Object} sandbox Global variables for new vm.
     * @param {!RegExp} nativeRegExp Regular expression.
     * @param {!Function} callback Asynchronous callback function.
     */
    vmCall(code, sandbox, nativeRegExp, callback) {
        const options = {'timeout': this['REGEXP_THREAD_TIMEOUT']};
        try {
            return nodevm['runInNewContext'](code, sandbox, options);
        } catch (e) {
            callback(null);
            this.throwException(this.ERROR, 'RegExp Timeout: ' + nativeRegExp);
        }
        return REGEXP_TIMEOUT;
    }
  
    /**
     * If REGEXP_MODE is 0, then throw an error.
     * Also throw if REGEXP_MODE is 2 and JS doesn't support Web Workers or vm.
     * @param {!RegExp} nativeRegExp Regular expression.
     * @param {!Function} callback Asynchronous callback function.
     */
    maybeThrowRegExp(nativeRegExp, callback) {
        let ok;
        if (this['REGEXP_MODE'] === 0) {
            // Fail: No RegExp support.
            ok = false;
        } else if (this['REGEXP_MODE'] === 1) {
            // Ok: Native RegExp support.
            ok = true;
        } else {
            // Sandboxed RegExp handling.
            if (nodevm) {
                // Ok: Node's vm module already loaded.
                ok = true;
            } else if (typeof Worker === 'function' && typeof URL === 'function') {
                // Ok: Web Workers available.
                ok = true;
            } else if (typeof require === 'function') {
                // Try to load Node's vm module.
                ok = !!nodevm;
            } else {
                // Fail: Neither Web Workers nor vm available.
                ok = false;
            }
        }
        if (!ok) {
            callback(null);
            this.throwException(this.ERROR, 'Regular expressions not supported: ' +
                nativeRegExp);
        }
    }
  
    /**
     * Set a timeout for regular expression threads.  Unless cancelled, this will
     * terminate the thread and throw an error.
     * @param {!RegExp} nativeRegExp Regular expression (used for error message).
     * @param {!Worker} worker Thread to terminate.
     * @param {!Function} callback Async callback function to continue execution.
     * @return {number} PID of timeout.  Used to cancel if thread completes.
     */
    regExpTimeout(nativeRegExp, worker, callback) {
        const thisInterpreter = this;
        return setTimeout(function() {
            worker.terminate();
            callback(null);
            try {
            thisInterpreter.throwException(thisInterpreter.ERROR,
                'RegExp Timeout: ' + nativeRegExp);
            } catch (e) {
            // Eat the expected Interpreter.STEP_ERROR.
            }
        }, this['REGEXP_THREAD_TIMEOUT']);
    }
  

    /**
     * Execute the interpreter to program completion.  Vulnerable to infinite loops.
     * @return {boolean} True if a execution is asynchronously blocked,
     *     false if no more instructions.
     */
    run() {
        while (!this.paused_ && this.step()) {
            // Relies on side effect of step
        }
        return this.paused_;
    }

    /**
     * Execute one step of the interpreter.
     * @return {boolean} True if a step was executed, false if no more instructions.
     */
    step() {
        const stack = this.stateStack;
        const startTime = Date.now();
        let node;
        do {
            const state = stack[stack.length - 1];
            if (!state) {
                return false;
            }
            node = state.node;
            const type = node['type'];
            if (type === 'Program' && state.done) {
                return false;
            } else if (this.paused_) {
                return true;
            }
            let nextState;
            try {
                nextState = this.stepFunctions_[type](stack, state, node);
            } catch (e) {
                // Eat any step errors.  They have been thrown on the stack.
                if (e !== STEP_ERROR) {
                // Uh oh.  This is a real error in the JS-Interpreter.  Rethrow.
                throw e;
                }
            }
            if (nextState) {
                stack.push(nextState);
            }
            if (this.getterStep_) {
                // Getter from this step was not handled.
                throw Error('Getter not supported in this context');
            }
            if (this.setterStep_) {
                // Setter from this step was not handled.
                throw Error('Setter not supported in this context');
            }
            // This may be polyfill code.  Keep executing until we arrive at user code.
        } while (!node['end'] && startTime + this['POLYFILL_TIMEOUT'] > Date.now());
        return true;
    }

    /**
     * Fetch a property value from a data object.
     * @param {Interpreter.Value} obj Data object.
     * @param {Interpreter.Value} name Name of property.
     * @return {Interpreter.Value} Property value (may be undefined).
     */
    getProperty(obj, name) {
        if (this.getterStep_) {
            throw Error('Getter not supported in that context');
        }
        name = String(name);
        if (obj === undefined || obj === null) {
            this.throwException(this.TYPE_ERROR,
                            "Cannot read property '" + name + "' of " + obj);
        }
        if (typeof obj === 'object' && !(obj instanceof InterpreterObject)) {
            throw TypeError('Expecting native value or pseudo object');
        }
        if (name === 'length') {
            // Special cases for magic length property.
            if (this.isa(obj, this.STRING)) {
                return String(obj).length;
            }
        } else if (name.charCodeAt(0) < 0x40) {
            // Might have numbers in there?
            // Special cases for string array indexing
            if (this.isa(obj, this.STRING)) {
                const n = legalArrayIndex(name);
                if (!isNaN(n) && n < String(obj).length) {
                    return String(obj)[n];
                }
            }
        }
        do {
            if (obj.properties && name in obj.properties) {
                const getter = obj.getter[name];
                if (getter) {
                    // Flag this function as being a getter and thus needing immediate
                    // execution (rather than being the value of the property).
                    this.getterStep_ = true;
                    return getter;
                }
                return obj.properties[name];
            }
        } while ((obj = this.getPrototype(obj)));
        return undefined;
    }
  
    /**
     * Does the named property exist on a data object.
     * @param {!InterpreterObject} obj Data object.
     * @param {Interpreter.Value} name Name of property.
     * @return {boolean} True if property exists.
     */
    hasProperty(obj, name) {
        if (!(obj instanceof InterpreterObject)) {
            throw TypeError('Primitive data type has no properties');
        }
        name = String(name);
        if (name === 'length' && this.isa(obj, this.STRING)) {
            return true;
        }
        if (this.isa(obj, this.STRING)) {
            const n = legalArrayIndex(name);
            if (!isNaN(n) && n < String(obj).length) {
                return true;
            }
        }
        do {
            if (obj.properties && name in obj.properties) {
                return true;
            }
        } while ((obj = this.getPrototype(obj)));
        return false;
    }

    /**
     * Set a property value on a data object.
     * @param {Interpreter.Value} obj Data object.
     * @param {Interpreter.Value} name Name of property.
     * @param {Interpreter.Value} value New property value.
     *     Use Interpreter.VALUE_IN_DESCRIPTOR if value is handled by
     *     descriptor instead.
     * @param {Object=} opt_descriptor Optional descriptor object.
     * @return {!Interpreter.Object|undefined} Returns a setter function if one
     *     needs to be called, otherwise undefined.
     */
    setProperty(obj: InterpreterObject, name: string | number, value, opt_descriptor=null) {
        if (this.setterStep_) {
          // Getter from previous call to setProperty was not handled.
          throw Error('Setter not supported in that context');
        }
        name = String(name);
        if (obj === undefined || obj === null) {
          this.throwException(this.TYPE_ERROR,
                              "Cannot set property '" + name + "' of " + obj);
        }
        if (typeof obj === 'object' && !(obj instanceof InterpreterObject)) {
            throw TypeError('Expecting native value or pseudo object');
        }
        if (opt_descriptor && ('get' in opt_descriptor || 'set' in opt_descriptor) &&
            ('value' in opt_descriptor || 'writable' in opt_descriptor)) {
          this.throwException(this.TYPE_ERROR, 'Invalid property descriptor. ' +
              'Cannot both specify accessors and a value or writable attribute');
        }
        const strict = !this.stateStack || this.getScope().strict;
        if (!(obj instanceof InterpreterObject)) {
          if (strict) {
            this.throwException(this.TYPE_ERROR, "Can't create property '" + name +
                                "' on '" + obj + "'");
          }
          return;
        }
        if (this.isa(obj, this.STRING)) {
          const n = legalArrayIndex(name);
          if (name === 'length' || (!isNaN(n) && n < String(obj).length)) {
            // Can't set length or letters on String objects.
            if (strict) {
              this.throwException(this.TYPE_ERROR, "Cannot assign to read only " +
                  "property '" + name + "' of String '" + obj.data + "'");
            }
            return;
          }
        }
        if (obj.class === 'Array') {
            // Arrays have a magic length variable that is bound to the elements.
            const len = obj.properties.length;
            let i;
            if (name === 'length') {
                // Delete elements if length is smaller.
                if (opt_descriptor) {
                    if (!('value' in opt_descriptor)) {
                        return;
                    }
                    value = opt_descriptor.value;
                }
                value = legalArrayLength(value);
                if (isNaN(value)) {
                    this.throwException(this.RANGE_ERROR, 'Invalid array length');
                }
                if (value < len) {
                    for (i in obj.properties) {
                        i = legalArrayIndex(i);
                        if (!isNaN(i) && value <= i) {
                        delete obj.properties[i];
                        }
                    }
                }
            } else if (!isNaN(i = legalArrayIndex(name))) {
                // Increase length if this index is larger.
                obj.properties.length = Math.max(len, i + 1);
            }
        }
        if (obj.preventExtensions && !(name in obj.properties)) {
          if (strict) {
            this.throwException(this.TYPE_ERROR, "Can't add property '" + name +
                                "', object is not extensible");
          }
          return;
        }
        if (opt_descriptor) {
            // Define the property.
            const descriptor: any = {};
            if ('get' in opt_descriptor && opt_descriptor.get) {
                obj.getter[name] = opt_descriptor.get;
                descriptor.get = PLACEHOLDER_GETTER;
            }
            if ('set' in opt_descriptor && opt_descriptor.set) {
                obj.setter[name] = opt_descriptor.set;
                descriptor.set = PLACEHOLDER_SETTER;
            }
            if ('configurable' in opt_descriptor) {
                descriptor.configurable = opt_descriptor.configurable;
            }
            if ('enumerable' in opt_descriptor) {
                descriptor.enumerable = opt_descriptor.enumerable;
            }
            if ('writable' in opt_descriptor) {
                descriptor.writable = opt_descriptor.writable;
                delete obj.getter[name];
                delete obj.setter[name];
            }
            if ('value' in opt_descriptor) {
                descriptor.value = opt_descriptor.value;
                delete obj.getter[name];
                delete obj.setter[name];
            } else if (value !== VALUE_IN_DESCRIPTOR) {
                descriptor.value = value;
                delete obj.getter[name];
                delete obj.setter[name];
            }
            try {
                Object.defineProperty(obj.properties, name, descriptor);
            } catch (e) {
                this.throwException(this.TYPE_ERROR, 'Cannot redefine property: ' + name);
            }
            // Now that the definition has suceeded, clean up any obsolete get/set funcs.
            if ('get' in opt_descriptor && !opt_descriptor.get) {
                delete obj.getter[name];
            }
            if ('set' in opt_descriptor && !opt_descriptor.set) {
                delete obj.setter[name];
            }
        } else {
          // Set the property.
          if (value === VALUE_IN_DESCRIPTOR) {
            throw ReferenceError('Value not specified.');
          }
          // Determine the parent (possibly self) where the property is defined.
          let defObj = obj;
          while (!(name in defObj.properties)) {
            defObj = this.getPrototype(defObj);
            if (!defObj) {
              // This is a new property.
              defObj = obj;
              break;
            }
          }
          if (defObj.setter && defObj.setter[name]) {
            this.setterStep_ = true;
            return defObj.setter[name];
          }
          if (defObj.getter && defObj.getter[name]) {
            if (strict) {
              this.throwException(this.TYPE_ERROR, "Cannot set property '" + name +
                  "' of object '" + obj + "' which only has a getter");
            }
          } else {
            // No setter, simple assignment.
            try {
              obj.properties[name] = value;
            } catch (e) {
              if (strict) {
                this.throwException(this.TYPE_ERROR, "Cannot assign to read only " +
                    "property '" + name + "' of object '" + obj + "'");
              }
            }
          }
        }
    }

    //Interpreter.prototype.setProperty.placeholderGet_ = function() {throw Error('Placeholder getter')};
    //Interpreter.prototype.setProperty.placeholderSet_ = function() {throw Error('Placeholder setter')};

    /**
     * Convenience method for adding a native function as a non-enumerable property
     * onto an object's prototype.
     * @param {!Interpreter.Object} obj Data object.
     * @param {Interpreter.Value} name Name of property.
     * @param {!Function} wrapper Function object.
     */
    setNativeFunctionPrototype(obj, name, wrapper) {
        this.setProperty(obj.properties['prototype'], name,
            this.createNativeFunction(wrapper, false),
            NONENUMERABLE_DESCRIPTOR);
    }

    /**
     * Convenience method for adding an async function as a non-enumerable property
     * onto an object's prototype.
     * @param {!Interpreter.Object} obj Data object.
     * @param {Interpreter.Value} name Name of property.
     * @param {!Function} wrapper Function object.
     */
    setAsyncFunctionPrototype(obj, name, wrapper) {
        this.setProperty(obj.properties['prototype'], name,
            this.createAsyncFunction(wrapper),
            NONENUMERABLE_DESCRIPTOR);
    }

    /**
     * Create a new data object based on a constructor's prototype.
     * @param {Interpreter.Object} constructor Parent constructor function,
     *     or null if scope object.
     * @return {!Interpreter.Object} New data object.
     */
    createObject(constructor) {
        return this.createObjectProto(constructor &&
                                    constructor.properties['prototype']);
    }
  
    /**
     * Create a new data object based on a prototype.
     * @param {Interpreter.Object} proto Prototype object.
     * @return {!Interpreter.Object} New data object.
     */
    createObjectProto(proto) {
        if (typeof proto !== 'object') {
            throw Error('Non object prototype');
        }
        const obj: any = new InterpreterObject(proto);
        if (this.isa(obj, this.ERROR)) {
            // Record this object as being an error so that its toString function can
            // process it correctly (toString has no access to the interpreter and could
            // not otherwise determine that the object is an error).
            obj.class = 'Error';
        }
        return obj;
    }

    /**
     * Create a new array.
     * @return {!Interpreter.Object} New array.
     */
    createArray() {
        const array = this.createObjectProto(this.ARRAY_PROTO);
        // Arrays have length.
        this.setProperty(array, 'length', 0,
            {configurable: false, enumerable: false, writable: true});
        array.class = 'Array';
        return array;
    }


    /**
     * Create a new function object (could become interpreted or native or async).
     * @param {number} argumentLength Number of arguments.
     * @param {boolean} isConstructor True if function can be used with 'new'.
     * @return {!Interpreter.Object} New function.
     * @private
     */
    createFunctionBase_(argumentLength, isConstructor) : InterpreterObject {
        const func: InterpreterObject = this.createObjectProto(this.FUNCTION_PROTO);
        if (isConstructor) {
            const proto = this.createObjectProto(this.OBJECT_PROTO);
            this.setProperty(func, 'prototype', proto,
                NONENUMERABLE_DESCRIPTOR);
            this.setProperty(proto, 'constructor', func,
                NONENUMERABLE_DESCRIPTOR);
        } else {
            func.illegalConstructor = true;
        }
        this.setProperty(func, 'length', argumentLength, READONLY_NONENUMERABLE_DESCRIPTOR);
        func.class = 'Function';
        // When making changes to this function, check to see if those changes also
        // need to be made to the creation of FUNCTION_PROTO in initFunction.
        return func;
    }

    /**
    * Create a new interpreted function.
    * @param {!Object} node AST node defining the function.
    * @param {!Interpreter.Scope} scope Parent scope.
    * @param {string=} opt_name Optional name for function.
    * @return {!Interpreter.Object} New function.
    */
    createFunction(node, scope, opt_name) {
        const func = this.createFunctionBase_(node['params'].length, true);
        func.parentScope = scope;
        func.node = node;
        // Choose a name for this function.
        // function foo() {}             -> 'foo'
        // var bar = function() {};      -> 'bar'
        // var bar = function foo() {};  -> 'foo'
        // foo.bar = function() {};      -> ''
        // var bar = new Function('');   -> 'anonymous'
        const name = node['id'] ? String(node['id']['name']) : (opt_name || '');
        this.setProperty(func, 'name', name, READONLY_NONENUMERABLE_DESCRIPTOR);
        return func;
    }

    /**
    * Create a new native function.
    * @param {!Function} nativeFunc JavaScript function.
    * @param {boolean} isConstructor True if function can be used with 'new'.
    * @return {!Interpreter.Object} New function.
    */
    createNativeFunction (nativeFunc, isConstructor) {
        const func = this.createFunctionBase_(nativeFunc.length, isConstructor);
        func.nativeFunc = nativeFunc;
        nativeFunc.id = this.functionCounter_++;
        this.setProperty(func, 'name', nativeFunc.name, READONLY_NONENUMERABLE_DESCRIPTOR);
        return func;
    }

    /**
    * Create a new native asynchronous function.
    * @param {!Function} asyncFunc JavaScript function.
    * @return {!Interpreter.Object} New function.
    */
    createAsyncFunction(asyncFunc) {
        const func = this.createFunctionBase_(asyncFunc.length, true);
        func.asyncFunc = asyncFunc;
        asyncFunc.id = this.functionCounter_++;
        this.setProperty(func, 'name', asyncFunc.name,
        READONLY_NONENUMERABLE_DESCRIPTOR);
        return func;
    }

    /**
     * Converts from a native JavaScript object or value to a JS-Interpreter object.
     * Can handle JSON-style values, regular expressions, dates and functions.
     * Does NOT handle cycles.
     * @param {*} nativeObj The native JavaScript object to be converted.
     * @return {Interpreter.Value} The equivalent JS-Interpreter object.
     */
    nativeToPseudo(nativeObj) {
        if (nativeObj instanceof InterpreterObject) {
            throw Error('Object is already pseudo');
        }
        if ((typeof nativeObj !== 'object' && typeof nativeObj !== 'function') ||
            nativeObj === null) {
            return nativeObj;
        }
    
        if (nativeObj instanceof RegExp) {
            const pseudoRegexp = this.createObjectProto(this.REGEXP_PROTO);
            this.populateRegExp(pseudoRegexp, nativeObj);
            return pseudoRegexp;
        }
    
        if (nativeObj instanceof Date) {
            const pseudoDate = this.createObjectProto(this.DATE_PROTO);
            pseudoDate.data = new Date(nativeObj.valueOf());
            return pseudoDate;
        }
    
        if (typeof nativeObj === 'function') {
            const thisInterpreter = this;
            const wrapper = function(...var_args) {
                const args = Array.prototype.slice.call(var_args).map((i) => {
                    return this.pseudoToNative(i);
                });
                const value = nativeObj.apply(thisInterpreter, args);
                return thisInterpreter.nativeToPseudo(value);
            };
            const prototype = Object.getOwnPropertyDescriptor(nativeObj, 'prototype');
            return this.createNativeFunction(wrapper, !!prototype);
        }
    
        if (Array.isArray(nativeObj)) {  // Array.
            const pseudoArray = this.createArray();
            for (let i = 0; i < nativeObj.length; i++) {
                if (i in nativeObj) {
                    this.setProperty(pseudoArray, i, this.nativeToPseudo(nativeObj[i]));
                }
            }
            return pseudoArray;
        }
    
        // Object.
        const pseudoObj = this.createObjectProto(this.OBJECT_PROTO);
        for (const key in nativeObj) {
            this.setProperty(pseudoObj, key, this.nativeToPseudo(nativeObj[key]));
        }
        return pseudoObj;
    }
  
    /**
     * Converts from a JS-Interpreter object to native JavaScript object.
     * Can handle JSON-style values, regular expressions, and dates.
     * Does handle cycles.
     * @param {Interpreter.Value} pseudoObj The JS-Interpreter object to be
     * converted.
     * @param {Object=} opt_cycles Cycle detection (used in recursive calls).
     * @return {*} The equivalent native JavaScript object or value.
     */
    pseudoToNative(pseudoObj, opt_cycles = null) {
        if ((typeof pseudoObj !== 'object' && typeof pseudoObj !== 'function') ||
            pseudoObj === null) {
            return pseudoObj;
        }
        if (!(pseudoObj instanceof InterpreterObject)) {
            throw Error('Object is not pseudo');
        }
    
        if (this.isa(pseudoObj, this.REGEXP)) {  // Regular expression.
            const nativeRegExp = new RegExp(pseudoObj.data.source, pseudoObj.data.flags);
            nativeRegExp.lastIndex = pseudoObj.data.lastIndex;
            return nativeRegExp;
        }
    
        if (this.isa(pseudoObj, this.DATE)) {  // Date.
            return new Date(pseudoObj.data.valueOf());
        }
    
        const cycles = opt_cycles || {
            pseudo: [],
            native: []
        };
        const i = cycles.pseudo.indexOf(pseudoObj);
        if (i !== -1) {
            return cycles.native[i];
        }
        cycles.pseudo.push(pseudoObj);
        let nativeObj;
        if (this.isa(pseudoObj, this.ARRAY)) {  // Array.
            nativeObj = [];
            cycles.native.push(nativeObj);
            const len = this.getProperty(pseudoObj, 'length');
            for (let i = 0; i < len; i++) {
                if (this.hasProperty(pseudoObj, i)) {
                nativeObj[i] =
                    this.pseudoToNative(this.getProperty(pseudoObj, i), cycles);
                }
            }
        } else {  // Object.
            nativeObj = {};
            cycles.native.push(nativeObj);
            let val;
            for (const key in pseudoObj.properties) {
                val = this.pseudoToNative(pseudoObj.properties[key], cycles);
                // Use defineProperty to avoid side effects if setting '__proto__'.
                Object.defineProperty(nativeObj, key,
                    {value: val, writable: true, enumerable: true, configurable: true});
            }
        }
        cycles.pseudo.pop();
        cycles.native.pop();
        return nativeObj;
    }
  
    /**
     * Converts from a native JavaScript array to a JS-Interpreter array.
     * Does handle non-numeric properties (like str.match's index prop).
     * Does NOT recurse into the array's contents.
     * @param {!Array} nativeArray The JavaScript array to be converted.
     * @return {!Interpreter.Object} The equivalent JS-Interpreter array.
     */
    arrayNativeToPseudo(nativeArray) {
        const pseudoArray = this.createArray();
        const props = Object.getOwnPropertyNames(nativeArray);
        for (let i = 0; i < props.length; i++) {
            this.setProperty(pseudoArray, props[i], nativeArray[props[i]]);
        }
        return pseudoArray;
    }
    
    /**
     * Converts from a JS-Interpreter array to native JavaScript array.
     * Does handle non-numeric properties (like str.match's index prop).
     * Does NOT recurse into the array's contents.
     * @param {!Interpreter.Object} pseudoArray The JS-Interpreter array,
     *     or JS-Interpreter object pretending to be an array.
     * @return {!Array} The equivalent native JavaScript array.
     */
    arrayPseudoToNative(pseudoArray) {
        const nativeArray = [];
        for (const key in pseudoArray.properties) {
            nativeArray[key] = this.getProperty(pseudoArray, key);
        }
        // pseudoArray might be an object pretending to be an array.  In this case
        // it's possible that length is non-existent, invalid, or smaller than the
        // largest defined numeric property.  Set length explicitly here.
        nativeArray.length = legalArrayLength(
            this.getProperty(pseudoArray, 'length')) || 0;
        return nativeArray;
    }

    /**
     * Look up the prototype for this value.
     * @param {Interpreter.Value} value Data object.
     * @return {Interpreter.Object} Prototype object, null if none.
     */
    getPrototype(value) {
        switch (typeof value) {
            case 'number':
                return this.NUMBER.properties['prototype'];
            case 'boolean':
                return this.BOOLEAN.properties['prototype'];
            case 'string':
                return this.STRING.properties['prototype'];
        }
        if (value) {
            return value.proto;
        }
        return null;
    }

    /**
     * Returns the current scope from the stateStack.
     * @return {!Interpreter.Scope} Current scope.
     */
    getScope() {
        const scope = this.stateStack[this.stateStack.length - 1].scope;
        if (!scope) {
            throw Error('No scope found.');
        }
        return scope;
    }
  
    /**
     * Create a new scope dictionary.
     * @param {!Object} node AST node defining the scope container
     *     (e.g. a function).
     * @param {Interpreter.Scope} parentScope Scope to link to.
     * @return {!Interpreter.Scope} New scope.
     */
    createScope(node, parentScope) {
        // Determine if this scope starts with `use strict`.
        let strict = false;
        if (parentScope && parentScope.strict) {
            strict = true;
        } else {
            const firstNode = node['body'] && node['body'][0];
            if (firstNode && firstNode.expression &&
                firstNode.expression['type'] === 'Literal' &&
                firstNode.expression.value === 'use strict') {
                strict = true;
            }
        }
        const object = this.createObjectProto(null);
        const scope = new Scope(parentScope, strict, object);
        if (!parentScope) {
            this.initGlobal(scope.object);
        }
        this.populateScope_(node, scope);
        return scope;
    }
  
    /**
     * Create a new special scope dictionary. Similar to createScope(), but
     * doesn't assume that the scope is for a function body.
     * This is used for 'catch' clauses and 'with' statements.
     * @param {!Interpreter.Scope} parentScope Scope to link to.
     * @param {Interpreter.Object=} opt_object Optional object to transform into
     *     scope.
     * @return {!Interpreter.Scope} New scope.
     */
    createSpecialScope(parentScope, opt_object=null) {
        if (!parentScope) {
            throw Error('parentScope required');
        }
        const object = opt_object || this.createObjectProto(null);
        return new Scope(parentScope, parentScope.strict, object);
    }
  
    /**
     * Retrieves a value from the scope chain.
     * @param {string} name Name of variable.
     * @return {Interpreter.Value} Any value.
     *   May be flagged as being a getter and thus needing immediate execution
     *   (rather than being the value of the property).
     */
    getValueFromScope(name: string) {
        let scope = this.getScope();
        while (scope && scope !== this.globalScope) {
            if (name in scope.object.properties) {
                return scope.object.properties[name];
            }
            scope = scope.parentScope;
        }
        // The root scope is also an object which has inherited properties and
        // could also have getters.
        if (scope === this.globalScope && this.hasProperty(scope.object, name)) {
            return this.getProperty(scope.object, name);
        }
        // Typeof operator is unique: it can safely look at non-defined variables.
        const prevNode = this.stateStack[this.stateStack.length - 1].node;
        if (prevNode['type'] === 'UnaryExpression' &&
            prevNode['operator'] === 'typeof') {
            return undefined;
        }
        this.throwException(this.REFERENCE_ERROR, name + ' is not defined');
    }
  
    /**
     * Sets a value to the current scope.
     * @param {string} name Name of variable.
     * @param {Interpreter.Value} value Value.
     * @return {!Interpreter.Object|undefined} Returns a setter function if one
     *     needs to be called, otherwise undefined.
     */
    setValueToScope(name, value) {
        let scope = this.getScope();
        const strict = scope.strict;
        while (scope && scope !== this.globalScope) {
            if (name in scope.object.properties) {
                scope.object.properties[name] = value;
                return undefined;
            }
            scope = scope.parentScope;
        }
        // The root scope is also an object which has readonly properties and
        // could also have setters.
        if (scope === this.globalScope &&
            (!strict || this.hasProperty(scope.object, name))) {
            return this.setProperty(scope.object, name, value);
        }
        this.throwException(this.REFERENCE_ERROR, name + ' is not defined');
    }
  
    /**
     * Create a new scope for the given node.
     * @param {!Object} node AST node (program or function).
     * @param {!Interpreter.Scope} scope Scope dictionary to populate.
     * @private
     */
    populateScope_(node, scope) {
        if (node['type'] === 'VariableDeclaration') {
            for (let i = 0; i < node['declarations'].length; i++) {
                this.setProperty(scope.object, node['declarations'][i]['id']['name'],
                    undefined, VARIABLE_DESCRIPTOR);
            }
        } else if (node['type'] === 'FunctionDeclaration') {
            this.setProperty(scope.object, node['id']['name'],
                this.createFunction(node, scope, null), VARIABLE_DESCRIPTOR);
            return;  // Do not recurse into function.
        } else if (node['type'] === 'FunctionExpression') {
            return;  // Do not recurse into function.
        } else if (node['type'] === 'ExpressionStatement') {
            return;  // Expressions can't contain variable/function declarations.
        }
        const nodeClass = node['constructor'];
        for (const name in node) {
            const prop = node[name];
            if (prop && typeof prop === 'object') {
                if (Array.isArray(prop)) {
                    for (let i = 0; i < prop.length; i++) {
                        if (prop[i] && prop[i].constructor === nodeClass) {
                            this.populateScope_(prop[i], scope);
                        }
                    }
                } else {
                    if (prop.constructor === nodeClass) {
                        this.populateScope_(prop, scope);
                    }
                }
            }
        }
    }

    /**
     * Is the current state directly being called with as a construction with 'new'.
     * @return {boolean} True if 'new foo()', false if 'foo()'.
     */
    calledWithNew() {
        return this.stateStack[this.stateStack.length - 1].isConstructor;
    }

    /**
     * Gets a value from the scope chain or from an object property.
     * @param {!Array} ref Name of variable or object/propname tuple.
     * @return {Interpreter.Value} Any value.
     *   May be flagged as being a getter and thus needing immediate execution
     *   (rather than being the value of the property).
     */
    getValue(ref) {
        if (ref[0] === SCOPE_REFERENCE) {
            // A null/varname variable lookup.
            return this.getValueFromScope(ref[1]);
        } else {
            // An obj/prop components tuple (foo.bar).
            return this.getProperty(ref[0], ref[1]);
        }
    }
  
    /**
     * Sets a value to the scope chain or to an object property.
     * @param {!Array} ref Name of variable or object/propname tuple.
     * @param {Interpreter.Value} value Value.
     * @return {!Interpreter.Object|undefined} Returns a setter function if one
     *     needs to be called, otherwise undefined.
     */
    setValue(ref, value) {
        if (ref[0] === SCOPE_REFERENCE) {
            // A null/varname variable lookup.
            return this.setValueToScope(ref[1], value);
        } else {
            // An obj/prop components tuple (foo.bar).
            return this.setProperty(ref[0], ref[1], value);
        }
    }


    /**
     * Throw an exception in the interpreter that can be handled by an
     * interpreter try/catch statement.  If unhandled, a real exception will
     * be thrown.  Can be called with either an error class and a message, or
     * with an actual object to be thrown.
     * @param {!Interpreter.Object|Interpreter.Value} errorClass Type of error
     *   (if message is provided) or the value to throw (if no message).
     * @param {string=} opt_message Message being thrown.
     */
    throwException(errorClass, opt_message=null) {
        let error;
        if (opt_message === undefined) {
            error = errorClass;  // This is a value to throw, not an error class.
        } else {
            error = this.createObject(errorClass);
            this.setProperty(error, 'message', opt_message,
                NONENUMERABLE_DESCRIPTOR);
        }
        this.unwind(Completion.THROW, error, undefined);
        // Abort anything related to the current step.
        throw STEP_ERROR;
    }

    /**
     * Unwind the stack to the innermost relevant enclosing TryStatement,
     * For/ForIn/WhileStatement or Call/NewExpression.  If this results in
     * the stack being completely unwound the thread will be terminated
     * and the appropriate error being thrown.
     * @param {Interpreter.Completion} type Completion type.
     * @param {Interpreter.Value} value Value computed, returned or thrown.
     * @param {string|undefined} label Target label for break or return.
     */
     unwind(type, value, label) {
        if (type === Completion.NORMAL) {
            throw TypeError('Should not unwind for NORMAL completions');
        }
  
        loop: for (const stack = this.stateStack; stack.length > 0; stack.pop()) {
            const state = stack[stack.length - 1];
            switch (state.node['type']) {
                case 'TryStatement':
                    state.cv = {type: type, value: value, label: label};
                    return;
                case 'CallExpression':
                case 'NewExpression':
                    if (type === Completion.RETURN) {
                        state.value = value;
                        return;
                    } else if (type !== Completion.THROW) {
                        throw Error('Unsynatctic break/continue not rejected by Acorn');
                    }
                    break;
                case 'Program':
                    // Don't pop the stateStack.
                    // Leave the root scope on the tree in case the program is appended to.
                    state.done = true;
                    break loop;
            }
            if (type === Completion.BREAK) {
                if (label ? (state.labels && state.labels.indexOf(label) !== -1) :
                    (state.isLoop || state.isSwitch)) {
                stack.pop();
                return;
                }
            } else if (type === Completion.CONTINUE) {
                if (label ? (state.labels && state.labels.indexOf(label) !== -1) :
                    state.isLoop) {
                return;
                }
            }
        }
  
        // Unhandled completion.  Throw a real error.
        let realError;
        if (this.isa(value, this.ERROR)) {
            const errorTable = {
                'EvalError': EvalError,
                'RangeError': RangeError,
                'ReferenceError': ReferenceError,
                'SyntaxError': SyntaxError,
                'TypeError': TypeError,
                'URIError': URIError
            };
            const name = String(this.getProperty(value, 'name'));
            const message = this.getProperty(value, 'message').valueOf();
            const errorConstructor = errorTable[name] || Error;
            realError = errorConstructor(message);
        } else {
            realError = String(value);
        }
        throw realError;
    }

    /**
     * Create a call to a getter function.
     * @param {!Interpreter.Object} func Function to execute.
     * @param {!Interpreter.Object|!Array} left
     *     Name of variable or object/propname tuple.
     * @private
     */
    createGetter_(func, left) {
        if (!this.getterStep_) {
        throw Error('Unexpected call to createGetter');
        }
        // Clear the getter flag.
        this.getterStep_ = false;
        // Normally `this` will be specified as the object component (o.x).
        // Sometimes `this` is explicitly provided (o).
        const funcThis = Array.isArray(left) ? left[0] : left;
        const node = new this.nodeConstructor({options:{}});
        node['type'] = 'CallExpression';
        const state = new State(node,
            this.stateStack[this.stateStack.length - 1].scope);
        state.doneCallee_ = true;
        state.funcThis_ = funcThis;
        state.func_ = func;
        state.doneArgs_ = true;
        state.arguments_ = [];
        return state;
    }
  
    /**
     * Create a call to a setter function.
     * @param {!Interpreter.Object} func Function to execute.
     * @param {!Interpreter.Object|!Array} left
     *     Name of variable or object/propname tuple.
     * @param {Interpreter.Value} value Value to set.
     * @private
     */
    createSetter_(func, left, value) {
        if (!this.setterStep_) {
            throw Error('Unexpected call to createSetter');
        }
        // Clear the setter flag.
        this.setterStep_ = false;
        // Normally `this` will be specified as the object component (o.x).
        // Sometimes `this` is implicitly the global object (x).
        const funcThis = Array.isArray(left) ? left[0] : this.globalObject;
        const node = new this.nodeConstructor({options:{}});
        node['type'] = 'CallExpression';
        const state = new State(node,
            this.stateStack[this.stateStack.length - 1].scope);
        state.doneCallee_ = true;
        state.funcThis_ = funcThis;
        state.func_ = func;
        state.doneArgs_ = true;
        state.arguments_ = [value];
        return state;
    }
  
    /**
     * In non-strict mode `this` must be an object.
     * Must not be called in strict mode.
     * @param {Interpreter.Value} value Proposed value for `this`.
     * @return {!Interpreter.Object} Final value for `this`.
     * @private
     */
    boxThis_(value) {
        if (value === undefined || value === null) {
            // `Undefined` and `null` are changed to the global object.
            return this.globalObject;
        }
        if (!(value instanceof InterpreterObject)) {
            // Primitives must be boxed.
            const box = this.createObjectProto(this.getPrototype(value));
            box.data = value;
            return box;
        }
        return value;
    }

    ///////////////////////////////////////////////////////////////////////////////
    // Functions to handle each node type.
    ///////////////////////////////////////////////////////////////////////////////

    stepArrayExpression(stack, state, node) {
        const elements = node['elements'];
        let n = state.n_ || 0;
        if (!state.array_) {
            state.array_ = this.createArray();
            state.array_.properties.length = elements.length;
        } else {
            this.setProperty(state.array_, n, state.value);
            n++;
        }
        while (n < elements.length) {
            // Skip missing elements - they're not defined, not undefined.
            if (elements[n]) {
                state.n_ = n;
                return new State(elements[n], state.scope);
            }
            n++;
        }
        stack.pop();
        stack[stack.length - 1].value = state.array_;
    }
  
    stepAssignmentExpression(stack, state, node) {
        if (!state.doneLeft_) {
            state.doneLeft_ = true;
            const nextState = new State(node['left'], state.scope);
            nextState.components = true;
            return nextState;
        }
        if (!state.doneRight_) {
            if (!state.leftReference_) {
                state.leftReference_ = state.value;
            }
            if (state.doneGetter_) {
                state.leftValue_ = state.value;
            }
            if (!state.doneGetter_ && node['operator'] !== '=') {
                const leftValue = this.getValue(state.leftReference_);
                state.leftValue_ = leftValue;
                if (this.getterStep_) {
                // Call the getter function.
                state.doneGetter_ = true;
                const func = /** @type {!Interpreter.Object} */ (leftValue);
                return this.createGetter_(func, state.leftReference_);
                }
        }
            state.doneRight_ = true;
            // When assigning an unnamed function to a variable, the function's name
            // is set to the variable name.  Record the variable name in case the
            // right side is a functionExpression.
            // E.g. foo = function() {};
            if (node['operator'] === '=' && node['left']['type'] === 'Identifier') {
                state.destinationName = node['left']['name'];
            }
            return new State(node['right'], state.scope);
        }
        if (state.doneSetter_) {
            // Return if setter function.
            // Setter method on property has completed.
            // Ignore its return value, and use the original set value instead.
            stack.pop();
            stack[stack.length - 1].value = state.setterValue_;
            return;
        }
        let value = state.leftValue_;
        const rightValue = state.value;
        switch (node['operator']) {
            case '=':    value =    rightValue; break;
            case '+=':   value +=   rightValue; break;
            case '-=':   value -=   rightValue; break;
            case '*=':   value *=   rightValue; break;
            case '/=':   value /=   rightValue; break;
            case '%=':   value %=   rightValue; break;
            case '<<=':  value <<=  rightValue; break;
            case '>>=':  value >>=  rightValue; break;
            case '>>>=': value >>>= rightValue; break;
            case '&=':   value &=   rightValue; break;
            case '^=':   value ^=   rightValue; break;
            case '|=':   value |=   rightValue; break;
            default:
                throw SyntaxError('Unknown assignment expression: ' + node['operator']);
        }
        const setter = this.setValue(state.leftReference_, value);
        if (setter) {
            state.doneSetter_ = true;
            state.setterValue_ = value;
            return this.createSetter_(setter, state.leftReference_, value);
        }
        // Return if no setter function.
        stack.pop();
        stack[stack.length - 1].value = value;
    }
  
    stepBinaryExpression(stack, state, node) {
        if (!state.doneLeft_) {
            state.doneLeft_ = true;
            return new State(node['left'], state.scope);
        }
        if (!state.doneRight_) {
            state.doneRight_ = true;
            state.leftValue_ = state.value;
            return new State(node['right'], state.scope);
        }
        stack.pop();
        const leftValue = state.leftValue_;
        const rightValue = state.value;
        let value;
        switch (node['operator']) {
            case '==':  value = leftValue ==  rightValue; break;
            case '!=':  value = leftValue !=  rightValue; break;
            case '===': value = leftValue === rightValue; break;
            case '!==': value = leftValue !== rightValue; break;
            case '>':   value = leftValue >   rightValue; break;
            case '>=':  value = leftValue >=  rightValue; break;
            case '<':   value = leftValue <   rightValue; break;
            case '<=':  value = leftValue <=  rightValue; break;
            case '+':   value = leftValue +   rightValue; break;
            case '-':   value = leftValue -   rightValue; break;
            case '*':   value = leftValue *   rightValue; break;
            case '/':   value = leftValue /   rightValue; break;
            case '%':   value = leftValue %   rightValue; break;
            case '&':   value = leftValue &   rightValue; break;
            case '|':   value = leftValue |   rightValue; break;
            case '^':   value = leftValue ^   rightValue; break;
            case '<<':  value = leftValue <<  rightValue; break;
            case '>>':  value = leftValue >>  rightValue; break;
            case '>>>': value = leftValue >>> rightValue; break;
            case 'in':
                if (!(rightValue instanceof InterpreterObject)) {
                this.throwException(this.TYPE_ERROR,
                    "'in' expects an object, not '" + rightValue + "'");
                }
                value = this.hasProperty(rightValue, leftValue);
                break;
            case 'instanceof':
                if (!this.isa(rightValue, this.FUNCTION)) {
                this.throwException(this.TYPE_ERROR,
                    'Right-hand side of instanceof is not an object');
                }
                value = (leftValue instanceof InterpreterObject) ?
                    this.isa(leftValue, rightValue) : false;
                break;
            default:
                throw SyntaxError('Unknown binary operator: ' + node['operator']);
        }
        stack[stack.length - 1].value = value;
    }
  
    stepBlockStatement(stack, state, node) {
        const n = state.n_ || 0;
        const expression = node['body'][n];
        if (expression) {
            state.n_ = n + 1;
            return new State(expression, state.scope);
        }
        stack.pop();
    }
  
    stepBreakStatement(stack, state, node) {
        const label = node['label'] && node['label']['name'];
        this.unwind(Completion.BREAK, undefined, label);
    }
  
    stepCallExpression(stack, state, node) {
        if (!state.doneCallee_) {
            state.doneCallee_ = 1;
            // Components needed to determine value of `this`.
            const nextState = new State(node['callee'], state.scope);
            nextState.components = true;
            return nextState;
        }
        if (state.doneCallee_ === 1) {
            // Determine value of the function.
            state.doneCallee_ = 2;
            let func = state.value;
            if (Array.isArray(func)) {
                    state.func_ = this.getValue(func);
                    if (func[0] === SCOPE_REFERENCE) {
                        // (Globally or locally) named function.  Is it named 'eval'?
                        state.directEval_ = (func[1] === 'eval');
                    } else {
                        // Method function, `this` is object (ignored if invoked as `new`).
                        state.funcThis_ = func[0];
                    }
                    func = state.func_;
                    if (this.getterStep_) {
                        // Call the getter function.
                        state.doneCallee_ = 1;
                        return this.createGetter_(/** @type {!Interpreter.Object} */ (func),
                            state.value);
                    }
            } else {
                // Already evaluated function: (function(){...})();
                state.func_ = func;
            }
            state.arguments_ = [];
            state.n_ = 0;
        }
        const func = state.func_;
        if (!state.doneArgs_) {
            if (state.n_ !== 0) {
                state.arguments_.push(state.value);
            }
            if (node['arguments'][state.n_]) {
                return new State(node['arguments'][state.n_++], state.scope);
            }
            // Determine value of `this` in function.
            if (node['type'] === 'NewExpression') {
                if (!(func instanceof InterpreterObject) || func.illegalConstructor) {
                    // Illegal: new escape();
                    this.throwException(this.TYPE_ERROR, func + ' is not a constructor');
                }
                // Constructor, `this` is new object.
                if (func === this.ARRAY) {
                    state.funcThis_ = this.createArray();
                } else {
                    let proto = func.properties['prototype'];
                    if (typeof proto !== 'object' || proto === null) {
                        // Non-object prototypes default to `Object.prototype`.
                        proto = this.OBJECT_PROTO;
                    }
                    state.funcThis_ = this.createObjectProto(proto);
                }
                state.isConstructor = true;
            }
            state.doneArgs_ = true;
        }
        if (!state.doneExec_) {
            state.doneExec_ = true;
            if (!(func instanceof InterpreterObject)) {
                this.throwException(this.TYPE_ERROR, func + ' is not a function');
            }
            const funcNode = func.node;
            if (funcNode) {
                const scope = this.createScope(funcNode['body'], func.parentScope);
                // Add all arguments.
                for (let i = 0; i < funcNode['params'].length; i++) {
                    const paramName = funcNode['params'][i]['name'];
                    const paramValue = state.arguments_.length > i ? state.arguments_[i] :
                        undefined;
                    this.setProperty(scope.object, paramName, paramValue);
                }
                // Build arguments variable.
                const argsList = this.createArray();
                for (let i = 0; i < state.arguments_.length; i++) {
                    this.setProperty(argsList, i, state.arguments_[i]);
                }
                this.setProperty(scope.object, 'arguments', argsList);
                // Add the function's name (var x = function foo(){};)
                const name = funcNode['id'] && funcNode['id']['name'];
                if (name) {
                    this.setProperty(scope.object, name, func);
                }
                if (!scope.strict) {
                state.funcThis_ = this.boxThis_(state.funcThis_);
                }
                this.setProperty(scope.object, 'this', state.funcThis_, READONLY_DESCRIPTOR);
                state.value = undefined;  // Default value if no explicit return.
                return new State(funcNode['body'], scope);
            } else if (func.eval) {
                const code = state.arguments_[0];
                if (typeof code !== 'string') {
                    // JS does not parse String objects:
                    // eval(new String('1 + 1')) -> '1 + 1'
                    state.value = code;
                } else {
                    let ast;
                    try {
                        ast = acorn.parse(String(code), PARSE_OPTIONS);
                    } catch (e) {
                        // Acorn threw a SyntaxError.  Rethrow as a trappable error.
                        this.throwException(this.SYNTAX_ERROR, 'Invalid code: ' + e.message);
                    }
                    const evalNode = new this.nodeConstructor({options:{}});
                    evalNode['type'] = 'EvalProgram_';
                    evalNode['body'] = ast['body'];
                    stripLocations_(evalNode, node['start'], node['end']);
                    // Create new scope and update it with definitions in eval().
                    let scope = state.directEval_ ? state.scope : this.globalScope;
                    if (scope.strict) {
                        // Strict mode get its own scope in eval.
                        scope = this.createScope(ast, scope);
                    } else {
                        // Non-strict mode pollutes the current scope.
                        this.populateScope_(ast, scope);
                    }
                    this.value = undefined;  // Default value if no code.
                    return new State(evalNode, scope);
                }
            } else if (func.nativeFunc) {
                if (!state.scope.strict) {
                state.funcThis_ = this.boxThis_(state.funcThis_);
                }
                state.value = func.nativeFunc.apply(state.funcThis_, state.arguments_);
            } else if (func.asyncFunc) {
                const thisInterpreter = this;
                const callback = function(value) {
                    state.value = value;
                    thisInterpreter.paused_ = false;
                };
                // Force the argument lengths to match, then append the callback.
                const argLength = func.asyncFunc.length - 1;
                const argsWithCallback = state.arguments_.concat(
                    new Array(argLength)).slice(0, argLength);
                argsWithCallback.push(callback);
                this.paused_ = true;
                if (!state.scope.strict) {
                state.funcThis_ = this.boxThis_(state.funcThis_);
                }
                func.asyncFunc.apply(state.funcThis_, argsWithCallback);
                return;
            } else {
                /* A child of a function is a function but is not callable.  For example:
                var F = function() {};
                F.prototype = escape;
                var f = new F();
                f();
                */
                this.throwException(this.TYPE_ERROR, func.class + ' is not callable');
            }
        } else {
            // Execution complete.  Put the return value on the stack.
            stack.pop();
            if (state.isConstructor && typeof state.value !== 'object') {
                // Normal case for a constructor is to use the `this` value.
                stack[stack.length - 1].value = state.funcThis_;
            } else {
                // Non-constructors or constructions explicitly returning objects use
                // the return value.
                stack[stack.length - 1].value = state.value;
            }
        }
    }
  
    stepCatchClause(stack, state, node) {
        if (!state.done_) {
            state.done_ = true;
            // Create an empty scope.
            const scope = this.createSpecialScope(state.scope);
            // Add the argument.
            this.setProperty(scope.object, node['param']['name'], state.throwValue);
            // Execute catch clause.
            return new State(node['body'], scope);
        } else {
            stack.pop();
        }
    }
  
    stepConditionalExpression(stack, state, node) {
        const mode = state.mode_ || 0;
        if (mode === 0) {
            state.mode_ = 1;
            return new State(node['test'], state.scope);
        }
        if (mode === 1) {
            state.mode_ = 2;
            const value = Boolean(state.value);
            if (value && node['consequent']) {
                // Execute `if` block.
                return new State(node['consequent'], state.scope);
            } else if (!value && node['alternate']) {
                // Execute `else` block.
                return new State(node['alternate'], state.scope);
            }
            // eval('1;if(false){2}') -> undefined
            this.value = undefined;
        }
        stack.pop();
        if (node['type'] === 'ConditionalExpression') {
            stack[stack.length - 1].value = state.value;
        }
  }
  
    stepContinueStatement(stack, state, node) {
        const label = node['label'] && node['label']['name'];
        this.unwind(Completion.CONTINUE, undefined, label);
    }
  
    stepDebuggerStatement(stack, state, node) {
        // Do nothing.  May be overridden by developers.
        stack.pop();
    }
  
    stepDoWhileStatement(stack, state, node) {
        if (node['type'] === 'DoWhileStatement' && state.test_ === undefined) {
            // First iteration of do/while executes without checking test.
            state.value = true;
            state.test_ = true;
        }
        if (!state.test_) {
            state.test_ = true;
            return new State(node['test'], state.scope);
        }
        if (!state.value) {  // Done, exit loop.
            stack.pop();
        } else if (node['body']) {  // Execute the body.
            state.test_ = false;
            state.isLoop = true;
            return new State(node['body'], state.scope);
        }
    }
  
    stepEmptyStatement(stack, state, node) {
        stack.pop();
    }
  
    stepEvalProgram_(stack, state, node) {
        const n = state.n_ || 0;
        const expression = node['body'][n];
        if (expression) {
            state.n_ = n + 1;
            return new State(expression, state.scope);
        }
        stack.pop();
        stack[stack.length - 1].value = this.value;
    }
  
    stepExpressionStatement(stack, state, node) {
        if (!state.done_) {
            state.done_ = true;
            return new State(node['expression'], state.scope);
        }
        stack.pop();
        // Save this value to interpreter.value for use as a return value if
        // this code is inside an eval function.
        this.value = state.value;
    }
  
    stepForInStatement(stack, state, node) {
        // First, initialize a variable if exists.  Only do so once, ever.
        if (!state.doneInit_) {
            state.doneInit_ = true;
            if (node['left']['declarations'] &&
                node['left']['declarations'][0]['init']) {
                if (state.scope.strict) {
                this.throwException(this.SYNTAX_ERROR,
                    'for-in loop variable declaration may not have an initializer.');
                }
                // Variable initialization: for (var x = 4 in y)
                return new State(node['left'], state.scope);
            }
        }
        // Second, look up the object.  Only do so once, ever.
        if (!state.doneObject_) {
            state.doneObject_ = true;
            if (!state.variable_) {
                state.variable_ = state.value;
            }
            return new State(node['right'], state.scope);
        }
        if (!state.isLoop) {
            // First iteration.
            state.isLoop = true;
            state.object_ = state.value;
            state.visited_ = Object.create(null);
        }
        // Third, find the property name for this iteration.
        if (state.name_ === undefined) {
            gotPropName: for (;;) {
                if (state.object_ instanceof InterpreterObject) {
                    if (!state.props_) {
                        state.props_ = Object.getOwnPropertyNames(state.object_.properties);
                    }
                    for (;;) {
                        const prop = state.props_.shift();
                        if (prop === undefined) {
                        break;  // Reached end of this object's properties.
                        }
                        if (!Object.prototype.hasOwnProperty.call(state.object_.properties,
                            prop)) {
                        continue;  // Property has been deleted in the loop.
                        }
                        if (state.visited_[prop]) {
                        continue;  // Already seen this property on a child.
                        }
                        state.visited_[prop] = true;
                        if (!Object.prototype.propertyIsEnumerable.call(
                            state.object_.properties, prop)) {
                        continue;  // Skip non-enumerable property.
                        }
                        state.name_ = prop;
                        break gotPropName;
                    }
                } else if (state.object_ !== null && state.object_ !== undefined) {
                    // Primitive value (other than null or undefined).
                    if (!state.props_) {
                        state.props_ = Object.getOwnPropertyNames(state.object_);
                    }
                    for (;;) {
                        const prop = state.props_.shift();
                        if (prop === undefined) {
                        break;  // Reached end of this value's properties.
                        }
                        state.visited_[prop] = true;
                        if (!Object.prototype.propertyIsEnumerable.call(
                            state.object_, prop)) {
                        continue;  // Skip non-enumerable property.
                        }
                        state.name_ = prop;
                        break gotPropName;
                    }
                }
                state.object_ = this.getPrototype(state.object_);
                state.props_ = null;
                if (state.object_ === null) {
                    // Done, exit loop.
                    stack.pop();
                    return;
                }
            }
        }
        // Fourth, find the variable
        if (!state.doneVariable_) {
            state.doneVariable_ = true;
            const left = node['left'];
            if (left['type'] === 'VariableDeclaration') {
                // Inline variable declaration: for (var x in y)
                state.variable_ =
                    [SCOPE_REFERENCE, left['declarations'][0]['id']['name']];
            } else {
                // Arbitrary left side: for (foo().bar in y)
                state.variable_ = null;
                const nextState = new State(left, state.scope);
                nextState.components = true;
                return nextState;
            }
        }
        if (!state.variable_) {
            state.variable_ = state.value;
        }
        // Fifth, set the variable.
        if (!state.doneSetter_) {
            state.doneSetter_ = true;
            const value = state.name_;
            const setter = this.setValue(state.variable_, value);
            if (setter) {
                return this.createSetter_(setter, state.variable_, value);
            }
        }
        // Next step will be step three.
        state.name_ = undefined;
        // Reevaluate the variable since it could be a setter on the global object.
        state.doneVariable_ = false;
        state.doneSetter_ = false;
        // Sixth and finally, execute the body if there was one.  this.
        if (node['body']) {
            return new State(node['body'], state.scope);
        }
    }
  
    stepForStatement(stack, state, node) {
        const mode = state.mode_ || 0;
        if (mode === 0) {
            state.mode_ = 1;
            if (node['init']) {
                return new State(node['init'], state.scope);
            }
        } else if (mode === 1) {
            state.mode_ = 2;
            if (node['test']) {
                return new State(node['test'], state.scope);
            }
        } else if (mode === 2) {
            state.mode_ = 3;
            if (node['test'] && !state.value) {
                // Done, exit loop.
                stack.pop();
            } else {  // Execute the body.
                state.isLoop = true;
                return new State(node['body'], state.scope);
            }
        } else if (mode === 3) {
            state.mode_ = 1;
            if (node['update']) {
                return new State(node['update'], state.scope);
            }
        }
    }
  
    stepFunctionDeclaration(stack, state, node) {
        // This was found and handled when the scope was populated.
        stack.pop();
    }
  
    stepFunctionExpression(stack, state, node) {
        stack.pop();
        state = stack[stack.length - 1];
        state.value = this.createFunction(node, state.scope, state.destinationName);
    }
  
    stepIdentifier(stack, state, node) {
        stack.pop();
        if (state.components) {
            stack[stack.length - 1].value = [SCOPE_REFERENCE, node['name']];
            return;
        }
        const value = this.getValueFromScope(node['name']);
        // An identifier could be a getter if it's a property on the global object.
        if (this.getterStep_) {
            // Call the getter function.
            const func = /** @type {!Interpreter.Object} */ (value);
            return this.createGetter_(func, this.globalObject);
        }
        stack[stack.length - 1].value = value;
    }
  
    stepIfStatement(stack, state, node) {
        this.stepConditionalExpression(stack, state, node);
    }
  
    stepLabeledStatement(stack, state, node) {
        // No need to hit this node again on the way back up the stack.
        stack.pop();
        // Note that a statement might have multiple labels.
        const labels = state.labels || [];
        labels.push(node['label']['name']);
        const nextState = new State(node['body'], state.scope);
        nextState.labels = labels;
        return nextState;
    }
  
    stepLiteral(stack, state, node) {
        stack.pop();
        let value = node['value'];
        if (value instanceof RegExp) {
            const pseudoRegexp = this.createObjectProto(this.REGEXP_PROTO);
            this.populateRegExp(pseudoRegexp, value);
            value = pseudoRegexp;
        }
        stack[stack.length - 1].value = value;
    }
  
    stepLogicalExpression(stack, state, node) {
        if (node['operator'] !== '&&' && node['operator'] !== '||') {
            throw SyntaxError('Unknown logical operator: ' + node['operator']);
        }
        if (!state.doneLeft_) {
            state.doneLeft_ = true;
            return new State(node['left'], state.scope);
        }
        if (!state.doneRight_) {
            if ((node['operator'] === '&&' && !state.value) ||
                (node['operator'] === '||' && state.value)) {
                // Shortcut evaluation.
                stack.pop();
                stack[stack.length - 1].value = state.value;
            } else {
                state.doneRight_ = true;
                return new State(node['right'], state.scope);
            }
        } else {
            stack.pop();
            stack[stack.length - 1].value = state.value;
        }
    }

    stepMemberExpression(stack, state, node) {
        if (!state.doneObject_) {
            state.doneObject_ = true;
            return new State(node['object'], state.scope);
        }
        let propName;
        if (!node['computed']) {
            state.object_ = state.value;
            // obj.foo -- Just access `foo` directly.
            propName = node['property']['name'];
        } else if (!state.doneProperty_) {
            state.object_ = state.value;
            // obj[foo] -- Compute value of `foo`.
            state.doneProperty_ = true;
            return new State(node['property'], state.scope);
        } else {
            propName = state.value;
        }
        stack.pop();
        if (state.components) {
            stack[stack.length - 1].value = [state.object_, propName];
        } else {
            const value = this.getProperty(state.object_, propName);
            if (this.getterStep_) {
                // Call the getter function.
                const func = /** @type {!Interpreter.Object} */ (value);
                return this.createGetter_(func, state.object_);
            }
            stack[stack.length - 1].value = value;
        }
    }
  
    stepNewExpression(stack, state, node) {
        return this.stepCallExpression(stack, state, node);
    }
    
    stepObjectExpression(stack, state, node) {
        let n = state.n_ || 0;
        let property = node['properties'][n];
        if (!state.object_) {
            // First execution.
            state.object_ = this.createObjectProto(this.OBJECT_PROTO);
            state.properties_ = Object.create(null);
        } else {
            // Set the property computed in the previous execution.
            const propName = state.destinationName;
            if (!state.properties_[propName]) {
                // Create temp object to collect value, getter, and/or setter.
                state.properties_[propName] = {};
            }
            state.properties_[propName][property['kind']] = state.value;
            state.n_ = ++n;
            property = node['properties'][n];
        }
        if (property) {
            // Determine property name.
            const key = property['key'];
            let propName;
            if (key['type'] === 'Identifier') {
                propName = key['name'];
            } else if (key['type'] === 'Literal') {
                propName = key['value'];
            } else {
                throw SyntaxError('Unknown object structure: ' + key['type']);
            }
            // When assigning an unnamed function to a property, the function's name
            // is set to the property name.  Record the property name in case the
            // value is a functionExpression.
            // E.g. {foo: function() {}}
            state.destinationName = propName;
            return new State(property['value'], state.scope);
        }
        for (const key in state.properties_) {
            const kinds = state.properties_[key];
            if ('get' in kinds || 'set' in kinds) {
                // Set a property with a getter or setter.
                const descriptor = {
                    configurable: true,
                    enumerable: true,
                    get: kinds['get'],
                    set: kinds['set']
                };
                this.setProperty(state.object_, key, VALUE_IN_DESCRIPTOR,
                                descriptor);
            } else {
                // Set a normal property with a value.
                this.setProperty(state.object_, key, kinds['init']);
            }
        }
        stack.pop();
        stack[stack.length - 1].value = state.object_;
    }
  
    stepProgram(stack, state, node) {
        const expression = node['body'].shift();
        if (expression) {
            state.done = false;
            return new State(expression, state.scope);
        }
        state.done = true;
        // Don't pop the stateStack.
        // Leave the root scope on the tree in case the program is appended to.
    }
  
    stepReturnStatement(stack, state, node) {
        if (node['argument'] && !state.done_) {
            state.done_ = true;
            return new State(node['argument'], state.scope);
        }
        this.unwind(Completion.RETURN, state.value, undefined);
    }
  
    stepSequenceExpression(stack, state, node) {
        const n = state.n_ || 0;
        const expression = node['expressions'][n];
        if (expression) {
            state.n_ = n + 1;
            return new State(expression, state.scope);
        }
        stack.pop();
        stack[stack.length - 1].value = state.value;
    }
  
    stepSwitchStatement(stack, state, node) {
        if (!state.test_) {
            state.test_ = 1;
            return new State(node['discriminant'], state.scope);
        }
        if (state.test_ === 1) {
            state.test_ = 2;
            // Preserve switch value between case tests.
            state.switchValue_ = state.value;
            state.defaultCase_ = -1;
        }
  
        for (;;) {
            const index = state.index_ || 0;
            const switchCase = node['cases'][index];
            if (!state.matched_ && switchCase && !switchCase['test']) {
                // Test on the default case is null.
                // Bypass (but store) the default case, and get back to it later.
                state.defaultCase_ = index;
                state.index_ = index + 1;
                continue;
            }
            if (!switchCase && !state.matched_ && state.defaultCase_ !== -1) {
                // Ran through all cases, no match.  Jump to the default.
                state.matched_ = true;
                state.index_ = state.defaultCase_;
                continue;
            }
            if (switchCase) {
                if (!state.matched_ && !state.tested_ && switchCase['test']) {
                    state.tested_ = true;
                    return new State(switchCase['test'], state.scope);
                }
                if (state.matched_ || state.value === state.switchValue_) {
                    state.matched_ = true;
                    const n = state.n_ || 0;
                    if (switchCase['consequent'][n]) {
                        state.isSwitch = true;
                        state.n_ = n + 1;
                        return new State(switchCase['consequent'][n],
                                                    state.scope);
                    }
                }
                // Move on to next case.
                state.tested_ = false;
                state.n_ = 0;
                state.index_ = index + 1;
            } else {
                stack.pop();
                return;
            }
        }
    }
  
    stepThisExpression(stack, state, node) {
        stack.pop();
        stack[stack.length - 1].value = this.getValueFromScope('this');
    }
  
    stepThrowStatement(stack, state, node) {
        if (!state.done_) {
            state.done_ = true;
            return new State(node['argument'], state.scope);
        } else {
            this.throwException(state.value);
        }
    }
  
    stepTryStatement(stack, state, node) {
        if (!state.doneBlock_) {
            state.doneBlock_ = true;
            return new State(node['block'], state.scope);
        }
        if (state.cv && state.cv.type === Completion.THROW &&
            !state.doneHandler_ && node['handler']) {
            state.doneHandler_ = true;
            const nextState = new State(node['handler'], state.scope);
            nextState.throwValue = state.cv.value;
            state.cv = undefined;  // This error has been handled, don't rethrow.
            return nextState;
        }
        if (!state.doneFinalizer_ && node['finalizer']) {
            state.doneFinalizer_ = true;
            return new State(node['finalizer'], state.scope);
        }
        stack.pop();
        if (state.cv) {
            // There was no catch handler, or the catch/finally threw an error.
            // Throw the error up to a higher try.
            this.unwind(state.cv.type, state.cv.value, state.cv.label);
        }
    }
  
    stepUnaryExpression(stack, state, node) {
        if (!state.done_) {
            state.done_ = true;
            const nextState = new State(node['argument'], state.scope);
            nextState.components = node['operator'] === 'delete';
            return nextState;
        }
        stack.pop();
        let value = state.value;
        if (node['operator'] === '-') {
            value = -value;
        } else if (node['operator'] === '+') {
            value = +value;
        } else if (node['operator'] === '!') {
            value = !value;
        } else if (node['operator'] === '~') {
            value = ~value;
        } else if (node['operator'] === 'delete') {
        let result = true;
        // If value is not an array, then it is a primitive, or some other value.
        // If so, skip the delete and return true.
        if (Array.isArray(value)) {
            let obj = value[0];
            if (obj === SCOPE_REFERENCE) {
                // `delete foo;` is the same as `delete window.foo;`.
                obj = state.scope;
            }
            const name = String(value[1]);
            try {
                delete obj.properties[name];
            } catch (e) {
            if (state.scope.strict) {
                this.throwException(this.TYPE_ERROR, "Cannot delete property '" +
                                    name + "' of '" + obj + "'");
            } else {
                result = false;
            }
            }
        }
        value = result;
        } else if (node['operator'] === 'typeof') {
            value = (value && value.class === 'Function') ? 'function' : typeof value;
        } else if (node['operator'] === 'void') {
            value = undefined;
        } else {
            throw SyntaxError('Unknown unary operator: ' + node['operator']);
        }
        stack[stack.length - 1].value = value;
    }
  
    stepUpdateExpression(stack, state, node) {
        if (!state.doneLeft_) {
            state.doneLeft_ = true;
            const nextState = new State(node['argument'], state.scope);
            nextState.components = true;
            return nextState;
        }
        if (!state.leftSide_) {
            state.leftSide_ = state.value;
        }
        if (state.doneGetter_) {
            state.leftValue_ = state.value;
        }
        if (!state.doneGetter_) {
            const leftValue = this.getValue(state.leftSide_);
            state.leftValue_ = leftValue;
            if (this.getterStep_) {
                // Call the getter function.
                state.doneGetter_ = true;
                const func = /** @type {!Interpreter.Object} */ (leftValue);
                return this.createGetter_(func, state.leftSide_);
            }
        }
        if (state.doneSetter_) {
            // Return if setter function.
            // Setter method on property has completed.
            // Ignore its return value, and use the original set value instead.
            stack.pop();
            stack[stack.length - 1].value = state.setterValue_;
            return;
        }
        const leftValue = Number(state.leftValue_);
        let changeValue;
        if (node['operator'] === '++') {
            changeValue = leftValue + 1;
        } else if (node['operator'] === '--') {
            changeValue = leftValue - 1;
        } else {
            throw SyntaxError('Unknown update expression: ' + node['operator']);
        }
        const returnValue = node['prefix'] ? changeValue : leftValue;
        const setter = this.setValue(state.leftSide_, changeValue);
        if (setter) {
            state.doneSetter_ = true;
            state.setterValue_ = returnValue;
            return this.createSetter_(setter, state.leftSide_, changeValue);
        }
        // Return if no setter function.
        stack.pop();
        stack[stack.length - 1].value = returnValue;
    }
  
    stepVariableDeclaration(stack, state, node) {
        const declarations = node['declarations'];
        let n = state.n_ || 0;
        let declarationNode = declarations[n];
        if (state.init_ && declarationNode) {
            // This setValue call never needs to deal with calling a setter function.
            // Note that this is setting the init value, not defining the variable.
            // Variable definition is done when scope is populated.
            this.setValueToScope(declarationNode['id']['name'], state.value);
            state.init_ = false;
            declarationNode = declarations[++n];
        }
        while (declarationNode) {
            // Skip any declarations that are not initialized.  They have already
            // been defined as undefined in populateScope_.
            if (declarationNode['init']) {
                state.n_ = n;
                state.init_ = true;
                // When assigning an unnamed function to a variable, the function's name
                // is set to the variable name.  Record the variable name in case the
                // right side is a functionExpression.
                // E.g. var foo = function() {};
                state.destinationName = declarationNode['id']['name'];
                return new State(declarationNode['init'], state.scope);
            }
            declarationNode = declarations[++n];
        }
        stack.pop();
    }
  
    stepWithStatement(stack, state, node) {
        if (!state.doneObject_) {
            state.doneObject_ = true;
            return new State(node['object'], state.scope);
        } else if (!state.doneBody_) {
                state.doneBody_ = true;
                const scope = this.createSpecialScope(state.scope, state.value);
                return new State(node['body'], scope);
        } else {
                stack.pop();
        }
    }
}
