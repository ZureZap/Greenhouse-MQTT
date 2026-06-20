/** Unit tests for pure simulation helpers. */

const assert = require("assert");
const { clamp, classifyReading, severityFor } = require("./simulation");

assert.strictEqual(clamp(120, 0, 100), 100);
assert.strictEqual(clamp(-1, 0, 100), 0);
assert.strictEqual(classifyReading(20, 22, 28), "low");
assert.strictEqual(classifyReading(25, 22, 28), "normal");
assert.strictEqual(classifyReading(30, 22, 28), "high");
assert.strictEqual(severityFor(35, 22, 28, "high"), "CRITICAL");
assert.strictEqual(severityFor(29, 22, 28, "high"), "WARNING");

console.log("Simulation unit tests passed");
