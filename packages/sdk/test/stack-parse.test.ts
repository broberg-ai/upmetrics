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

// One HAND-WRITTEN example per engine — written from what each engine should
// produce, so passing proves the parser matches that expectation, not the
// format. The CAPTURED stacks at the bottom of this file are the real thing.
// `expected` is the frame count that must survive.
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

// ── Captured from real browsers ──────────────────────────────────────────────
// The cases above are hand-written: they prove the parser matches MY idea of
// what Safari and Firefox emit. These were captured by the coverletter session
// via Lens from an actual WebKit and an actual Firefox against a live page
// (raw `e.stack`, verbatim, call chain levelOne → levelTwo → `null.boom`).
// They carry five things a hand-written sample does not think to contain:
//
//   1. `global code@` — a function name with a SPACE in it
//   2. `appendChild@[native code]` — a named frame with NO line/col at all
//   3. a Firefox filename containing spaces AND `>`:
//      `…/auth/signin line 3 > injectedScript:1:22`
//   4. `anonymous/</<@` — a name containing `/` and `<` (nested closures)
//   5. a frame that is literally `@` and nothing else
//
// Any of 1, 3 or 4 would silently corrupt a parser that splits on whitespace,
// on `/`, or takes "up to the first space" as the filename.
const WEBKIT_REAL = `levelTwo@https://coverletter-generator.fly.dev/auth/signin:1:26
levelOne@https://coverletter-generator.fly.dev/auth/signin:1:63
global code@https://coverletter-generator.fly.dev/auth/signin:1:82
appendChild@[native code]
@
@
anonymous@
evalAssertBody@
evaluate@
@`;

const FIREFOX_REAL = `levelTwo@https://coverletter-generator.fly.dev/auth/signin line 3 > injectedScript:1:22
levelOne@https://coverletter-generator.fly.dev/auth/signin line 3 > injectedScript:1:55
@https://coverletter-generator.fly.dev/auth/signin line 3 > injectedScript:1:74
anonymous/</<@debugger eval code line 303 > eval line 4 > Function:3:250
anonymous/<@debugger eval code line 303 > eval line 4 > Function:3:376
anonymous@debugger eval code line 303 > eval line 4 > Function:3:380
evalAssertBody@debugger eval code:14:10
evaluate@debugger eval code:305:16
@debugger eval code:1:44`;

// A WHOLE WebKit stack in which not one frame carries a file. Not an excerpt,
// and not an edge case — this is what an inline `null.x` in an eval context
// produces, and it is half of an ordinary Safari stack. It is the input that
// still reaches the server with frames: [] after F027.1, which is why F027.2
// (frameless events must not share one fingerprint) exists.
const WEBKIT_NO_FILE = `@
@
anonymous@
evalAssertBody@
evaluate@
@`;

describe('F027.1 — stacks captured from real browsers, not written by hand', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => { h = setup(); });

  it('WebKit: keeps the three located frames and names the crashing one exactly', () => {
    captureException(withStack(WEBKIT_REAL));
    const f = h.frames();
    expect(f.length).toBe(3);
    // Sentry order: crashing frame LAST.
    expect(f[f.length - 1]).toEqual({
      function: 'levelTwo',
      filename: 'https://coverletter-generator.fly.dev/auth/signin',
      lineno: 1,
      colno: 26,
    });
    // The space in `global code` must survive intact — a whitespace split loses it.
    expect(f[0]).toEqual({
      function: 'global code',
      filename: 'https://coverletter-generator.fly.dev/auth/signin',
      lineno: 1,
      colno: 82,
    });
  });

  it('WebKit: a frame with no line/col, and a frame that is only `@`, are skipped without throwing', () => {
    captureException(withStack(WEBKIT_REAL));
    // 7 of the 10 lines carry no location; none of them may become a frame with
    // NaN or undefined fields, and none may abort the parse of the other three.
    const f = h.frames();
    expect(f.length).toBe(3);
    for (const fr of f) {
      expect(Number.isFinite(fr.lineno)).toBe(true);
      expect(Number.isFinite(fr.colno)).toBe(true);
      expect(fr.filename).toBeTruthy();
    }
  });

  it('Firefox: parses all nine frames, including filenames containing spaces and `>`', () => {
    captureException(withStack(FIREFOX_REAL));
    const f = h.frames();
    expect(f.length).toBe(9);
    expect(f[f.length - 1]).toEqual({
      function: 'levelTwo',
      filename: 'https://coverletter-generator.fly.dev/auth/signin line 3 > injectedScript',
      lineno: 1,
      colno: 22,
    });
  });

  it('Firefox: a name containing `/` and `<` is not split in half', () => {
    captureException(withStack(FIREFOX_REAL));
    const f = h.frames();
    const nested = f.find((x) => x.function === 'anonymous/</<');
    expect(nested).toBeTruthy();
    expect(nested!.filename).toBe('debugger eval code line 303 > eval line 4 > Function');
    expect(nested!.lineno).toBe(3);
    expect(nested!.colno).toBe(250);
  });

  it('Firefox: an unnamed frame keeps its location and is labelled, not blanked', () => {
    captureException(withStack(FIREFOX_REAL));
    const f = h.frames();
    const unnamed = f.find((x) => x.colno === 74)!;
    expect(unnamed.function).toBe('<anonymous>');
    expect(unnamed.filename).toBe('https://coverletter-generator.fly.dev/auth/signin line 3 > injectedScript');
  });

  it('a whole WebKit stack with no file anywhere yields 0 frames — the F027.2 input', () => {
    // Documents the LIMIT, so nobody reads F027.1 as "Safari is solved". The
    // parser is right to produce nothing here (there is nothing to produce);
    // what is still wrong is downstream, where every frameless event of a type
    // collapses into ONE issue. This test must keep passing at 0 and be
    // referenced when F027.2 changes what the server does with that.
    captureException(withStack(WEBKIT_NO_FILE));
    expect(h.frames().length).toBe(0);
  });
});
