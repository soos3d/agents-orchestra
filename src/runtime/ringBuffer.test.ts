// Defect 8: unbounded stdout accumulation. A chatty worker in an hours-long loop is
// an OOM, and the orchestrator never reads the middle of a transcript anyway.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRingBuffer } from "./ringBuffer.js";

describe("createRingBuffer", () => {
  test("keeps everything while under the limit", () => {
    const buffer = createRingBuffer(100);

    buffer.push("hello ");
    buffer.push("world");

    assert.equal(buffer.text(), "hello world");
    assert.equal(buffer.dropped, 0);
  });

  test("keeps the head and the tail, dropping the middle", () => {
    const buffer = createRingBuffer(10);

    buffer.push("HEAD");
    buffer.push("x".repeat(1000));
    buffer.push("TAIL");

    const text = buffer.text();
    assert.match(text, /^HEAD/);
    assert.match(text, /TAIL$/);
    assert.match(text, /bytes dropped/);
  });

  test("stays bounded however many times it is pushed", () => {
    const buffer = createRingBuffer(64);

    for (let i = 0; i < 10_000; i++) buffer.push(`line ${i}\n`);

    // Head + tail + the dropped marker, and nothing that grows with the input.
    assert.ok(buffer.text().length < 200, `got ${buffer.text().length} bytes`);
    assert.ok(buffer.dropped > 10_000);
  });

  test("counts exactly what it dropped", () => {
    const buffer = createRingBuffer(10);

    buffer.push("a".repeat(30));

    assert.equal(buffer.dropped, 20);
  });

  test("rejects a limit too small to hold a head and a tail", () => {
    assert.throws(() => createRingBuffer(1), RangeError);
  });
});
