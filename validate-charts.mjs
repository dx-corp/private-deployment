#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CHARTS = [
  "agent-runtime", "approvals", "audit", "governance", "identity", "keys",
  "llm-gateway", "meter", "platform-api", "platform-api-migrations",
  "platform-worker", "secret-broker",
];
const HELM_VERSION = "v3.16.3";
const FIXTURE_DIGEST = "sha256:" + "1".repeat(64);

function requireValue(condition, reason) { if (!condition) throw new Error(reason); }

async function files(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      requireValue(!entry.isSymbolicLink(), "chart symlinks are forbidden");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(relative(root, path).split("\\").join("/"));
      else throw new Error("chart special files are forbidden");
    }
  }
  await visit(root);
  return result.sort();
}

export async function validateCharts(root = "charts", valuesFile = "tests/digest-values.yaml") {
  const chartRoot = resolve(root);
  const fixture = resolve(valuesFile);
  requireValue(execFileSync("helm", ["version", "--short"], { encoding: "utf8", timeout: 30000 }).trim().startsWith(HELM_VERSION), `helm ${HELM_VERSION} is required`);
  const actual = (await readdir(chartRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  requireValue(JSON.stringify(actual) === JSON.stringify(CHARTS), "unexpected chart set");
  const inventory = [];
  for (const name of CHARTS) {
    const directory = join(chartRoot, name);
    const paths = await files(directory);
    for (const required of ["Chart.yaml", "values.yaml"]) requireValue(paths.includes(required), `${name} is missing ${required}`);
    requireValue(paths.some(path => path.startsWith("templates/")), `${name} has no templates`);
    const metadata = await readFile(join(directory, "Chart.yaml"), "utf8");
    requireValue(new RegExp(`^name:\\s*${name}\\s*$`, "m").test(metadata), `${name} chart name mismatch`);
    requireValue(/^apiVersion:\s*v2\s*$/m.test(metadata), `${name} must be a Helm v3 chart`);
    requireValue(!/^type:/m.test(metadata) || /^type:\s*application\s*$/m.test(metadata), `${name} must be an application chart`);
    const values = await readFile(join(directory, "values.yaml"), "utf8");
    for (const match of values.matchAll(/^[ \t]*[A-Za-z0-9_]*(?:PASSWORD|TOKEN|SECRET|API_KEY):[ \t]*([^#\n]*)/gim)) {
      requireValue(["", "''", '""'].includes(match[1].trim()), `${name} contains a nonempty credential default`);
    }
    if (["platform-api", "platform-worker", "platform-api-migrations"].includes(name)) {
      requireValue(/^\s*requireDigest:\s*true\s*$/m.test(values), `${name} must require an image digest`);
    }
    execFileSync("helm", ["lint", "--strict", directory, "-f", fixture], { encoding: "utf8", timeout: 60000 });
    const rendered = execFileSync("helm", ["template", "projection-validation", directory, "-f", fixture], {
      encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024,
    });
    const images = [...rendered.matchAll(/^\s*image:\s*["']?([^\s"']+)["']?\s*$/gm)].map(match => match[1]);
    requireValue(images.length > 0, `${name} rendered no workload image`);
    requireValue(images.every(image => image.endsWith(`@${FIXTURE_DIGEST}`)), `${name} rendered a non-digest image`);
    const digest = createHash("sha256");
    for (const path of paths) {
      digest.update(path).update("\0").update(await readFile(join(directory, path))).update("\0");
    }
    inventory.push({ name, files: paths.length, contentSha256: digest.digest("hex") });
  }
  return inventory;
}

async function main() {
  const inventory = await validateCharts(process.argv[2] ?? "charts", process.argv[3] ?? "tests/digest-values.yaml");
  process.stdout.write(JSON.stringify({ schema: "deixic.private-deployment.chart-inputs.v1", charts: inventory }, null, 2) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
