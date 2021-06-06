import Interpreter from '../interpreter';
import InterpreterObject from '../object';

const JAVASCRIPT = `
var x=1;
x;
`;

test('Parse and run some JS', () => {
    const interpreter = new Interpreter(JAVASCRIPT, null);
    const paused = interpreter.run();
    expect(paused).toEqual(false);
    expect(interpreter.value).toEqual(1);
});

const JAVASCRIPT_FUNCTION = `
function addOne(number) {
    return number + 1
}
addOne(1);
`;

test('Parse and run a javascript function', () => {
    const interpreter = new Interpreter(JAVASCRIPT_FUNCTION, null);
    const paused = interpreter.run();
    expect(paused).toEqual(false);
    expect(JSON.parse(interpreter.value)).toEqual(2);
});

const JAVASCRIPT_OBJECT = `
var obj = {};
obj.prop = "hi";
obj.prop;
`;

test('Parse setting up a JS object', () => {
    const interpreter = new Interpreter(JAVASCRIPT_OBJECT, null);
    const paused = interpreter.run();
    expect(paused).toEqual(false);
    expect(interpreter.value).toEqual('hi');
});

const JAVASCRIPT_OBJECT_INPUT_OUTPUT = `
inputObject.b = 2;
this.inputObject;
`;

test('Parse inputing and outputing a JS object', () => {
    const interpreter = new Interpreter(JAVASCRIPT_OBJECT_INPUT_OUTPUT, (interpreter: Interpreter, globalObj: InterpreterObject) => {
        const inputObject = interpreter.nativeToPseudo({});
        interpreter.setProperty(globalObj, 'inputObject', inputObject);
        interpreter.setProperty(inputObject, 'a', 1);
    });
    const paused = interpreter.run();
    expect(paused).toEqual(false);
    expect(interpreter.pseudoToNative(interpreter.value)).toEqual({a: 1, b:2});
});