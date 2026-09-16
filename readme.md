# Effect v3 Benchmark Suite

## Install

```bash
pnpm add effect@3.22.2 @effect/platform@0.97.2 @effect/platform-node@0.108.2
```

## Run full suite

```bash
node effect-bench.mjs
```

## Run microbenchmarks only

```bash
node effect-bench.mjs --micro-only
```

## Run HTTP benchmarks only

```bash
node effect-bench.mjs --http-only
```

## List groups and modes

```bash
node effect-bench.mjs --list
```

## Matrix groups

Run the full HTTP matrix:

```bash
node effect-bench.mjs --group all
```

Run only the core adapter/runtime tests:

```bash
node effect-bench.mjs --group core
```

Run only response representation tests:

```bash
node effect-bench.mjs --group responses
```

Run only request abstraction tests:

```bash
node effect-bench.mjs --group requests
```

Run only router tests:

```bash
node effect-bench.mjs --group routers
```

Run only dynamic handler tests:

```bash
node effect-bench.mjs --group dynamic
```

Run the focused CPU profiling group:

```bash
node effect-bench.mjs --group profile
```

## Multiple groups

You can combine groups:

```bash
node effect-bench.mjs \
  --group core \
  --group routers
```

## Exact modes

Use `--modes` to run an exact comma-separated list of modes. This overrides `--group`.

```bash
node effect-bench.mjs \
  --modes bridge-empty,effect-direct-empty
```

## HTTP options

`--requests <n>` sets the number of measured requests per mode per round. Default: 100000.

`--warmup <n>` sets the number of discarded HTTP warmup requests. Default: 10000.

`--concurrency <n>` sets concurrent HTTP requests. Default: 100.

`--rounds <n>` sets the number of measured HTTP rounds. Default: 5.

`--no-randomize` keeps matrix order fixed instead of shuffling modes each round.

Example:

```bash
node effect-bench.mjs \
  --http-only \
  --group routers \
  --requests 200000 \
  --warmup 20000 \
  --concurrency 100 \
  --rounds 7
```

## Microbenchmark options

`--micro-warmup <n>` sets warmup iterations for runtime and composition tests. Default: 5000.

`--micro-iterations <n>` sets measured iterations per microbenchmark round. Default: 100000.

`--micro-rounds <n>` sets the number of microbenchmark rounds. Default: 5.

`--handler-warmup <n>` sets warmup iterations for handler and interop tests. Default: 2000.

`--handler-iterations <n>` sets measured handler iterations per round. Default: 10000.

`--handler-rounds <n>` sets the number of handler and interop rounds. Default: 7.

Example:

```bash
node effect-bench.mjs \
  --micro-only \
  --micro-iterations 200000 \
  --micro-rounds 7 \
  --handler-iterations 50000 \
  --handler-rounds 7
```

## CPU profiling

Use `--cpu-prof` to enable CPU profiling for server child processes. Load-generator processes are not profiled.

```bash
node effect-bench.mjs \
  --http-only \
  --group profile \
  --cpu-prof
```

Use `--cpu-prof-dir <path>` to choose the profile output directory. Default: `./profiles`.

```bash
node effect-bench.mjs \
  --http-only \
  --group profile \
  --cpu-prof \
  --cpu-prof-dir ./profiles
```

Recommended profiling run:

```bash
node effect-bench.mjs \
  --http-only \
  --group profile \
  --cpu-prof \
  --cpu-prof-dir ./profiles \
  --requests 500000 \
  --warmup 20000 \
  --rounds 3
```

## Speedscope

Install Speedscope:

```bash
npm install -g speedscope
```

List generated profiles:

```bash
ls -lh profiles/*.cpuprofile
```

Open a profile:

```bash
speedscope profiles/CPU.20260916.174242.123936.0.001.cpuprofile
```

## HTTP modes

Available HTTP modes are:

`native-empty`, `bridge-empty`, `effect-direct-empty`

`native-static`, `bridge-static`, `effect-direct-text`, `effect-direct-uint8`, `effect-direct-raw`

`effect-request-only`, `effect-request-url`, `effect-request-source`

`effect-http-router-static`, `effect-layer-router-static`

`native-dynamic`, `bridge-dynamic`, `effect-direct-dynamic`, `effect-http-router-dynamic`, `effect-layer-router-dynamic`

## Focused runs

### Runtime / adapter

```bash
node effect-bench.mjs \
  --http-only \
  --modes native-empty,bridge-empty,effect-direct-empty \
  --requests 500000 \
  --warmup 20000 \
  --rounds 5
```

### Response representation

```bash
node effect-bench.mjs \
  --http-only \
  --group responses \
  --requests 200000 \
  --rounds 7
```

### Request abstraction

```bash
node effect-bench.mjs \
  --http-only \
  --group requests \
  --requests 200000 \
  --rounds 7
```

### Routing

```bash
node effect-bench.mjs \
  --http-only \
  --group routers \
  --requests 200000 \
  --rounds 7
```

### Dynamic handlers

```bash
node effect-bench.mjs \
  --http-only \
  --group dynamic \
  --requests 200000 \
  --rounds 7
```
