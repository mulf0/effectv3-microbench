import { createServer, request as httpRequest, Agent } from "node:http"
import { fork } from "node:child_process"
import { createServer as createNetServer, connect as netConnect } from "node:net"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"
import { mkdirSync } from "node:fs"
import { resolve as resolvePath } from "node:path"

import * as Effect from "effect/Effect"
import * as Runtime from "effect/Runtime"
import * as Layer from "effect/Layer"

import * as HttpLayerRouter from "@effect/platform/HttpLayerRouter"
import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServer from "@effect/platform/HttpServer"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"

const DEFAULTS = {
  host: "127.0.0.1",
  requests: 100_000,
  warmup: 10_000,
  concurrency: 100,
  rounds: 5,
  randomize: true,
  cpuProf: false,
  cpuProfDir: "./profiles",

  runMicro: true,
  runHttp: true,

  microWarmup: 5_000,
  microIterations: 100_000,
  microRounds: 5,

  handlerWarmup: 2_000,
  handlerIterations: 10_000,
  handlerRounds: 7,
}

const GROUPS = {
  core: ["native-empty", "bridge-empty", "effect-direct-empty"],
  responses: ["native-static", "bridge-static", "effect-direct-text", "effect-direct-uint8", "effect-direct-raw"],
  requests: ["effect-direct-raw", "effect-request-only", "effect-request-url", "effect-request-source"],
  routers: ["effect-direct-text", "effect-http-router-static", "effect-layer-router-static"],
  dynamic: ["native-dynamic", "bridge-dynamic", "effect-direct-dynamic", "effect-http-router-dynamic", "effect-layer-router-dynamic"],
  profile: ["bridge-empty", "effect-direct-empty", "effect-http-router-static", "effect-layer-router-static"],
}

const ALL_MODES = [...new Set(Object.values(GROUPS).flat())]
const THIS_FILE = fileURLToPath(import.meta.url)
const runtime = Runtime.defaultRuntime
const runPromise = Runtime.runPromise(runtime)

const STATIC_BODY = '{"ok":true,"message":"hello"}'
const STATIC_BYTES = Buffer.from(STATIC_BODY)
const STATIC_LENGTH = STATIC_BYTES.byteLength
const JSON_CONTENT_TYPE = "application/json"

const EFFECT_TEXT_RESPONSE = HttpServerResponse.text(STATIC_BODY, { contentType: JSON_CONTENT_TYPE })
const EFFECT_UINT8_RESPONSE = HttpServerResponse.uint8Array(STATIC_BYTES, { contentType: JSON_CONTENT_TYPE })
const EFFECT_RAW_RESPONSE = HttpServerResponse.raw(STATIC_BODY, {
  contentType: JSON_CONTENT_TYPE,
  contentLength: STATIC_LENGTH,
})
const EFFECT_EMPTY_RESPONSE = HttpServerResponse.empty({ status: 204 })

function printHelp() {
  console.log(`
Effect v3 Node HTTP benchmark

Usage:
  node effect-http-bench.mjs [options]

Matrix selection:
  --group <name>          Repeatable. Groups: all, core, responses, requests,
                          routers, dynamic, profile
  --modes <a,b,c>         Exact comma-separated modes; overrides --group
  --list                  List groups and modes

Load configuration:
  --requests <n>          Measured requests per mode/round (default ${DEFAULTS.requests})
  --warmup <n>            Discarded warmup requests (default ${DEFAULTS.warmup})
  --concurrency <n>       Concurrent requests (default ${DEFAULTS.concurrency})
  --rounds <n>            Measured rounds (default ${DEFAULTS.rounds})
  --no-randomize          Keep matrix order fixed

Execution:
  --http-only             Skip microbenchmarks and run only the HTTP matrix
  --micro-only            Skip HTTP and run only microbenchmarks
  --no-randomize          Keep matrix order fixed

Microbenchmarks:
  --micro-warmup <n>      Warmup iterations (default ${DEFAULTS.microWarmup})
  --micro-iterations <n>  Measured iterations/round (default ${DEFAULTS.microIterations})
  --micro-rounds <n>      Microbenchmark rounds (default ${DEFAULTS.microRounds})
  --handler-warmup <n>    Handler warmup iterations (default ${DEFAULTS.handlerWarmup})
  --handler-iterations <n> Handler iterations/round (default ${DEFAULTS.handlerIterations})
  --handler-rounds <n>    Handler rounds (default ${DEFAULTS.handlerRounds})

Profiling:
  --cpu-prof              Profile SERVER child processes only
  --cpu-prof-dir <path>   Profile output dir (default ${DEFAULTS.cpuProfDir})

Examples:
  node effect-http-bench.mjs --group all
  node effect-http-bench.mjs --group routers --requests 200000 --rounds 7
  node effect-http-bench.mjs --modes bridge-empty,effect-direct-empty
  node effect-http-bench.mjs --group profile --cpu-prof --requests 500000 --warmup 20000 --rounds 3

Install:
  npm i effect@3.22.2 @effect/platform@0.97.2 @effect/platform-node@0.108.2
`)
}

