#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { verifyBundle } from "./verify-bundle.mjs";

const REGISTRY = /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

function requireValue(condition, reason) { if (!condition) throw new Error(reason); }

export async function importBundle({ bundle, publicKey, release, registry, apply = false }) {
  requireValue(REGISTRY.test(registry), "invalid destination registry or prefix");
  const host = registry.split("/")[0];
  requireValue(host === "localhost" || host.includes(".") || host.includes(":"), "explicit registry hostname required");
  let scratch;
  let verifiedRoot = resolve(bundle);
  if (apply) {
    scratch = await mkdtemp(join(tmpdir(), "deixic-private-import-"));
    verifiedRoot = join(scratch, "bundle");
    await cp(resolve(bundle), verifiedRoot, { recursive: true, dereference: false, errorOnExist: true, force: false });
  }
  try {
    const manifest = await verifyBundle({ bundle: verifiedRoot, publicKey, release });
    const images = manifest.components.map(component => ({
      name: component.name,
      source: `oci-archive:${resolve(verifiedRoot, component.archive.path)}`,
      destination: `docker://${registry}/${component.name}:${release}`,
      immutable: `${registry}/${component.name}@${component.digest}`,
      digest: component.digest,
    }));
    if (!apply) return { release, qualification: "unqualified", applied: false, images };
    for (const image of images) {
      execFileSync("skopeo", ["copy", "--all", "--preserve-digests", image.source, image.destination], { stdio: "ignore", timeout: 300000 });
      const raw = execFileSync("skopeo", ["inspect", "--raw", `docker://${image.immutable}`], { timeout: 300000 });
      requireValue(`sha256:${createHash("sha256").update(raw).digest("hex")}` === image.digest, "destination image digest mismatch");
    }
    return { release, qualification: "unqualified", applied: true, images: images.map(({ name, immutable }) => ({ name, image: immutable })) };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    bundle: { type: "string" }, "public-key": { type: "string" }, release: { type: "string" },
    registry: { type: "string" }, apply: { type: "boolean", default: false },
  } });
  requireValue(values.bundle && values["public-key"] && values.release && values.registry,
    "usage: node import-bundle.mjs --bundle <dir> --public-key <pem> --release <release> --registry <host/prefix> [--apply]");
  const result = await importBundle({ bundle: values.bundle, publicKey: values["public-key"], release: values.release,
    registry: values.registry, apply: values.apply });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { await main(); }
  catch { console.error("private bundle validation/import failed; no deployment qualification granted"); process.exitCode = 1; }
}
