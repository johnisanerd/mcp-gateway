import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

// Runs the supervisor against a child that always exits immediately and
// records every spawn timestamp, so restart timing can be asserted.
async function runSupervisor({ minDelayMs, maxDelayMs, runTimeMs }) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-gateway-backoff-"));
  const bin = join(directory, "bin");
  const spawns = join(directory, "spawns");
  const config = join(directory, "servers.json");
  await mkdir(bin);
  await writeFile(
    join(bin, "uvx"),
    `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(spawns)}, String(process.hrtime.bigint()) + "\\n");\nprocess.exit(1);\n`,
    "utf8",
  );
  await chmod(join(bin, "uvx"), 0o755);
  await writeFile(
    config,
    JSON.stringify({ mcpServers: { fake: { port: 18765, command: "uvx", args: [] } } }),
    "utf8",
  );

  const child = spawn(process.execPath, [join(repository, "supervisor.mjs")], {
    env: {
      ...process.env,
      HOME: directory,
      PATH: `${bin}:${process.env.PATH}`,
      MCP_GATEWAY_CONFIG: config,
      MCP_GATEWAY_STATE: join(directory, "state.json"),
      MCP_GATEWAY_MIN_RESTART_DELAY_MS: String(minDelayMs),
      MCP_GATEWAY_MAX_RESTART_DELAY_MS: String(maxDelayMs),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  await new Promise((resolve) => setTimeout(resolve, runTimeMs));
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));

  let timestamps = [];
  try {
    timestamps = (await readFile(spawns, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rm(directory, { recursive: true, force: true });
  return timestamps;
}

test("quick failures back off exponentially up to the cap", async () => {
  const minDelayMs = 100;
  const maxDelayMs = 400;
  const timestamps = await runSupervisor({ minDelayMs, maxDelayMs, runTimeMs: 1_400 });

  // Fixed 100ms restarts would spawn ~14 times; backoff 100 -> 200 -> 400 -> 400
  // yields 4-7 spawns depending on node startup jitter.
  assert.ok(timestamps.length >= 3, `expected at least 3 spawns, got ${timestamps.length}`);
  assert.ok(timestamps.length <= 7, `expected at most 7 spawns, got ${timestamps.length}`);

  const gaps = timestamps.slice(1).map((time, index) => (time - timestamps[index]) / 1e6);
  const report = gaps.map((gap) => gap.toFixed(1)).join(", ");

  // Every gap carries the same spawn overhead on top of its scheduled delay,
  // so gaps are compared against the delay they were scheduled for and growth
  // is measured as a difference rather than a ratio; a ratio reads the shared
  // overhead as shrinkage and flakes at these deliberately short delays.
  gaps.forEach((gap, index) => {
    const scheduled = Math.min(minDelayMs * 2 ** index, maxDelayMs);
    assert.ok(gap >= scheduled * 0.9, `gap ${index} should be >= ${scheduled}ms: ${report}`);
  });

  assert.ok(
    gaps[1] - gaps[0] >= minDelayMs * 0.5,
    `second gap should grow by about ${minDelayMs}ms: ${report}`,
  );
  const lastGap = gaps[gaps.length - 1];
  assert.ok(lastGap >= maxDelayMs * 0.9, `cap gap should be >= ${maxDelayMs}ms: ${report}`);
}, 15_000);

async function until(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("spawn failure without exit retries and recovers when uvx becomes available", {timeout:20_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-gateway-spawn-error-"));
  const bin = join(directory, "bin");
  const config = join(directory, "servers.json");
  const marker = join(directory, "started");
  await mkdir(bin);
  await writeFile(config, JSON.stringify({mcpServers:{fake:{port:18765,command:"unused"}}}));
  const child = spawn(process.execPath, [join(repository, "supervisor.mjs")], {
    env:{...process.env, HOME:directory, PATH:bin, MCP_GATEWAY_CONFIG:config,
      MCP_GATEWAY_STATE:join(directory,"state.json"), MCP_GATEWAY_MIN_RESTART_DELAY_MS:"100",
      MCP_GATEWAY_MAX_RESTART_DELAY_MS:"200"},
    stdio:["ignore","ignore","pipe"],
  });
  let output = "";
  child.stderr.on("data", (data) => {output += data;});
  try {
    assert.ok(await until(() => (output.match(/failed to start/g) ?? []).length >= 2), output);
    await writeFile(join(bin,"uvx"), "#!" + process.execPath + "\nrequire('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'ready'); setInterval(() => {}, 1000);\n");
    await chmod(join(bin,"uvx"), 0o755);
    assert.ok(await until(() => readFile(marker,"utf8").catch(() => null)), output);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    assert.equal(child.exitCode, 0, output);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    await rm(directory, {recursive:true,force:true});
  }
});

test("stale probe success and failure cannot mutate the replacement generation", async () => {
  const source = await readFile(join(repository,"supervisor.mjs"),"utf8");
  const beginning = source.indexOf("async function probe(name) {");
  const end = source.indexOf("\nfunction shutdown(", beginning);
  assert.ok(beginning >= 0 && end > beginning);
  const createProbe = new Function("stopping", "probesInFlight", "children", "startTimes", "startupGraceMs", "probeMcp", "servers", "probeFailures", "consecutiveFailures", "failedProbesBeforeRestart", "terminate", "return " + source.slice(beginning,end));
  for (const failure of [false,true]) {
    const old = {};
    const replacement = {};
    const children = new Map([["fake",old]]);
    const inFlight = new Map();
    const failures = new Map([["fake",2]]);
    const consecutive = new Map([["fake",5]]);
    const requests = [];
    const terminations = [];
    const probe = createProbe(false,inFlight,children,new Map([["fake",0]]),0,
      () => new Promise((resolve,reject) => {requests.push({resolve,reject});}),
      {fake:{port:18765}},failures,consecutive,3,(name) => {terminations.push(name);});
    const first = probe("fake");
    children.set("fake",replacement);
    inFlight.delete("fake");
    const second = probe("fake");
    if (failure) requests[0].reject(new Error("stale failure"));
    else requests[0].resolve();
    await first;
    assert.equal(failures.get("fake"),2);
    assert.equal(consecutive.get("fake"),5);
    assert.equal(inFlight.get("fake"),replacement);
    assert.deepEqual(terminations,[]);
    requests[1].resolve();
    await second;
    assert.equal(failures.get("fake"),0);
    assert.equal(consecutive.get("fake"),0);
    assert.equal(inFlight.has("fake"),false);
  }
});
