import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

function bootSeconds() {
  return Math.round(Date.now() / 1_000 - uptime());
}

// Resolves to "exited" when the process ends, or "alive" once the wait is up.
function settle(child, waitMs) {
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve("exited"))),
    new Promise((resolve) => setTimeout(() => resolve("alive"), waitMs)),
  ]);
}

async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

// A long-lived process group standing in for a leaked proxy tree.
function spawnGroup() {
  const child = spawn("sh", ["-c", "while : ; do sleep 0.2 ; done"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function fixture({ uvx }) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-gateway-orphan-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "uvx"), uvx, "utf8");
  await chmod(join(bin, "uvx"), 0o755);
  const config = join(directory, "servers.json");
  await writeFile(
    config,
    JSON.stringify({ mcpServers: { fake: { port: 18771, command: "uvx", args: [] } } }),
    "utf8",
  );
  return { directory, bin, config, state: join(directory, "state.json") };
}

function startSupervisor({ directory, bin, config, state }) {
  const child = spawn(process.execPath, [join(repository, "supervisor.mjs")], {
    env: {
      ...process.env,
      HOME: directory,
      PATH: `${bin}:${process.env.PATH}`,
      MCP_GATEWAY_CONFIG: config,
      MCP_GATEWAY_STATE: state,
      MCP_GATEWAY_MIN_RESTART_DELAY_MS: "50",
      MCP_GATEWAY_MAX_RESTART_DELAY_MS: "200",
      MCP_GATEWAY_TERMINATE_GRACE_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  child.output = () => output;
  return child;
}

test("stopping a server kills the whole downstream tree", async () => {
  const grandchild = join(tmpdir(), `mcp-gateway-grandchild-${process.pid}`);
  const context = await fixture({
    uvx: `#!/bin/sh
sh -c 'while : ; do sleep 0.2 ; done' &
printf '%s\\n' "$!" > ${JSON.stringify(grandchild)}
exec sleep 30
`,
  });

  try {
    const supervisor = startSupervisor(context);
    const pid = await until(async () => {
      const raw = await readFile(grandchild, "utf8").catch(() => "");
      const value = Number(raw.trim());
      return Number.isInteger(value) && value > 1 ? value : null;
    }, 10_000);
    assert.ok(pid, "fake server never reported its grandchild");

    supervisor.kill("SIGTERM");
    await new Promise((resolve) => supervisor.once("exit", resolve));

    // The grandchild is not a child of the supervisor, so its death can only
    // be observed by signalling it.
    const gone = await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    }, 10_000);
    assert.ok(gone, `grandchild ${pid} survived the supervisor`);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
    await rm(grandchild, { force: true });
  }
}, 30_000);

test("a previous run's orphaned process groups are swept at startup", async () => {
  const context = await fixture({ uvx: "#!/bin/sh\nexec sleep 30\n" });
  const victim = spawnGroup();

  try {
    await writeFile(
      context.state,
      JSON.stringify({ boot: bootSeconds(), groups: { fake: victim.pid } }),
      "utf8",
    );

    const supervisor = startSupervisor(context);
    const outcome = await settle(victim, 10_000);
    supervisor.kill("SIGTERM");
    await new Promise((resolve) => supervisor.once("exit", resolve));
    assert.equal(outcome, "exited", `orphaned group ${victim.pid} survived startup`);
  } finally {
    victim.kill("SIGKILL");
    await rm(context.directory, { recursive: true, force: true });
  }
}, 30_000);

test("state recorded under a different boot is not acted on", async () => {
  const context = await fixture({ uvx: "#!/bin/sh\nexec sleep 30\n" });
  const bystander = spawnGroup();

  try {
    await writeFile(
      context.state,
      JSON.stringify({ boot: bootSeconds() - 86_400, groups: { fake: bystander.pid } }),
      "utf8",
    );

    const supervisor = startSupervisor(context);
    const outcome = await settle(bystander, 3_000);
    supervisor.kill("SIGTERM");
    await new Promise((resolve) => supervisor.once("exit", resolve));
    assert.equal(outcome, "alive", `recycled pid ${bystander.pid} was killed on stale state`);
  } finally {
    bystander.kill("SIGKILL");
    await rm(context.directory, { recursive: true, force: true });
  }
}, 30_000);

async function leakyFixture() {
  const context = await fixture({ uvx: "" });
  context.marker = join(context.directory, "descendant.json");
  context.started = join(context.directory, "replacement");
  const descendant = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,group:process.argv[2]})); setInterval(() => {}, 1000);";
  const program = [
    "#!" + process.execPath,
    "const fs = require('node:fs');",
    "const {spawn} = require('node:child_process');",
    "const marker = " + JSON.stringify(context.marker) + ";",
    "if (!fs.existsSync(marker)) {",
    "  spawn(process.execPath, ['-e', " + JSON.stringify(descendant) + ", marker, String(process.pid)], {stdio:'ignore'});",
    "  const timer = setInterval(() => {if (fs.existsSync(marker)) {clearInterval(timer); process.exit(1);}}, 5);",
    "} else {",
    "  fs.writeFileSync(" + JSON.stringify(context.started) + ", String(Date.now()));",
    "  setInterval(() => {}, 1000);",
    "}",
    "",
  ].join("\n");
  await writeFile(join(context.bin, "uvx"), program, "utf8");
  return context;
}