function positiveInt(raw, flag) {
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer, got ${raw}`)
  return n
}

function parseCli(argv) {
  const c = { ...DEFAULTS, groups: [], modes: null, list: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0) }
    else if (arg === "--list") c.list = true
    else if (arg === "--group") c.groups.push(argv[++i] ?? "")
    else if (arg === "--modes") c.modes = (argv[++i] ?? "").split(",").map(x => x.trim()).filter(Boolean)
    else if (arg === "--requests") c.requests = positiveInt(argv[++i], arg)
    else if (arg === "--warmup") c.warmup = positiveInt(argv[++i], arg)
    else if (arg === "--concurrency") c.concurrency = positiveInt(argv[++i], arg)
    else if (arg === "--rounds") c.rounds = positiveInt(argv[++i], arg)
    else if (arg === "--http-only") { c.runMicro = false; c.runHttp = true }
    else if (arg === "--micro-only") { c.runMicro = true; c.runHttp = false }
    else if (arg === "--micro-warmup") c.microWarmup = positiveInt(argv[++i], arg)
    else if (arg === "--micro-iterations") c.microIterations = positiveInt(argv[++i], arg)
    else if (arg === "--micro-rounds") c.microRounds = positiveInt(argv[++i], arg)
    else if (arg === "--handler-warmup") c.handlerWarmup = positiveInt(argv[++i], arg)
    else if (arg === "--handler-iterations") c.handlerIterations = positiveInt(argv[++i], arg)
    else if (arg === "--handler-rounds") c.handlerRounds = positiveInt(argv[++i], arg)
    else if (arg === "--no-randomize") c.randomize = false
    else if (arg === "--cpu-prof") c.cpuProf = true
    else if (arg === "--cpu-prof-dir") c.cpuProfDir = argv[++i] ?? ""
    else throw new Error(`Unknown option: ${arg}`)
  }
  return c
}

function listMatrix() {
  console.log("Groups:\n")
  for (const [name, modes] of [["all", ALL_MODES], ...Object.entries(GROUPS)]) {
    console.log(`${name}\n  ${modes.join("\n  ")}\n`)
  }
}

function selectModes(config) {
  if (config.modes) {
    const bad = config.modes.filter(m => !ALL_MODES.includes(m))
    if (bad.length) throw new Error(`Unknown mode(s): ${bad.join(", ")}. Use --list.`)
    return [...new Set(config.modes)]
  }
  const groups = config.groups.length ? config.groups : ["all"]
  const bad = groups.filter(g => g !== "all" && !(g in GROUPS))
  if (bad.length) throw new Error(`Unknown group(s): ${bad.join(", ")}. Use --list.`)
  return [...new Set(groups.flatMap(g => g === "all" ? ALL_MODES : GROUPS[g]))]
}

function section(title) {
  console.log(`\n${"─".repeat(92)}\n ${title}\n${"─".repeat(92)}`)
}

const isTTY = Boolean(process.stdout.isTTY)
function progress(label, current, total) {
  if (!isTTY) return current === total && console.log(`${label}: ${current}/${total}`)
  const width = 30
  const filled = Math.round((current / total) * width)
  const pct = ((current / total) * 100).toFixed(0)
  process.stdout.write(`\r${label.padEnd(27)} [${"=".repeat(filled)}${" ".repeat(width - filled)}] ${pct.padStart(3)}%`)
  if (current === total) process.stdout.write("\n")
}

function median(values) {
  const s = [...values].sort((a, b) => a - b)
  const i = Math.floor(s.length / 2)
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2
}
function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length }
function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}
function stddev(values) {
  const avg = mean(values)
  return Math.sqrt(values.reduce((sum, n) => sum + (n - avg) ** 2, 0) / values.length)
}
function delta(a, b) { return ((b - a) / a) * 100 }
function shuffled(values) {
  const out = [...values]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ============================================================================
// Restored original microbenchmarks
// ============================================================================

function externalPromise(value) {
  return Promise.resolve(value)
}

async function nativeInteropHandler(id) {
  const user = await externalPromise({ id, name: `user-${id}` })
  const permissions = await externalPromise(["read", "write"])
  return JSON.stringify({ id: user.id, name: user.name, permissions })
}

function effectInteropHandler(id) {
  return Effect.gen(function* () {
    const user = yield* Effect.promise(() =>
      externalPromise({ id, name: `user-${id}` })
    )
    const permissions = yield* Effect.promise(() =>
      externalPromise(["read", "write"])
    )
    return JSON.stringify({ id: user.id, name: user.name, permissions })
  })
}

function nativePureHandler(id) {
  return dynamicBody(id)
}

function effectPureHandler(id) {
  return Effect.sync(() => dynamicBody(id))
}

const MAP_COUNT = 100
let mappedEffect = Effect.succeed(0)
for (let i = 0; i < MAP_COUNT; i++) {
  mappedEffect = Effect.map(mappedEffect, n => n + 1)
}

function nativeMapWork() {
  let n = 0
  for (let i = 0; i < MAP_COUNT; i++) n += 1
  return n
}

async function runSyncBenchmark({ name, fn, warmup, iterations, rounds }) {
  for (let i = 0; i < warmup; i++) fn()
  const samples = []
  for (let round = 0; round < rounds; round++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) fn()
    const elapsed = performance.now() - start
    samples.push({
      opsPerSecond: iterations / (elapsed / 1000),
      nsPerOp: (elapsed * 1_000_000) / iterations,
    })
    progress(name, round + 1, rounds)
  }
  return summarizeMicroBenchmark(name, samples)
}

async function runAsyncBenchmark({ name, fn, warmup, iterations, rounds }) {
  for (let i = 0; i < warmup; i++) await fn(i)
  const samples = []
  for (let round = 0; round < rounds; round++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) await fn(i)
    const elapsed = performance.now() - start
    samples.push({
      opsPerSecond: iterations / (elapsed / 1000),
      nsPerOp: (elapsed * 1_000_000) / iterations,
    })
    progress(name, round + 1, rounds)
  }
  return summarizeMicroBenchmark(name, samples)
}

function summarizeMicroBenchmark(name, samples) {
  const ops = samples.map(x => x.opsPerSecond)
  const ns = samples.map(x => x.nsPerOp)
  return {
    name,
    "median ops/sec": Math.round(median(ops)),
    "median ns/op": Math.round(median(ns)),
    "min ns/op": Math.round(Math.min(...ns)),
    "max ns/op": Math.round(Math.max(...ns)),
    "σ ns/op": Math.round(stddev(ns)),
  }
}

async function runMicroSuite(config) {
  section("1. Runtime Boundary")
  console.log("  Measures Promise/runtime entry cost, not application throughput.")

  const promiseResolve = await runAsyncBenchmark({
    name: "Promise.resolve",
    fn: () => Promise.resolve(42),
    warmup: config.microWarmup,
    iterations: config.microIterations,
    rounds: config.microRounds,
  })

  const effectRunPromise = await runAsyncBenchmark({
    name: "Effect.runPromise",
    fn: () => runPromise(Effect.succeed(42)),
    warmup: config.microWarmup,
    iterations: config.microIterations,
    rounds: config.microRounds,
  })

  console.table([promiseResolve, effectRunPromise])

  section("2. Composition / Interpreter Cost")
  console.log("  Exposes interpreter/composition cost; the JS loop is not equivalent semantics.")

  const nativeMap = await runSyncBenchmark({
    name: "JS loop x100",
    fn: nativeMapWork,
    warmup: config.microWarmup,
    iterations: config.microIterations,
    rounds: config.microRounds,
  })

  const effectMap = await runSyncBenchmark({
    name: "Effect.map x100",
    fn: () => Effect.runSync(mappedEffect),
    warmup: config.microWarmup,
    iterations: config.microIterations,
    rounds: config.microRounds,
  })

  console.table([nativeMap, effectMap])

  section("3. Existing Promise API Interop")
  console.log("  Both variants call the same Promise-returning API twice.")

  const nativeInterop = await runAsyncBenchmark({
    name: "native Promise interop",
    fn: nativeInteropHandler,
    warmup: config.handlerWarmup,
    iterations: config.handlerIterations,
    rounds: config.handlerRounds,
  })

  const effectInterop = await runAsyncBenchmark({
    name: "Effect.promise interop",
    fn: id => runPromise(effectInteropHandler(id)),
    warmup: config.handlerWarmup,
    iterations: config.handlerIterations,
    rounds: config.handlerRounds,
  })

  console.table([nativeInterop, effectInterop])

  section("4. Pure Handler Boundary")
  console.log("  No Promise->Effect conversion and no intentionally fragmented Effect program.")

  const nativePure = await runSyncBenchmark({
    name: "native pure handler",
    fn: () => nativePureHandler(42),
    warmup: config.handlerWarmup,
    iterations: config.handlerIterations,
    rounds: config.handlerRounds,
  })

  const effectPure = await runAsyncBenchmark({
    name: "Effect pure handler",
    fn: id => runPromise(effectPureHandler(id)),
    warmup: config.handlerWarmup,
    iterations: config.handlerIterations,
    rounds: config.handlerRounds,
  })

  console.table([nativePure, effectPure])
}

function parseId(url, host) {
  return Number(new URL(url, `http://${host}`).searchParams.get("id") ?? 0)
}
function dynamicBody(id) {
  return JSON.stringify({ id, name: `user-${id}`, permissions: ["read", "write"] })
}
function writeNativeText(res, body = STATIC_BODY) {
  res.writeHead(200, { "content-type": JSON_CONTENT_TYPE, "content-length": Buffer.byteLength(body) })
  res.end(body)
}
function writeNativeEmpty(res) { res.writeHead(204); res.end() }
function listen(server, port, host) {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve) })
}

