
/**
 * @license
 * Copyright 2013 Google LLC
 * Modifications Copyright 2021 John Daniels
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * For cycle detection in array to string and error conversion;
 * see spec bug github.com/tc39/ecma262/issues/289
 * Since this is for atomic actions only, it can be a class property.
 */
const toStringCycles_ = [];

/**
 * Class for an object.
 * @param {Interpreter.Object} proto Prototype object or null.
 * @constructor
 */
export default class InterpreterObject {
    illegalConstructor: boolean;
    preventExtensions: boolean;
    eval: boolean;

    getter: any;
    setter: any;
    properties: any;
    proto: any;
    nativeFunc: any;
    parentScope: any;
    node: any;
    asyncFunc: any;

    class: string;
    constructor(proto) {
        this.getter = Object.create(null);
        this.setter = Object.create(null);
        this.properties = Object.create(null);
        this.proto = proto;
    }
  
    /**
     * Convert this object into a string.
     * @return {string} String value.
     * @override
     */
    toString() {
        if (!(this instanceof InterpreterObject)) {
            // Primitive value.
            return String(this);
        }
    
        if (this.class === 'Array') {
            // Array contents must not have cycles.
            const cycles = toStringCycles_;
            cycles.push(this);
            const strs = [];
            try {
                // Truncate very long strings.  This is not part of the spec,
                // but it prevents hanging the interpreter for gigantic arrays.
                let maxLength = this.properties.length;
                let truncated = false;
                if (maxLength > 1024) {
                    maxLength = 1000;
                    truncated = true;
                }
                for (let i = 0; i < maxLength; i++) {
                    const value = this.properties[i];
                    strs[i] = ((value instanceof InterpreterObject) &&
                        cycles.indexOf(value) !== -1) ? '...' : value;
                }
                if (truncated) {
                    strs.push('...');
                }
            } finally {
                cycles.pop();
            }
            return strs.join(',');
        }
    
        if (this.class === 'Error') {
            // Error name and message properties must not have cycles.
            const cycles = toStringCycles_;
            if (cycles.indexOf(this) !== -1) {
                return '[object Error]';
            }
            let name, message;
            // Bug: Does not support getters and setters for name or message.
            let obj = this;
            do {
                if ('name' in obj.properties) {
                    name = obj.properties['name'];
                    break;
                }
            } while ((obj = obj.proto));
            
            obj = this;
            do {
                if ('message' in obj.properties) {
                    message = obj.properties['message'];
                    break;
                }
            } while ((obj = obj.proto));
            cycles.push(this);
            try {
                name = name && String(name);
                message = message && String(message);
            } finally {
                cycles.pop();
            }
            return message ? name + ': ' + message : String(name);
        }
    
        if (this.data !== null) {
            // RegExp, Date, and boxed primitives.
            return String(this.data);
        }
    
        return '[object ' + this.class + ']';
    }
  
  /**
   * Return the object's value.
   * @return {Interpreter.Value} Value.
   * @override
   */
    valueOf() {
        if (this.data === undefined || this.data === null ||
            this.data instanceof RegExp) {
        return this;  // An Object, RegExp, or primitive.
        }
        if (this.data instanceof Date) {
        return this.data.valueOf();  // Milliseconds.
        }
        return /** @type {(boolean|number|string)} */ (this.data);  // Boxed primitive.
    }

    get data() {
        return null;
    }
}