# ES Interpreter

This is a sandboxed intepreter for Javascript written in Javascript. 

This is largely based on the [JS-Interpreter project](https://github.com/NeilFraser/JS-Interpreter),
but updated to use typescript, be an npm package, and have tests.

## Installation

```sh
npm install es-interpreter 
yarn add es-interpreter
```

## Usage

```javascript
const code = `
function addOne(number) {
    return number + 1
}
var a = 5;
addOne(a);
`

const interpreter = new Interpreter(code, null);
const paused = interpreter.run();
console.log(interpreter.value);
```