async function startNativeEmpty(port, host) {
  const server = createServer((_req, res) => writeNativeEmpty(res)); await listen(server, port, host); return server
}
async function startNativeStatic(port, host) {
  const server = createServer((_req, res) => writeNativeText(res)); await listen(server, port, host); return server
}
async function startNativeDynamic(port, host) {
  const server = createServer((req, res) => writeNativeText(res, dynamicBody(parseId(req.url, host))))
  await listen(server, port, host); return server
}
async function startBridgeEmpty(port, host) {
  const program = Effect.succeed(null)
  const server = createServer((_req, res) => runPromise(program).then(() => writeNativeEmpty(res), e => { res.statusCode = 500; res.end(String(e)) }))
  await listen(server, port, host); return server
}
async function startBridgeStatic(port, host) {
  const program = Effect.succeed(STATIC_BODY)
  const server = createServer((_req, res) => runPromise(program).then(body => writeNativeText(res, body), e => { res.statusCode = 500; res.end(String(e)) }))
  await listen(server, port, host); return server
}
async function startBridgeDynamic(port, host) {
  const server = createServer((req, res) => {
    const id = parseId(req.url, host)
    runPromise(Effect.sync(() => dynamicBody(id))).then(body => writeNativeText(res, body), e => { res.statusCode = 500; res.end(String(e)) })
  })
  await listen(server, port, host); return server
}

