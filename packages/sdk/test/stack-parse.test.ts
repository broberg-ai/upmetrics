// F027.1 — parseStack must understand every engine our users actually run.
// Before this, Safari and Firefox stacks were dropped WHOLE: they write
// `fn@file:l:c` with no `at`, nothing matched, and the event arrived with
// frames: [] — which the server then groups into one shared issue per error
// type. Measured 2026-08-25: Firefox 0/2, Safari 0/2, anonymous V8 0/1.
// Exercised through captureException (the real path), not an exported internal.
// Run: bun test test/stack-parse.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { init, captureException } from '../src/index';

const DSN = 'https://pub@upmetrics.org/proj';

interface Frame { function?: string; filename?: string; lineno?: number; colno?: number }

function setup(): { frames: () => Frame[] } {
  const bodies: string[] = [];
  const g = globalThis as any;
  g.fetch = async (url: any, o: any) => {
    const u = typeof url === 'string' ? url : (url?.url ?? '');
    if (u.includes('/envelope/')) bodies.push(String(o?.body ?? ''));
    return new Response(null, { status: 200 });
  };
  g.__upmetricsFetchWrapped = false;
  init({ dsn: DSN, environment: 'test', release: 'stack-parse-test' });
  return {
    frames: () => {
      const last = bodies[bodies.length - 1] ?? '';
      // envelope = header line(s) + JSON event; take the line carrying exception
      const line = last.split('\n').find((l) => l.includes('"exception"')) ?? '{}';
      return JSON.parse(line)?.exception?.values?.[0]?.stacktrace?.frames ?? [];
    },
  };
}

/** Throw an Error carrying a hand-written stack from a specific engine. */
function withStack(stack: string | undefined): Error {
  const e = new Error('boom');
  e.name = 'TestError';
  Object.defineProperty(e, 'stack', { value: stack, configurable: true });
  return e;
}

// One REAL example per engine. `expected` is the frame count that must survive.
const CASES: Array<{ name: string; stack: string; expected: number; top: Partial<Frame> }> = [
  {
    name: 'V8/Node — named frames',
    stack: 'Error: boom\n    at doThing (/app/src/a.js:10:5)\n    at main (/app/src/b.js:3:1)',
    expected: 2,
    top: { function: 'doThing', filename: '/app/src/a.js', lineno: 10, colno: 5 },
  },
  {
    name: 'V8 — ANONYMOUS frame (no function name)',
    stack: 'Error: boom\n    at /app/src/a.js:10:5',
    expected: 1,
    top: { function: '<anonymous>', filename: '/app/src/a.js', lineno: 10, colno: 5 },
  },
  {
    name: 'V8 — async frame',
    stack: 'Error: boom\n    at async load (/app/src/a.js:10:5)',
    expected: 1,
    top: { function: 'async load', filename: '/app/src/a.js', lineno: 10, colno: 5 },
  },
  {
    name: 'Chrome browser',
    stack: 'Error: boom\n    at fetchData (https://webhouse.app/_next/static/chunk.js:1:200)',
    expected: 1,
    top: { function: 'fetchData', filename: 'https://webhouse.app/_next/static/chunk.js', lineno: 1, colno: 200 },
  },
  {
    name: 'FIREFOX — no header line, crashing frame FIRST',
    stack: 'fetchData@https://webhouse.app/chunk.js:1:200\nmain@https://webhouse.app/x.js:2:9',
    expected: 2,
    top: { function: 'fetchData', filename: 'https://webhouse.app/chunk.js', lineno: 1, colno: 200 },
  },
  {
    name: 'SAFARI — incl. an unnamed frame',
    stack: 'fetchData@https://webhouse.app/chunk.js:1:200\n@https://webhouse.app/chunk.js:5:1',
    expected: 2,
    top: { function: 'fetchData', filename: 'https://webhouse.app/chunk.js', lineno: 1, colno: 200 },
  },
  {
    name: 'SAFARI — global code (space in the function name)',
    stack: 'global code@https://webhouse.app/chunk.js:5:1',
    expected: 1,
    top: { function: 'global code', filename: 'https://webhouse.app/chunk.js', lineno: 5, colno: 1 },
  },
];

describe('F027.1 — parseStack across engines', () => {
  let rec: ReturnType<typeof setup>;
  beforeEach(() => { rec = setup(); });

  for (const c of CASES) {
    it(`${c.name} → ${c.expected} frame(s)`, () => {
      captureException(withStack(c.stack));
      const frames = rec.frames();
      expect(frames.length).toBe(c.expected);
      // Frames are stored oldest-first, so the CRASHING frame is last.
      const crashing = frames[frames.length - 1];
      // Strict equality per field: a frame with the wrong filename is as
      // useless as no frame, and a count-only assert would pass on it.
      expect(crashing.function).toBe(c.top.function!);
      expect(crashing.filename).toBe(c.top.filename!);
      expect(crashing.lineno).toBe(c.top.lineno!);
      expect(crashing.colno).toBe(c.top.colno!);
    });
  }

  // NEGATIVE CONTROL. Without it, "we now capture everything" cannot be told
  // apart from "we invent frames". A DOMException from AbortSignal.timeout
  // genuinely carries no stack — that must still come through as empty.
  it('a genuinely stackless error still yields NO frames (never invented)', () => {
    captureException(withStack(undefined));
    expect(rec.frames().length).toBe(0);
  });

  it('a stack that is only a header yields no frames', () => {
    captureException(withStack('TimeoutError: signal timed out'));
    expect(rec.frames().length).toBe(0);
  });
});
