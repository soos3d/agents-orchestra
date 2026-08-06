// A capped accumulator for worker output.
//
// `sh.ts` used to append stdout and stderr into unbounded strings. A chatty worker
// in an hours-long loop is an OOM, and the orchestrator never reads the middle of a
// transcript anyway — it needs the start (what the worker was asked, what it began
// doing) and the end (the failure, the final message).
export interface RingBuffer {
  push(chunk: string): void;
  /** Head + tail, with a marker naming what was dropped. */
  text(): string;
  readonly dropped: number;
}

export function createRingBuffer(limit: number): RingBuffer {
  if (limit < 2) throw new RangeError(`Ring buffer limit must be at least 2, got ${limit}`);

  const headLimit = Math.floor(limit / 2);
  const tailLimit = limit - headLimit;

  let head = "";
  let tail = "";
  let dropped = 0;

  return {
    push(chunk) {
      if (head.length < headLimit) {
        const room = headLimit - head.length;
        head += chunk.slice(0, room);
        chunk = chunk.slice(room);
      }
      if (chunk === "") return;

      tail += chunk;
      if (tail.length > tailLimit) {
        dropped += tail.length - tailLimit;
        tail = tail.slice(tail.length - tailLimit);
      }
    },

    text() {
      if (dropped === 0) return head + tail;
      return `${head}\n… ${dropped} bytes dropped …\n${tail}`;
    },

    get dropped() {
      return dropped;
    },
  };
}