function launchDirectEffectServer(port, host, app) {
  HttpServer.serve(app).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
    Layer.launch,
    NodeRuntime.runMain,
  )
}
function startEffectDirectEmpty(port, host) { launchDirectEffectServer(port, host, Effect.succeed(EFFECT_EMPTY_RESPONSE)) }
function startEffectDirectText(port, host) { launchDirectEffectServer(port, host, Effect.succeed(EFFECT_TEXT_RESPONSE)) }
function startEffectDirectUint8(port, host) { launchDirectEffectServer(port, host, Effect.succeed(EFFECT_UINT8_RESPONSE)) }
function startEffectDirectRaw(port, host) { launchDirectEffectServer(port, host, Effect.succeed(EFFECT_RAW_RESPONSE)) }
function startEffectRequestOnly(port, host) {
  launchDirectEffectServer(port, host, Effect.gen(function* () { yield* HttpServerRequest.HttpServerRequest; return EFFECT_RAW_RESPONSE }))
}
function startEffectRequestUrl(port, host) {
  launchDirectEffectServer(port, host, Effect.gen(function* () { const r = yield* HttpServerRequest.HttpServerRequest; void r.url; return EFFECT_RAW_RESPONSE }))
}
function startEffectRequestSource(port, host) {
  launchDirectEffectServer(port, host, Effect.gen(function* () {
    const r = yield* HttpServerRequest.HttpServerRequest
    const source = r.source
    if (source && typeof source === "object" && "url" in source) void source.url
    return EFFECT_RAW_RESPONSE
  }))
}
function startEffectDirectDynamic(port, host) {
  launchDirectEffectServer(port, host, Effect.gen(function* () {
    const r = yield* HttpServerRequest.HttpServerRequest
    return HttpServerResponse.text(dynamicBody(parseId(r.url, host)), { contentType: JSON_CONTENT_TYPE })
  }))
}

