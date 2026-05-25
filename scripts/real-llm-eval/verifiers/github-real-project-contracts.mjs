import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const taskId = process.argv[2];
const workspaceDir = process.cwd();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceDir,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `command failed: ${command} ${args.join(" ")}`,
      `exit=${result.status} signal=${result.signal ?? ""}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function requireWorkspaceModule(relativePath) {
  return import(pathToFileURL(path.join(workspaceDir, relativePath)).href);
}

async function verifyCommanderShortOptionSuggestions() {
  const commander = await requireWorkspaceModule("index.js");
  const { Command, Option } = commander.default ?? commander;

  function getSuggestion(program, args) {
    let message = "";
    program
      .showSuggestionAfterError()
      .exitOverride()
      .configureOutput({
        writeErr: (str) => {
          message += str;
        },
      });
    try {
      program.parse(Array.isArray(args) ? args : [args], { from: "user" });
    } catch {
      // The command intentionally throws through exitOverride for invalid input.
    }
    const match = message.match(/Did you mean (one of )?(.*)\?/);
    return match ? match[2] : null;
  }

  const shortProgram = new Command();
  shortProgram.helpOption(false).option("-p, --pepper", "add pepper");
  assert.equal(getSuggestion(shortProgram, "-o"), "-p");

  const hiddenShortProgram = new Command();
  hiddenShortProgram.helpOption(false).addOption(new Option("-s, --secret").hideHelp());
  assert.equal(getSuggestion(hiddenShortProgram, "-e"), null);

  const longProgram = new Command();
  longProgram.option("-p, --pepper", "add pepper");
  assert.equal(getSuggestion(longProgram, "--peper"), "--pepper");

  const suggestionTests = fs.readFileSync(path.join(workspaceDir, "tests/help.suggestion.test.js"), "utf8");
  assert.match(suggestionTests, /short option|single-dash|single dash/i);
  assert.match(suggestionTests, /['"`]-o['"`]/);
  assert.match(suggestionTests, /['"`]-p['"`]/);

  const suggestSimilarSource = fs.readFileSync(path.join(workspaceDir, "lib/suggestSimilar.js"), "utf8");
  assert.equal(
    crypto.createHash("sha256").update(suggestSimilarSource).digest("hex"),
    "6a3a368ace1abd1cc6b551ae10bcbae18eda3fed0fb0cfd60c7960c6663dad58",
  );

  run("npx", ["jest", "tests/help.suggestion.test.js", "--runInBand"], {
    env: {
      ...process.env,
      CI: "1",
    },
  });
}

async function verifyAxiosSetCookieToString() {
  const axiosHeadersModule = await requireWorkspaceModule("lib/core/AxiosHeaders.js");
  const AxiosHeaders = axiosHeadersModule.default;
  assert.equal(typeof AxiosHeaders, "function");

  const setCookieHeaders = new AxiosHeaders({
    "set-cookie": ["session=abc; Path=/; HttpOnly", "theme=dark; Path=/"],
  });
  assert.equal(
    setCookieHeaders.toString(),
    "set-cookie: session=abc; Path=/; HttpOnly\nset-cookie: theme=dark; Path=/",
    "AxiosHeaders.toString() must serialize set-cookie arrays as repeated header lines, not a comma-merged header.",
  );
  assert.deepEqual(
    setCookieHeaders.getSetCookie(),
    ["session=abc; Path=/; HttpOnly", "theme=dark; Path=/"],
    "getSetCookie() must still expose the original cookie array after toString().",
  );

  const parsedRawHeaders = new AxiosHeaders([
    ["set-cookie", "a=1; Path=/"],
    ["set-cookie", "b=2; Path=/"],
  ]);
  assert.equal(
    parsedRawHeaders.toString(),
    "set-cookie: a=1; Path=/\nset-cookie: b=2; Path=/",
    "Iterable set-cookie input must also serialize as repeated header lines.",
  );

  const normalArrayHeader = new AxiosHeaders({
    accept: ["application/json", "text/plain"],
  });
  assert.equal(
    normalArrayHeader.toString(),
    "accept: application/json,text/plain",
    "Non set-cookie array headers must retain the existing comma serialization behavior.",
  );

  const source = fs.readFileSync(path.join(workspaceDir, "lib/core/AxiosHeaders.js"), "utf8");
  assert.match(source, /toString\(\)\s*{/, "AxiosHeaders.js must implement the toString behavior.");
  assert.match(source, /set-cookie/i, "AxiosHeaders.js must special-case set-cookie serialization.");
  assert.match(source, /utils\.isArray|Array\.isArray/, "AxiosHeaders.js must handle array header values explicitly.");

  const tests = fs.readFileSync(path.join(workspaceDir, "tests/unit/axiosHeaders.test.js"), "utf8");
  assert.match(
    tests,
    /set-cookie[\s\S]{0,160}(toString|serialize)|toString[\s\S]{0,160}set-cookie/i,
    "tests/unit/axiosHeaders.test.js must include verifier-visible set-cookie toString coverage.",
  );
  assert.match(
    tests,
    /session=abc|theme=dark|a=1|b=2/,
    "AxiosHeaders tests must assert concrete cookie values, not only a generic array branch.",
  );
  assert.match(
    tests,
    /application\/json[\s\S]{0,160}text\/plain|text\/plain[\s\S]{0,160}application\/json/,
    "AxiosHeaders tests must preserve normal array header serialization coverage with application/json and text/plain.",
  );
  assert.match(
    tests,
    /accept:\s*application\/json,text\/plain/,
    "tests/unit/axiosHeaders.test.js must assert the exact normal array toString output `accept: application/json,text/plain`.",
  );

  run("npx", ["vitest", "run", "tests/unit/axiosHeaders.test.js", "--project", "unit"], {
    env: {
      ...process.env,
      CI: "1",
    },
  });
}

async function verifyPicomatchArrayReturnObject() {
  const picomatchModule = await requireWorkspaceModule("index.js");
  const picomatch = picomatchModule.default ?? picomatchModule;
  assert.equal(typeof picomatch, "function");

  const singleMatcher = picomatch("*.js");
  const singleResult = singleMatcher("index.js", true);
  assert.equal(typeof singleResult, "object", "single-pattern matchers must still support returnObject=true.");
  assert.equal(singleResult.isMatch, true);
  assert.equal(singleResult.glob, "*.js");
  assert.equal(singleResult.input, "index.js");

  const arrayMatcher = picomatch(["*.js", "*.md"]);
  const jsResult = arrayMatcher("index.js", true);
  assert.equal(typeof jsResult, "object", "array-pattern matchers must return the matched result object when returnObject=true.");
  assert.equal(jsResult.isMatch, true);
  assert.equal(jsResult.glob, "*.js");
  assert.equal(jsResult.input, "index.js");
  assert.equal(jsResult.output, "index.js");

  const mdResult = arrayMatcher("readme.md", true);
  assert.equal(typeof mdResult, "object", "array-pattern returnObject=true must work for later patterns, not only the first pattern.");
  assert.equal(mdResult.isMatch, true);
  assert.equal(mdResult.glob, "*.md");
  assert.equal(mdResult.input, "readme.md");

  assert.equal(arrayMatcher("style.css"), false, "default array-pattern miss behavior must stay boolean false.");
  assert.equal(arrayMatcher("index.js"), true, "default array-pattern hit behavior must stay boolean true.");

  const callbackEvents = [];
  const callbackMatcher = picomatch(["*.js", "*.md"], {
    onResult: result => {
      callbackEvents.push(`${result.glob}:${result.input}:${result.isMatch}`);
    },
  });
  const callbackResult = callbackMatcher("readme.md", true);
  assert.equal(callbackResult.glob, "*.md");
  assert(
    callbackEvents.includes("*.js:readme.md:false"),
    "array-pattern matching must still evaluate and expose the non-matching earlier pattern through onResult.",
  );
  assert(
    callbackEvents.includes("*.md:readme.md:true"),
    "array-pattern matching must expose the matching later pattern through onResult.",
  );

  const source = fs.readFileSync(path.join(workspaceDir, "lib/picomatch.js"), "utf8");
  assert.match(source, /Array\.isArray\(glob\)[\s\S]{0,700}returnObject/);
  assert.match(
    source,
    /isMatch\(\s*str\s*,\s*true\s*\)|isMatch\(\s*input\s*,\s*true\s*\)/,
    "array-pattern matching must inspect per-pattern result objects instead of treating a returnObject=false miss as enough state.",
  );

  const tests = fs.readFileSync(path.join(workspaceDir, "test/api.picomatch.js"), "utf8");
  assert.match(
    tests,
    /array patterns[\s\S]{0,180}returnObject|returnObject[\s\S]{0,180}array patterns/i,
    "test/api.picomatch.js must include verifier-visible array patterns returnObject coverage.",
  );
  assert.match(
    tests,
    /glob[\s\S]{0,80}\*\.md|['"`]\*\.md['"`][\s\S]{0,120}glob/,
    "array returnObject tests must assert the later matched glob, such as `*.md`.",
  );

  run("npx", ["mocha", "test/api.picomatch.js", "--reporter", "dot"], {
    env: {
      ...process.env,
      CI: "1",
    },
  });
}

async function verifyYargsParserArrayNargZero() {
  run("npm", ["run", "pretest"], {
    env: {
      ...process.env,
      CI: "1",
    },
  });

  const parserModule = await requireWorkspaceModule("build/lib/index.js");
  const parser = parserModule.default ?? parserModule;
  assert.equal(typeof parser, "function");
  assert.equal(typeof parser.detailed, "function");

  const separated = parser.detailed(["--items", "positional", "--other", "value"], {
    array: ["items"],
    narg: { items: 0 },
  });
  assert.equal(separated.error, null);
  assert.deepEqual(
    separated.argv.items,
    [],
    "array options with narg:0 must default to an empty array instead of consuming the following positional value.",
  );
  assert.deepEqual(
    separated.argv._,
    ["positional"],
    "array options with narg:0 must leave the next positional argument in argv._.",
  );
  assert.equal(separated.argv.other, "value");

  const equals = parser.detailed(["--items=unexpected"], {
    array: ["items"],
    narg: { items: 0 },
  });
  assert.equal(
    equals.error?.message,
    "Argument unexpected for: items",
    "array options with narg:0 must reject --items=value the same way normal narg:0 options do.",
  );
  assert.deepEqual(equals.argv.items, []);

  const alias = parser.detailed(["-i", "positional"], {
    array: ["items"],
    alias: { items: "i" },
    narg: { items: 0 },
  });
  assert.equal(alias.error, null);
  assert.deepEqual(alias.argv.items, []);
  assert.deepEqual(alias.argv.i, []);
  assert.deepEqual(alias.argv._, ["positional"]);

  const control = parser(["--items", "alpha", "beta"], {
    array: ["items"],
    narg: { items: 1 },
  });
  assert.deepEqual(
    control.items,
    ["alpha"],
    "array+narg counts greater than zero must keep consuming the configured number of values.",
  );
  assert.deepEqual(control._, ["beta"]);

  const source = fs.readFileSync(path.join(workspaceDir, "lib/yargs-parser.ts"), "utf8");
  assert.match(source, /function eatArray\s*\(/, "lib/yargs-parser.ts must own array argument consumption in eatArray().");

  const tests = fs.readFileSync(path.join(workspaceDir, "test/yargs-parser.mjs"), "utf8");
  assert.match(
    tests,
    /array narg zero|array narg 0|narg:0[\s\S]{0,120}array|array[\s\S]{0,120}narg:0/i,
    "test/yargs-parser.mjs must include verifier-visible coverage for array narg zero behavior.",
  );
  assert.match(
    tests,
    /Argument unexpected for: items|--items=unexpected/,
    "test/yargs-parser.mjs must cover --items=value rejection for array narg:0.",
  );

  run("npx", ["mocha", "test/yargs-parser.mjs", "--grep", "array narg zero|array narg 0|narg:0"], {
    env: {
      ...process.env,
      CI: "1",
    },
  });
}

async function verifyGotUploadProgressJsonFormIssue() {
  run("npm", ["run", "build"], {
    env: {
      ...process.env,
      CI: "1",
    },
    timeout: 120000,
  });

  const packageJson = JSON.parse(fs.readFileSync(path.join(workspaceDir, "package.json"), "utf8"));
  assert.equal(
    packageJson.dependencies?.["chunk-data"],
    "^0.1.0",
    "package.json must expose chunk-data as a runtime dependency because source/core/index.ts imports it.",
  );
  assert.equal(
    packageJson.devDependencies?.["chunk-data"],
    undefined,
    "chunk-data must not remain only in devDependencies when runtime source imports it.",
  );

  const behaviorScript = `
import assert from 'node:assert/strict';
import http from 'node:http';
import got from './dist/source/index.js';

const server = http.createServer((request, response) => {
  if (request.url === '/redirect-307') {
    response.writeHead(307, {location: '/redirect-target'});
    response.end();
    return;
  }

  let bytes = 0;
  request.on('data', chunk => {
    bytes += chunk.length;
  });
  request.on('end', () => {
    response.end(String(bytes));
  });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;

async function collect(path, options) {
  const events = [];
  const response = await got.post(url + path, {
    retry: {limit: 0},
    ...options,
  }).on('uploadProgress', event => {
    events.push({
      percent: event.percent,
      transferred: event.transferred,
      total: event.total,
    });
  });
  return {events, body: response.body};
}

function assertGranular(name, events) {
  assert(events.length > 3, name + ' must emit granular uploadProgress events, not only 0% and 100%. Got ' + events.length + ' events.');
  assert.equal(events[0].percent, 0, name + ' first event must start at 0%.');
  assert.equal(events.at(-1).percent, 1, name + ' final event must finish at 100%.');
  assert(events.some(event => event.transferred > 0 && event.transferred < event.total && event.percent > 0 && event.percent < 1), name + ' must include at least one intermediate progress event.');
}

const jsonResult = await collect('/', {json: {payload: '.'.repeat(300_000)}});
assertGranular('json option', jsonResult.events);

const formResult = await collect('/', {form: {payload: '.'.repeat(300_000)}});
assertGranular('form option', formResult.events);

const bufferBody = Buffer.alloc(300_000, 'b');
const bufferResult = await collect('/', {
  body: bufferBody,
  headers: {'content-length': String(bufferBody.byteLength)},
});
assertGranular('buffer body', bufferResult.events);
assert.equal(bufferResult.body, String(bufferBody.byteLength), 'buffer body must still be fully delivered.');

const redirectBody = Buffer.alloc(196_608, 'r');
const redirectResult = await collect('/redirect-307', {
  body: redirectBody,
  headers: {'content-length': String(redirectBody.byteLength)},
});
assert.equal(redirectResult.body, String(redirectBody.byteLength), '307 redirects must replay the buffered request body.');
assert.equal(redirectResult.events.at(-1).percent, 1, 'redirected buffered uploads must finish with a final 100% event.');
assert(redirectResult.events.some(event => event.transferred > 0 && event.transferred < redirectBody.byteLength), 'redirected buffered uploads must preserve intermediate progress after redirect.');

server.close();
`;
  run("node", ["--input-type=module", "--eval", behaviorScript], {
    env: {
      ...process.env,
      CI: "1",
    },
    timeout: 120000,
  });

  const source = fs.readFileSync(path.join(workspaceDir, "source/core/index.ts"), "utf8");
  assert.match(source, /from 'chunk-data'/, "source/core/index.ts must import chunk-data for runtime body chunking.");
  assert.match(source, /_writeBodyInChunks|_writeChunksToRequest/, "source/core/index.ts must route non-stream bodies through a chunked write helper.");
  assert.match(source, /_emitUploadComplete|upload-complete/, "source/core/index.ts must preserve upload completion semantics.");
  assert.match(source, /_skipRequestEndInFinal|_finalizeStaleChunkedWrite/, "source/core/index.ts must handle stale chunked writes across redirects.");

  const progressTests = fs.readFileSync(path.join(workspaceDir, "test/progress.ts"), "utf8");
  assert.match(progressTests, /upload progress - json option/i, "test/progress.ts must include json option upload progress coverage.");
  assert.match(progressTests, /upload progress - form option/i, "test/progress.ts must include form option upload progress coverage.");
  assert.match(progressTests, /upload progress - buffer body/i, "test/progress.ts must include buffer body upload progress coverage.");
  assert.match(progressTests, /events\.length\s*>\s*2|more than 2 events/i, "progress tests must assert granular events beyond 0% and 100%.");

  const hookTests = fs.readFileSync(path.join(workspaceDir, "test/hooks.ts"), "utf8");
  assert.match(
    hookTests,
    /beforeRequest hook with large json body|beforeRequest[\s\S]{0,220}large json body/i,
    "test/hooks.ts must cover beforeRequest short-circuiting with a large json body.",
  );

  const redirectTests = fs.readFileSync(path.join(workspaceDir, "test/redirects.ts"), "utf8");
  assert.match(
    redirectTests,
    /early 307 redirect preserves upload progress totals/i,
    "test/redirects.ts must cover early 307 redirect upload progress totals.",
  );
  assert.match(
    redirectTests,
    /early 307 redirect finalizes writable side for buffered body/i,
    "test/redirects.ts must cover writable finalization for early buffered redirects.",
  );

  const docs = fs.readFileSync(path.join(workspaceDir, "documentation/3-streams.md"), "utf8");
  assert.match(
    docs,
    /Granular upload progress[\s\S]{0,180}json[\s\S]{0,80}form/i,
    "documentation/3-streams.md must document granular upload progress for json and form options.",
  );

  run("./node_modules/.bin/ava", [
    "test/progress.ts",
    "test/hooks.ts",
    "test/redirects.ts",
    "--match=upload progress - json option",
    "--match=upload progress - form option",
    "--match=upload progress - buffer body",
    "--match=returning HTTP response from a beforeRequest hook with large json body",
    "--match=early 307 redirect preserves upload progress totals",
    "--match=early 307 redirect finalizes writable side for buffered body",
    "--timeout=3m",
  ], {
    env: {
      ...process.env,
      CI: "1",
      NODE_OPTIONS: "--import=tsx/esm",
    },
    timeout: 180000,
  });
}

async function verifyPLimitClearQueueReturnCount() {
  const pLimitModule = await requireWorkspaceModule("index.js");
  const pLimit = pLimitModule.default;
  assert.equal(typeof pLimit, "function");

  const never = () => new Promise(() => {});
  const limit = pLimit(1);
  limit(never);
  limit(() => "one");
  limit(() => "two");
  limit(() => "three");

  await Promise.resolve();
  assert.equal(limit.pendingCount, 3);
  assert.equal(limit.clearQueue(), 3);
  assert.equal(limit.pendingCount, 0);
  assert.equal(limit.clearQueue(), 0);

  const rejectingLimit = pLimit({concurrency: 1, rejectOnClear: true});
  const runningPromise = rejectingLimit(() => new Promise(resolve => {
    setTimeout(resolve, 25);
  }));
  const pendingPromiseOne = rejectingLimit(() => "one");
  const pendingPromiseTwo = rejectingLimit(() => "two");

  await Promise.resolve();
  assert.equal(rejectingLimit.pendingCount, 2);
  const pendingOneRejected = assert.rejects(pendingPromiseOne, {name: "AbortError"});
  const pendingTwoRejected = assert.rejects(pendingPromiseTwo, {name: "AbortError"});
  assert.equal(rejectingLimit.clearQueue(), 2);
  assert.equal(rejectingLimit.pendingCount, 0);
  await runningPromise;
  await pendingOneRejected;
  await pendingTwoRejected;

  const source = fs.readFileSync(path.join(workspaceDir, "index.js"), "utf8");
  assert.match(source, /clearQueue:\s*{/);
  assert.match(source, /return\s+(clearedCount|pendingCount|queueSize|count)/);

  const runtimeTests = fs.readFileSync(path.join(workspaceDir, "test.js"), "utf8");
  assert.match(
    runtimeTests,
    /clearQueue returns pending count|clearQueue returns cleared count|clearQueue returns queue size/i,
    "test.js must name the clearQueue return-count coverage with `clearQueue returns pending count`, `clearQueue returns cleared count`, or `clearQueue returns queue size`.",
  );
  assert.match(
    runtimeTests,
    /t\.is\(\s*limit\.clearQueue\(\),\s*3\s*\)/,
    "test.js must include direct assertion `t.is(limit.clearQueue(), 3)`; storing the clearQueue result in a variable is not enough for this verifier.",
  );
  assert.match(
    runtimeTests,
    /t\.is\(\s*limit\.clearQueue\(\),\s*0\s*\)/,
    "test.js must include direct assertion `t.is(limit.clearQueue(), 0)` after clearing an empty queue.",
  );

  const types = fs.readFileSync(path.join(workspaceDir, "index.d.ts"), "utf8");
  assert.match(
    types,
    /clearQueue:\s*\(\)\s*=>\s*number/,
    "index.d.ts must expose `clearQueue: () => number`.",
  );

  const typeTests = fs.readFileSync(path.join(workspaceDir, "index.test-d.ts"), "utf8");
  assert.match(
    typeTests,
    /expectType<number>\(limit\.clearQueue\(\)\)/,
    "index.test-d.ts must assert `expectType<number>(limit.clearQueue())`.",
  );
  assert.match(
    typeTests,
    /expectType<number>\(limitWithRejectOnClear\.clearQueue\(\)\)/,
    "index.test-d.ts must assert `expectType<number>(limitWithRejectOnClear.clearQueue())`.",
  );

  run("npm", ["test"], {
    env: {
      ...process.env,
      CI: "1",
    },
  });
}

async function expectRejectsWithExactReason(promise, reason, label) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error, reason, label);
    return;
  }

  assert.fail(`${label}: expected promise to reject`);
}

async function verifyPLocateAbortSignal() {
  const pLocateModule = await requireWorkspaceModule("index.js");
  const pLocate = pLocateModule.default;
  assert.equal(typeof pLocate, "function");

  const alreadyAborted = new AbortController();
  const alreadyAbortedReason = new Error("already aborted by verifier");
  alreadyAborted.abort(alreadyAbortedReason);
  let alreadyAbortedTesterCalled = false;
  await expectRejectsWithExactReason(
    pLocate([1, 2, 3], () => {
      alreadyAbortedTesterCalled = true;
      return true;
    }, {signal: alreadyAborted.signal}),
    alreadyAbortedReason,
    "pLocate must reject with signal.reason when the signal is already aborted",
  );
  assert.equal(alreadyAbortedTesterCalled, false, "pLocate must not call tester when signal is already aborted");

  const pendingAbort = new AbortController();
  const pendingAbortReason = new DOMException("pending abort by verifier", "AbortError");
  const pendingPromise = pLocate([1, 2, 3], async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
    return false;
  }, {signal: pendingAbort.signal});
  setTimeout(() => {
    pendingAbort.abort(pendingAbortReason);
  }, 10);
  await expectRejectsWithExactReason(
    pendingPromise,
    pendingAbortReason,
    "pLocate must reject with signal.reason when aborted during pending work",
  );

  const asyncAbort = new AbortController();
  const asyncAbortReason = new Error("async iterable abort by verifier");
  let yielded = 0;
  async function * values() {
    yielded++;
    yield 1;
    await new Promise(resolve => {
      setTimeout(resolve, 50);
    });
    yielded++;
    yield 2;
  }

  const asyncPromise = pLocate(values(), async () => {
    asyncAbort.abort(asyncAbortReason);
    return false;
  }, {signal: asyncAbort.signal});
  await expectRejectsWithExactReason(
    asyncPromise,
    asyncAbortReason,
    "pLocate must reject with signal.reason when an async iterable search is aborted",
  );
  assert.equal(yielded, 1, "pLocate should stop consuming the async iterable after abort");

  const source = fs.readFileSync(path.join(workspaceDir, "index.js"), "utf8");
  assert.match(source, /\bsignal\b/, "index.js must implement signal handling, not only type declarations.");
  assert.match(source, /throwIfAborted|addEventListener\(\s*['"]abort['"]|signal\.aborted/, "index.js must actively observe AbortSignal state.");

  const runtimeTests = fs.readFileSync(path.join(workspaceDir, "test.js"), "utf8");
  assert.match(
    runtimeTests,
    /abort signal|already aborted signal|aborted signal/i,
    "test.js must include verifier-visible AbortSignal coverage.",
  );
  assert.match(
    runtimeTests,
    /AbortController/,
    "test.js must use AbortController in runtime coverage.",
  );

  const types = fs.readFileSync(path.join(workspaceDir, "index.d.ts"), "utf8");
  assert.match(
    types,
    /signal\??:\s*(globalThis\.)?AbortSignal/,
    "index.d.ts must expose `signal?: AbortSignal` in options.",
  );

  const typeTests = fs.readFileSync(path.join(workspaceDir, "index.test-d.ts"), "utf8");
  assert.match(
    typeTests,
    /signal:\s*new AbortController\(\)\.signal|signal:\s*abortController\.signal/,
    "index.test-d.ts must assert pLocate accepts an AbortSignal option.",
  );

  run("npm", ["test"], {
    env: {
      ...process.env,
      CI: "1",
    },
  });
}

async function collectAsyncIterable(iterable) {
  const values = [];
  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}

async function verifyPMapIterableAbortSignal() {
  const pMapModule = await requireWorkspaceModule("index.js");
  const {pMapIterable} = pMapModule;
  assert.equal(typeof pMapIterable, "function");

  const alreadyAborted = new AbortController();
  const alreadyAbortedReason = new Error("already aborted pMapIterable by verifier");
  alreadyAborted.abort(alreadyAbortedReason);
  let alreadyAbortedMapperCalled = false;
  await expectRejectsWithExactReason(
    collectAsyncIterable(pMapIterable([1, 2, 3], value => {
      alreadyAbortedMapperCalled = true;
      return value;
    }, {signal: alreadyAborted.signal})),
    alreadyAbortedReason,
    "pMapIterable must reject with signal.reason when the signal is already aborted",
  );
  assert.equal(alreadyAbortedMapperCalled, false, "pMapIterable must not call mapper when signal is already aborted");

  const pendingAbort = new AbortController();
  const pendingAbortReason = new DOMException("pending pMapIterable abort by verifier", "AbortError");
  let pendingMapperCalls = 0;
  const pendingIterable = pMapIterable([1, 2, 3], async value => {
    pendingMapperCalls++;
    if (value === 1) {
      setTimeout(() => {
        pendingAbort.abort(pendingAbortReason);
      }, 10);
      await new Promise(resolve => {
        setTimeout(resolve, 50);
      });
    }

    return value;
  }, {concurrency: 1, signal: pendingAbort.signal});
  await expectRejectsWithExactReason(
    collectAsyncIterable(pendingIterable),
    pendingAbortReason,
    "pMapIterable must reject with signal.reason when aborted while mapper work is pending",
  );
  assert.equal(pendingMapperCalls, 1, "pMapIterable should not start more mapper work after pending abort");

  const asyncAbort = new AbortController();
  const asyncAbortReason = new Error("async source pMapIterable abort by verifier");
  let yielded = 0;
  let asyncMapperCalls = 0;
  async function * values() {
    yielded++;
    yield 1;
    await new Promise(resolve => {
      setTimeout(resolve, 50);
    });
    yielded++;
    yield 2;
  }

  await expectRejectsWithExactReason(
    collectAsyncIterable(pMapIterable(values(), async value => {
      asyncMapperCalls++;
      asyncAbort.abort(asyncAbortReason);
      return value;
    }, {concurrency: 1, signal: asyncAbort.signal})),
    asyncAbortReason,
    "pMapIterable must reject with signal.reason when an async source is aborted",
  );
  assert.equal(yielded, 1, "pMapIterable should stop consuming an async iterable after abort");
  assert.equal(asyncMapperCalls, 1, "pMapIterable should not keep mapping after abort");

  const source = fs.readFileSync(path.join(workspaceDir, "index.js"), "utf8");
  assert.match(source, /pMapIterable[\s\S]*\bsignal\b/, "index.js must add signal handling to pMapIterable.");
  assert.match(source, /throwIfAborted|addEventListener\(\s*['"]abort['"]|signal\.aborted/, "pMapIterable must actively observe AbortSignal state.");

  const runtimeTests = fs.readFileSync(path.join(workspaceDir, "test.js"), "utf8");
  assert.match(
    runtimeTests,
    /pMapIterable[\s\S]*(abort signal|already aborted signal|aborted signal)|(?:abort signal|already aborted signal|aborted signal)[\s\S]*pMapIterable/i,
    "test.js must include verifier-visible pMapIterable AbortSignal coverage.",
  );
  assert.match(
    runtimeTests,
    /AbortController/,
    "test.js must use AbortController in pMapIterable runtime coverage.",
  );

  const types = fs.readFileSync(path.join(workspaceDir, "index.d.ts"), "utf8");
  assert.match(
    types,
    /type\s+IterableOptions[\s\S]*signal\??:\s*(globalThis\.)?AbortSignal/,
    "index.d.ts must expose `signal?: AbortSignal` in IterableOptions.",
  );

  const typeTests = fs.readFileSync(path.join(workspaceDir, "index.test-d.ts"), "utf8");
  assert.match(
    typeTests,
    /pMapIterable\([\s\S]*signal:\s*new AbortController\(\)\.signal|signal:\s*abortController\.signal[\s\S]*pMapIterable\(/,
    "index.test-d.ts must assert pMapIterable accepts an AbortSignal option.",
  );

  run("npm", ["test"], {
    env: {
      ...process.env,
      CI: "1",
    },
  });
}

async function verifyPTimeoutClearReturnState() {
  const pTimeoutModule = await requireWorkspaceModule("index.js");
  const pTimeout = pTimeoutModule.default;
  const {TimeoutError} = pTimeoutModule;
  assert.equal(typeof pTimeout, "function");
  assert.equal(typeof TimeoutError, "function");

  const clearablePromise = pTimeout(new Promise(resolve => {
    setTimeout(() => {
      resolve("cleared");
    }, 25);
  }), {milliseconds: 1000});
  assert.equal(clearablePromise.clear(), true, "clear() must return true when it clears an active timeout");
  assert.equal(clearablePromise.clear(), false, "clear() must return false after the timeout has already been cleared");
  assert.equal(await clearablePromise, "cleared");

  const completedPromise = pTimeout(Promise.resolve("completed"), {milliseconds: 1000});
  assert.equal(await completedPromise, "completed");
  assert.equal(completedPromise.clear(), false, "clear() must return false after the wrapped promise settles");

  const timedOutPromise = pTimeout(new Promise(() => {}), {milliseconds: 5});
  await assert.rejects(timedOutPromise, {name: "TimeoutError"});
  assert.equal(timedOutPromise.clear(), false, "clear() must return false after timeout rejection");

  const source = fs.readFileSync(path.join(workspaceDir, "index.js"), "utf8");
  assert.match(source, /clear:\s*\(\)\s*=>|clear\s*=\s*\(\)\s*=>|clear\s*=\s*function|clear\(\)\s*{/);
  assert.match(source, /return\s+true/, "index.js must return true when clear() clears an active timer.");
  assert.match(source, /return\s+false/, "index.js must return false when there is no active timer to clear.");

  const runtimeTests = fs.readFileSync(path.join(workspaceDir, "test.js"), "utf8");
  assert.match(
    runtimeTests,
    /clear\(\).*returns|returns.*clear\(\)|clear return|clear state|active timeout/i,
    "test.js must include verifier-visible clear() return-state coverage.",
  );
  assert.match(
    runtimeTests,
    /t\.is\([^)]*\.clear\(\),\s*true\s*\)/s,
    "test.js must directly assert clear() returns true for an active timeout.",
  );
  assert.match(
    runtimeTests,
    /t\.is\([^)]*\.clear\(\),\s*false\s*\)/s,
    "test.js must directly assert clear() returns false when no active timeout remains.",
  );

  const types = fs.readFileSync(path.join(workspaceDir, "index.d.ts"), "utf8");
  assert.match(
    types,
    /clear:\s*\(\)\s*=>\s*boolean/,
    "index.d.ts must expose `clear: () => boolean`.",
  );

  const typeTests = fs.readFileSync(path.join(workspaceDir, "index.test-d.ts"), "utf8");
  assert.match(
    typeTests,
    /expectType<boolean>\([^)]*\.clear\(\)\)/,
    "index.test-d.ts must assert `expectType<boolean>(promise.clear())`.",
  );

  run("npm", ["test"], {
    env: {
      ...process.env,
      CI: "1",
    },
  });
}

async function verifyMarkedPedanticColonStrong() {
  run("npm", ["run", "build:esbuild"], {
    env: {
      ...process.env,
      CI: "1",
    },
  });

  const markedModule = await requireWorkspaceModule("lib/marked.esm.js");
  const marked = markedModule.marked ?? markedModule.default?.marked ?? markedModule.default;
  assert.equal(typeof marked, "function");

  assert.equal(
    marked("**foo:**bar", { pedantic: true }),
    "<p><strong>foo:</strong>bar</p>\n",
    "pedantic mode must parse colon-terminated strong text before an adjacent word.",
  );
  assert.equal(
    marked("before **label:**value after", { pedantic: true }),
    "<p>before <strong>label:</strong>value after</p>\n",
    "pedantic mode must keep following text outside the strong span when no space follows the closing delimiter.",
  );
  assert.equal(
    marked("**foo:**bar"),
    "<p>**foo:**bar</p>\n",
    "default CommonMark/GFM behavior must not be changed by the pedantic compatibility fix.",
  );
  assert.equal(
    marked("**foo:** bar", { pedantic: true }),
    "<p><strong>foo:</strong> bar</p>\n",
    "existing pedantic strong parsing with a space after the delimiter must keep working.",
  );

  const tokenizerSource = fs.readFileSync(path.join(workspaceDir, "src/Tokenizer.ts"), "utf8");
  const rulesSource = fs.readFileSync(path.join(workspaceDir, "src/rules.ts"), "utf8");
  assert.match(
    `${tokenizerSource}\n${rulesSource}`,
    /pedantic|inlinePedantic|this\.options\.pedantic/,
    "the fix must be scoped to Marked's pedantic parsing path rather than weakening default CommonMark delimiter rules.",
  );
  assert.match(
    `${tokenizerSource}\n${rulesSource}`,
    /emStrong|emStrongRDelimAst|emStrongLDelim/,
    "the fix must touch Marked's emphasis/strong delimiter handling rather than post-processing rendered HTML.",
  );

  const unitTests = fs.readFileSync(path.join(workspaceDir, "test/unit/marked.test.js"), "utf8");
  assert.match(
    unitTests,
    /pedantic[\s\S]{0,220}(colon|:)[\s\S]{0,220}(strong|bold)|(?:colon|:)[\s\S]{0,220}(strong|bold)[\s\S]{0,220}pedantic/i,
    "test/unit/marked.test.js must include verifier-visible coverage for pedantic colon-terminated strong text.",
  );
  assert.match(
    unitTests,
    /\*\*foo:\*\*bar|label:\*\*value|\*\*label:\*\*value/,
    "the Marked unit test must cover an adjacent word after `**foo:**bar` style input.",
  );

  run("node", ["--test", "--test-reporter=spec", "test/unit/marked.test.js"], {
    env: {
      ...process.env,
      CI: "1",
    },
    timeout: 120000,
  });
}

if (taskId === "commander-short-option-suggestions") {
  await verifyCommanderShortOptionSuggestions();
} else if (taskId === "axios-set-cookie-to-string") {
  await verifyAxiosSetCookieToString();
} else if (taskId === "picomatch-array-return-object") {
  await verifyPicomatchArrayReturnObject();
} else if (taskId === "yargs-parser-array-narg-zero") {
  await verifyYargsParserArrayNargZero();
} else if (taskId === "got-upload-progress-json-form-issue-2435") {
  await verifyGotUploadProgressJsonFormIssue();
} else if (taskId === "p-limit-clear-queue-return-count") {
  await verifyPLimitClearQueueReturnCount();
} else if (taskId === "p-locate-abort-signal") {
  await verifyPLocateAbortSignal();
} else if (taskId === "p-map-iterable-abort-signal") {
  await verifyPMapIterableAbortSignal();
} else if (taskId === "p-timeout-clear-return-state") {
  await verifyPTimeoutClearReturnState();
} else if (taskId === "marked-pedantic-colon-strong") {
  await verifyMarkedPedanticColonStrong();
} else {
  throw new Error(`unknown GitHub real project verifier task: ${taskId ?? ""}`);
}