async function stopFixture(context, supervisor) {
  if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
    supervisor.kill("SIGKILL");
    await settle(supervisor, 2_000);
  }
  const state = JSON.parse(await readFile(context.state, "utf8").catch(() => "{}"));
  const marker = JSON.parse(await readFile(context.marker, "utf8").catch(() => "{}"));
  for (const pid of [...Object.values(state.groups ?? {}), Number(marker.group)]) {
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try { process.kill(-pid, "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  await rm(context.directory, {recursive:true, force:true});
}

async function pendingSweep(context, supervisor) {
  assert.ok(await until(() => supervisor.output().includes("sweeping fake process group"), 10_000), supervisor.output());
  const marker = JSON.parse(await readFile(context.marker, "utf8"));
  const state = JSON.parse(await readFile(context.state, "utf8"));
  assert.equal(state.groups.fake, Number(marker.group), "pending cleanup must remain recoverable");
  return marker;
}

function isGone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}

test("replacement waits for a TERM-ignoring descendant and retains recovery state", {timeout:30_000}, async () => {
  const context = await leakyFixture();
  const supervisor = startSupervisor(context);
  try {
    const marker = await pendingSweep(context, supervisor);
    assert.equal(await readFile(context.started, "utf8").catch(() => null), null);
    assert.ok(await until(() => isGone(marker.pid), 10_000), supervisor.output());
    assert.ok(await until(() => readFile(context.started, "utf8").catch(() => null), 10_000), supervisor.output());
    supervisor.kill("SIGTERM");
    assert.equal(await settle(supervisor, 10_000), "exited", supervisor.output());
    assert.equal(supervisor.exitCode, 0, supervisor.output());
  } finally { await stopFixture(context, supervisor); }
});

test("shutdown waits for an already pending descendant sweep", {timeout:30_000}, async () => {
  const context = await leakyFixture();
  const supervisor = startSupervisor(context);
  try {
    const marker = await pendingSweep(context, supervisor);
    supervisor.kill("SIGTERM");
    assert.equal(await settle(supervisor, 10_000), "exited", supervisor.output());
    assert.equal(supervisor.exitCode, 0, supervisor.output());
    assert.ok(await until(() => isGone(marker.pid), 5_000), "descendant survived shutdown");
    assert.equal(await readFile(context.started, "utf8").catch(() => null), null);
  } finally { await stopFixture(context, supervisor); }
});

test("SIGKILL during a sweep leaves the group recoverable by the next supervisor", {timeout:30_000}, async () => {
  const context = await leakyFixture();
  let supervisor = startSupervisor(context);
  try {
    const marker = await pendingSweep(context, supervisor);
    supervisor.kill("SIGKILL");
    assert.equal(await settle(supervisor, 5_000), "exited");
    assert.equal(isGone(marker.pid), false, "fixture should survive until recovery");
    supervisor = startSupervisor(context);
    assert.ok(await until(() => isGone(marker.pid), 10_000), supervisor.output());
    assert.ok(await until(() => readFile(context.started, "utf8").catch(() => null), 10_000), supervisor.output());
    supervisor.kill("SIGTERM");
    assert.equal(await settle(supervisor, 10_000), "exited", supervisor.output());
    assert.equal(supervisor.exitCode, 0, supervisor.output());
  } finally { await stopFixture(context, supervisor); }
});