// Plain HttpRouter path: HttpRouter.empty -> HttpRouter.get -> HttpServer.serve.
function startEffectHttpRouterStatic(port, host) {
  const app = HttpRouter.empty.pipe(HttpRouter.get("/user", EFFECT_TEXT_RESPONSE))
  launchDirectEffectServer(port, host, app)
}
function startEffectHttpRouterDynamic(port, host) {
  const app = HttpRouter.empty.pipe(HttpRouter.get("/user", Effect.gen(function* () {
    const r = yield* HttpServerRequest.HttpServerRequest
    return HttpServerResponse.text(dynamicBody(parseId(r.url, host)), { contentType: JSON_CONTENT_TYPE })
  })))
  launchDirectEffectServer(port, host, app)
}

function startEffectLayerRouterStatic(port, host) {
  const route = HttpLayerRouter.add("GET", "/user", EFFECT_TEXT_RESPONSE)
  HttpLayerRouter.serve(route, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { host, port })), Layer.launch, NodeRuntime.runMain,
  )
}
function startEffectLayerRouterDynamic(port, host) {
  const route = HttpLayerRouter.add("GET", "/user", request =>
    HttpServerResponse.text(dynamicBody(parseId(request.url, host)), { contentType: JSON_CONTENT_TYPE })
  )
  HttpLayerRouter.serve(route, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { host, port })), Layer.launch, NodeRuntime.runMain,
  )
}

async function getFreePort(host) {
  const server = createNetServer()
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function waitForPort(port, host, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const ok = await new Promise(resolve => {
      const socket = netConnect({ host, port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => { socket.destroy(); resolve(false) })
    })
    if (ok) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Server ${host}:${port} did not become ready`)
}
function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    const onMessage = msg => { if (msg?.type !== type) return; cleanup(); resolve(msg) }
    const onExit = code => { cleanup(); reject(new Error(`Child exited before ${type} (code ${code})`)) }
    function cleanup() { child.off("message", onMessage); child.off("exit", onExit) }
    child.on("message", onMessage); child.on("exit", onExit)
  })
}
async function stopChild(child) {
  if (child.exitCode !== null) return
  const exited = new Promise(resolve => child.once("exit", resolve))
  child.kill("SIGTERM")
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2_000))])
  if (child.exitCode === null) child.kill("SIGKILL")
}

async function serverRole(mode, port, host) {
  try {
    let effect = false
    switch (mode) {
      case "native-empty": await startNativeEmpty(port, host); break
      case "bridge-empty": await startBridgeEmpty(port, host); break
      case "effect-direct-empty": startEffectDirectEmpty(port, host); effect = true; break
      case "native-static": await startNativeStatic(port, host); break
      case "bridge-static": await startBridgeStatic(port, host); break
      case "effect-direct-text": startEffectDirectText(port, host); effect = true; break
      case "effect-direct-uint8": startEffectDirectUint8(port, host); effect = true; break
      case "effect-direct-raw": startEffectDirectRaw(port, host); effect = true; break
      case "effect-request-only": startEffectRequestOnly(port, host); effect = true; break
      case "effect-request-url": startEffectRequestUrl(port, host); effect = true; break
      case "effect-request-source": startEffectRequestSource(port, host); effect = true; break
      case "effect-http-router-static": startEffectHttpRouterStatic(port, host); effect = true; break
      case "effect-layer-router-static": startEffectLayerRouterStatic(port, host); effect = true; break
      case "native-dynamic": await startNativeDynamic(port, host); break
      case "bridge-dynamic": await startBridgeDynamic(port, host); break
      case "effect-direct-dynamic": startEffectDirectDynamic(port, host); effect = true; break
      case "effect-http-router-dynamic": startEffectHttpRouterDynamic(port, host); effect = true; break
      case "effect-layer-router-dynamic": startEffectLayerRouterDynamic(port, host); effect = true; break
      default: throw new Error(`Unknown server mode: ${mode}`)
    }
    if (effect) await waitForPort(port, host)
    process.send?.({ type: "ready", mode, port })
  } catch (error) {
    process.send?.({ type: "server-error", error: String(error?.stack ?? error) })
    process.exit(1)
  }
}

function singleRequest({ port, host, id, agent, recordHeaders = false }) {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    const req = httpRequest({ host, port, path: `/user?id=${id}`, method: "GET", agent }, res => {
      let bytes = 0
      res.on("data", chunk => { bytes += chunk.length })
      res.on("end", () => {
        if (res.statusCode !== 200 && res.statusCode !== 204) return reject(new Error(`HTTP ${res.statusCode}`))
        resolve({ latencyMs: performance.now() - start, bytes, status: res.statusCode, headers: recordHeaders ? res.headers : undefined })
      })
    })
    req.once("error", reject); req.end()
  })
}
async function probeServer(port, host) {
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })
  try { return await singleRequest({ port, host, id: 1, agent, recordHeaders: true }) }
  finally { agent.destroy() }
}
async function runLoad({ port, host, total, concurrency }) {
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency, maxFreeSockets: concurrency })
  let next = 0
  const latencies = new Float64Array(total)
  const started = performance.now()
  async function worker() {
    while (true) {
      const id = next++
      if (id >= total) return
      const result = await singleRequest({ port, host, id, agent })
      latencies[id] = result.latencyMs
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const elapsedMs = performance.now() - started
  agent.destroy()
  const values = Array.from(latencies)
  return {
    elapsedMs,
    requestsPerSecond: total / (elapsedMs / 1000),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  }
}
async function loadRole(port, host, total, concurrency) {
  try {
    const result = await runLoad({ port, host, total, concurrency })
    process.send?.({ type: "result", result })
    setImmediate(() => process.exit(0))
  } catch (error) {
    process.send?.({ type: "load-error", error: String(error?.stack ?? error) })
    process.exit(1)
  }
}

function cleanExecArgv() {
  return process.execArgv.filter(arg => !arg.startsWith("--cpu-prof") && !arg.startsWith("--heap-prof"))
}
async function startServerProcess(mode, port, config) {
  const execArgv = cleanExecArgv()
  if (config.cpuProf) {
    const dir = resolvePath(config.cpuProfDir)
    mkdirSync(dir, { recursive: true })
    execArgv.push("--cpu-prof", `--cpu-prof-dir=${dir}`)
  }
  const child = fork(THIS_FILE, ["server", mode, String(port), config.host], {
    stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv,
  })
  await Promise.race([
    waitForMessage(child, "ready"),
    waitForMessage(child, "server-error").then(msg => { throw new Error(msg.error) }),
  ])
  return child
}
async function runLoadProcess({ port, config, total }) {
  const child = fork(THIS_FILE, ["load", String(port), config.host, String(total), String(config.concurrency)], {
    stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: cleanExecArgv(),
  })
  const msg = await Promise.race([
    waitForMessage(child, "result"),
    waitForMessage(child, "load-error").then(x => { throw new Error(x.error) }),
  ])
  return msg.result
}
async function benchmarkMode(mode, config) {
  const port = await getFreePort(config.host)
  const server = await startServerProcess(mode, port, config)
  try {
    const probe = await probeServer(port, config.host)
    await runLoadProcess({ port, config, total: config.warmup })
    const measured = await runLoadProcess({ port, config, total: config.requests })
    return {
      ...measured,
      probe: {
        status: probe.status,
        contentLength: probe.headers["content-length"],
        transferEncoding: probe.headers["transfer-encoding"],
        contentType: probe.headers["content-type"],
        connection: probe.headers["connection"],
        keepAlive: probe.headers["keep-alive"],
      },
    }
  } finally { await stopChild(server) }
}

function summarize(mode, rounds) {
  const rps = rounds.map(x => x.requestsPerSecond)
  return {
    name: mode,
    "median req/s": Math.round(median(rps)),
    "min req/s": Math.round(Math.min(...rps)),
    "max req/s": Math.round(Math.max(...rps)),
    "σ req/s": Math.round(stddev(rps)),
    "p50 ms": median(rounds.map(x => x.p50)).toFixed(3),
    "p95 ms": median(rounds.map(x => x.p95)).toFixed(3),
    "p99 ms": median(rounds.map(x => x.p99)).toFixed(3),
  }
}
function medianRps(results, mode) {
  return results[mode]?.length ? median(results[mode].map(x => x.requestsPerSecond)) : null
}
function showDelta(label, results, baselineMode, candidateMode) {
  const a = medianRps(results, baselineMode)
  const b = medianRps(results, candidateMode)
  if (a == null || b == null) return
  const d = delta(a, b)
  console.log(`${label.padEnd(49)}${d >= 0 ? "+" : ""}${d.toFixed(2)}%`)
}
function printDecompositions(results) {
  const pairs = [
    ["runtime boundary (empty):", "native-empty", "bridge-empty"],
    ["NodeHttpServer adapter (empty):", "bridge-empty", "effect-direct-empty"],
    ["runtime boundary (static):", "native-static", "bridge-static"],
    ["bridge -> Effect.text:", "bridge-static", "effect-direct-text"],
    ["Effect.text -> uint8:", "effect-direct-text", "effect-direct-uint8"],
    ["Effect.text -> raw:", "effect-direct-text", "effect-direct-raw"],
    ["request service lookup:", "effect-direct-raw", "effect-request-only"],
    ["request.url accessor:", "effect-request-only", "effect-request-url"],
    ["source.url accessor:", "effect-request-only", "effect-request-source"],
    ["plain HttpRouter overhead:", "effect-direct-text", "effect-http-router-static"],
    ["HttpLayerRouter vs plain HttpRouter:", "effect-http-router-static", "effect-layer-router-static"],
    ["full HttpLayerRouter vs direct:", "effect-direct-text", "effect-layer-router-static"],
    ["runtime boundary (dynamic):", "native-dynamic", "bridge-dynamic"],
    ["bridge -> direct Effect dynamic:", "bridge-dynamic", "effect-direct-dynamic"],
    ["plain HttpRouter dynamic:", "effect-direct-dynamic", "effect-http-router-dynamic"],
    ["HttpLayerRouter vs HttpRouter dynamic:", "effect-http-router-dynamic", "effect-layer-router-dynamic"],
  ]
  for (const [label, a, b] of pairs) showDelta(label, results, a, b)
}

async function main() {
  const config = parseCli(process.argv.slice(2))

  if (config.list) {
    listMatrix()
    return
  }

  const modes = selectModes(config)

  section("Effect v3 Performance Benchmark")

  console.log(`Node:              ${process.version}`)
  console.log(`Platform:          ${process.platform} ${process.arch}`)
  console.log(`Microbenchmarks:   ${config.runMicro ? "yes" : "no"}`)
  console.log(`HTTP matrix:       ${config.runHttp ? "yes" : "no"}`)

  if (config.runMicro) {
    console.log(`Micro iterations:  ${config.microIterations.toLocaleString()}`)
    console.log(`Micro rounds:      ${config.microRounds}`)
    console.log(`Handler iterations:${config.handlerIterations.toLocaleString()}`)
    console.log(`Handler rounds:    ${config.handlerRounds}`)
  }

  if (config.runHttp) {
    console.log(`Requests/round:    ${config.requests.toLocaleString()}`)
    console.log(`Warmup/round:      ${config.warmup.toLocaleString()}`)
    console.log(`Concurrency:       ${config.concurrency}`)
    console.log(`HTTP rounds:       ${config.rounds}`)
    console.log(`Randomized:        ${config.randomize ? "yes" : "no"}`)
    console.log(
      `CPU profiling:     ${
        config.cpuProf
          ? `yes -> ${resolvePath(config.cpuProfDir)}`
          : "no"
      }`
    )
    console.log(`Modes (${modes.length}):       ${modes.join(", ")}`)
  }

  if (config.runMicro) {
    await runMicroSuite(config)
  }

  if (!config.runHttp) {
    section("Done")
    return
  }

  section("5. HTTP Stack Matrix")

  const results =
    Object.fromEntries(
      modes.map(
        (mode) => [
          mode,
          [],
        ]
      )
    )

  const totalRuns =
    modes.length *
    config.rounds

  let completed = 0

  for (
    let round = 0;
    round < config.rounds;
    round++
  ) {
    const order =
      config.randomize
        ? shuffled(modes)
        : [...modes]

    console.log(
      `\nRound ${round + 1}/${config.rounds}`
    )

    console.log(
      `  ${order.join(" -> ")}`
    )

    for (
      const mode of order
    ) {
      const result =
        await benchmarkMode(
          mode,
          config
        )

      results[mode].push(
        result
      )

      completed++

      progress(
        "HTTP matrix",
        completed,
        totalRuns
      )

      console.log(
        `  ${mode.padEnd(31)} ` +
          `${Math.round(
            result.requestsPerSecond
          ).toLocaleString()} req/s | ` +
          `p95 ${result.p95.toFixed(3)} ms`
      )
    }
  }

  section("6. HTTP Summary")

  console.table(
    modes.map(
      (mode) =>
        summarize(
          mode,
          results[mode]
        )
    )
  )

  section("7. Wire Response Probe")

  console.table(
    modes.map(
      (mode) => {
        const p =
          results[mode][0]
            .probe

        return {
          mode,

          status:
            p.status,

          "content-length":
            p.contentLength ??
            "-",

          "transfer-encoding":
            p.transferEncoding ??
            "-",

          "content-type":
            p.contentType ??
            "-",

          connection:
            p.connection ??
            "-",

          "keep-alive":
            p.keepAlive ??
            "-",
        }
      }
    )
  )

  section("8. Available Decompositions")

  printDecompositions(
    results
  )

  if (config.cpuProf) {
    section("9. CPU Profiles")

    console.log(
      `Server-only .cpuprofile files: ${resolvePath(config.cpuProfDir)}`
    )

    console.log(
      "Suggested focused run:"
    )

    console.log(
      "  node effect-v3-bench.mjs --http-only --group profile --cpu-prof --requests 500000 --warmup 20000 --rounds 3"
    )
  }

  section("Done")
}
const [, , role, ...args] = process.argv
if (role === "server") {
  const [mode, rawPort, host] = args
  await serverRole(mode, Number(rawPort), host)
} else if (role === "load") {
  const [rawPort, host, rawTotal, rawConcurrency] = args
  await loadRole(Number(rawPort), host, Number(rawTotal), Number(rawConcurrency))
} else {
  try { await main() }
  catch (error) { console.error(error?.stack ?? String(error)); process.exitCode = 1 }
}
