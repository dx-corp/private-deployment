import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";
import { importBundle } from "../import-bundle.mjs";
import { verifyBundle } from "../verify-bundle.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture({ layerSize = 14 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "private-bundle-"));
  const oci = join(root, "oci");
  await mkdir(join(oci, "blobs", "sha256"), { recursive: true });
  const config = Buffer.from('{"architecture":"amd64","os":"linux"}');
  const layer = layerSize === 14 ? Buffer.from("fixture layer\n") : Buffer.alloc(layerSize, 0x61);
  const configDigest = hash(config), layerDigest = hash(layer);
  await writeFile(join(oci, "blobs", "sha256", configDigest), config);
  await writeFile(join(oci, "blobs", "sha256", layerDigest), layer);
  const imageManifest = Buffer.from(JSON.stringify({ schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: `sha256:${configDigest}`, size: config.length },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: `sha256:${layerDigest}`, size: layer.length }],
  }));
  const imageDigest = hash(imageManifest);
  await writeFile(join(oci, "blobs", "sha256", imageDigest), imageManifest);
  await writeFile(join(oci, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(oci, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{
    mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${imageDigest}`, size: imageManifest.length,
  }] }));
  execFileSync("tar", ["-cf", join(root, "runner-host.tar"), "oci-layout", "index.json", "blobs"], { cwd: oci });
  const sbom = Buffer.from(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", metadata: { component: {
    name: "runner-host", hashes: [{ alg: "SHA-256", content: imageDigest }],
  } } }));
  const provenance = Buffer.from(JSON.stringify({ _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1", subject: [{ name: "runner-host", digest: { sha256: imageDigest } }],
    predicate: { runDetails: { builder: { id: "https://github.com/dx-corp/mono/actions" } },
      buildDefinition: { buildType: "https://github.com/Attestations/GitHubActionsWorkflow@v1" } },
  }));
  await writeFile(join(root, "runner-host.sbom.json"), sbom);
  await writeFile(join(root, "runner-host.provenance.json"), provenance);
  const archive = await readFile(join(root, "runner-host.tar"));
  const manifest = Buffer.from(JSON.stringify({ schema: "deixic.private-distribution.v1", release: "2026.09.18",
    qualification: "unqualified", components: [{ name: "runner-host", digest: `sha256:${imageDigest}`,
      archive: { path: "runner-host.tar", sha256: hash(archive) },
      sbom: { path: "runner-host.sbom.json", sha256: hash(sbom) },
      provenance: { path: "runner-host.provenance.json", sha256: hash(provenance) },
    }],
  }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(join(root, "publisher.pem"), publicKey.export({ type: "spki", format: "pem" }));
  await writeFile(join(root, "manifest.json"), manifest);
  await writeFile(join(root, "manifest.sig"), sign(null, manifest, privateKey));
  return root;
}

test("verifies the signed offline bundle and plans a digest-preserving import", async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await verifyBundle({ bundle: root, publicKey: join(root, "publisher.pem"), release: "2026.09.18" });
  assert.equal(manifest.qualification, "unqualified");
  const result = await importBundle({ bundle: root, publicKey: join(root, "publisher.pem"), release: "2026.09.18",
    registry: "registry.customer.example/deixic" });
  assert.equal(result.applied, false);
  assert.match(result.images[0].immutable, /^registry\.customer\.example\/deixic\/runner-host@sha256:/);
});

test("rejects tampering and a release asserted as qualified", async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "runner-host.sbom.json"), "{}\n");
  await assert.rejects(verifyBundle({ bundle: root, publicKey: join(root, "publisher.pem"), release: "2026.09.18" }), /checksum mismatch/);
  const second = await fixture(); t.after(() => rm(second, { recursive: true, force: true }));
  const bytes = await readFile(join(second, "manifest.json"));
  await writeFile(join(second, "manifest.json"), Buffer.from(bytes.toString().replace("unqualified", "qualified")));
  await assert.rejects(verifyBundle({ bundle: second, publicKey: join(second, "publisher.pem"), release: "2026.09.18" }), /signature/);
});

test("streams ordinary OCI layers larger than the metadata cap", async t => {
  const root = await fixture({ layerSize: 21 * 1024 * 1024 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await verifyBundle({ bundle: root, publicKey: join(root, "publisher.pem"), release: "2026.09.18" });
  assert.equal(manifest.components[0].name, "runner-host");
});

async function resign(root, change) {
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  await change(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(join(root, "publisher.pem"), publicKey.export({ type: "spki", format: "pem" }));
  await writeFile(join(root, "manifest.json"), bytes);
  await writeFile(join(root, "manifest.sig"), sign(null, bytes, privateKey));
}

// Change valid tar headers without changing a single OCI object byte.
async function foreignOwnership(root) {
  const path = join(root, "runner-host.tar");
  const bytes = await readFile(path);
  for (let offset = 0; offset + 512 <= bytes.length && bytes[offset] !== 0;) {
    const size = parseInt(bytes.subarray(offset + 124, offset + 136).toString().replace(/\0/g, "").trim(), 8);
    bytes.write("0000000\0", offset + 100, "ascii");
    bytes.write("0361100\0", offset + 108, "ascii");
    bytes.write("0361100\0", offset + 116, "ascii");
    bytes.fill(32, offset + 148, offset + 156);
    const sum = bytes.subarray(offset, offset + 512).reduce((total, byte) => total + byte, 0);
    bytes.write(sum.toString(8).padStart(6, "0") + "\0 ", offset + 148, "ascii");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  await writeFile(path, bytes);
  await resign(root, manifest => { manifest.components[0].archive.sha256 = hash(bytes); });
}

async function runApplied(root, mode = "success") {
  const bin = join(root, "mock-bin");
  await mkdir(bin);
  const log = join(root, "skopeo-calls.jsonl");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const script = `#!${process.execPath}
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_CALL_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "copy") {
  if (process.env.TEST_MODE === "copy-failure") process.exit(9);
  if (!args.includes("--all") || !args.includes("--preserve-digests")) process.exit(10);
  const source = args[3];
  if (!source.startsWith("oci:")) throw new Error("archive metadata was passed to Skopeo");
  const layout = source.slice(4);
  const index = JSON.parse(readFileSync(layout + "/index.json"));
  const path = layout + "/blobs/sha256/" + index.manifests[0].digest.slice(7);
  if (!(statSync(path).mode & 0o400)) throw new Error("OCI bytes are not locally readable");
  for (const name of readdirSync(layout + "/blobs/sha256")) {
    const bytes = readFileSync(layout + "/blobs/sha256/" + name);
    if (createHash("sha256").update(bytes).digest("hex") !== name) throw new Error("OCI bytes changed during materialization");
  }
} else if (args[0] === "inspect") {
  if (process.env.TEST_MODE === "wrong-digest") process.stdout.write("{}");
  else process.stdout.write(readFileSync(process.env.TEST_OCI_MANIFEST));
} else process.exit(11);
`;
  await writeFile(join(bin, "skopeo"), script, { mode: 0o700 });
  const cli = fileURLToPath(new URL("../import-bundle.mjs", import.meta.url));
  const args = [cli, "--bundle", root, "--public-key", join(root, "publisher.pem"), "--release", "2026.09.18",
    "--registry", "registry.customer.example/deixic", "--apply"];
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH, TEST_CALL_LOG: log, TEST_MODE: mode,
    TEST_OCI_MANIFEST: join(root, "oci/blobs/sha256", manifest.components[0].digest.slice(7)) };
  let result, error;
  try { result = JSON.parse(execFileSync(process.execPath, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
  catch (caught) { error = caught; }
  const calls = await readFile(log, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  return { result, error, calls: calls.trim() ? calls.trim().split("\n").map(line => JSON.parse(line)) : [] };
}

test("applied import streams large layers, ignores foreign tar metadata and cleans its OCI layout", async t => {
  const root = await fixture({ layerSize: 21 * 1024 * 1024 }); t.after(() => rm(root, { recursive: true, force: true }));
  await foreignOwnership(root);
  const applied = await runApplied(root);
  assert.ifError(applied.error);
  assert.equal(applied.result.applied, true);
  assert.equal(applied.calls[0][0], "copy");
  assert.equal(applied.calls[1][0], "inspect");
  const layout = applied.calls[0][3].slice(4);
  await assert.rejects(readFile(join(layout, "index.json")), { code: "ENOENT" });
});

for (const mode of ["copy-failure", "wrong-digest"]) {
  test(`applied import fails closed and cleans scratch on ${mode}`, async t => {
    const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
    const applied = await runApplied(root, mode);
    assert.equal(applied.error?.status, 1);
    assert.equal(applied.result, undefined);
    assert.equal(applied.calls.at(-1)[0], mode === "copy-failure" ? "copy" : "inspect");
    const layout = applied.calls[0][3].slice(4);
    await assert.rejects(readFile(join(layout, "index.json")), { code: "ENOENT" });
  });
}

for (const [name, change, reason] of [
  ["qualified claim signed by trusted key", m => { m.qualification = "qualified"; }, /cannot assert deployment qualification/],
  ["wrong release signed by trusted key", m => { m.release = "other"; }, /unexpected release/],
  ["duplicate component", m => { m.components.push(m.components[0]); }, /duplicate component/],
  ["escaping artifact path", m => { m.components[0].archive.path = "../outside.tar"; }, /escapes bundle/],
]) {
  test(`rejects ${name} before any registry mutation`, async t => {
    const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
    await resign(root, change);
    await assert.rejects(verifyBundle({ bundle: root, publicKey: join(root, "publisher.pem"), release: "2026.09.18" }), reason);
    const applied = await runApplied(root);
    assert.equal(applied.error?.status, 1);
    assert.deepEqual(applied.calls, []);
  });
}

test("validly signed first component cannot import before a corrupt later component is checked", async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await resign(root, manifest => {
    manifest.components.push({ ...manifest.components[0], name: "later", archive: { path: "missing.tar", sha256: "0".repeat(64) } });
  });
  const applied = await runApplied(root);
  assert.equal(applied.error?.status, 1);
  assert.deepEqual(applied.calls, []);
});

test("rejects artifact symlinks before any registry mutation", async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await rm(join(root, "runner-host.tar"));
  await symlink(join(root, "manifest.json"), join(root, "runner-host.tar"));
  const applied = await runApplied(root);
  assert.equal(applied.error?.status, 1);
  assert.deepEqual(applied.calls, []);
});

for (const [artifact, change, reason] of [
  ["sbom", value => { value.metadata.component.name = "other"; }, /SBOM subject mismatch/],
  ["provenance", value => { value.subject[0].digest.sha256 = "0".repeat(64); }, /provenance subject mismatch/],
  ["provenance", value => { delete value.predicate.runDetails.builder.id; }, /missing provenance builder/],
]) {
  test(`rejects signed ${artifact} with invalid image binding or builder`, async t => {
    const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
    await resign(root, async manifest => {
      const descriptor = manifest.components[0][artifact];
      const path = join(root, descriptor.path);
      const value = JSON.parse(await readFile(path, "utf8"));
      change(value);
      const bytes = Buffer.from(JSON.stringify(value));
      await writeFile(path, bytes);
      descriptor.sha256 = hash(bytes);
    });
    await assert.rejects(verifyBundle({ bundle: root, publicKey: join(root, "publisher.pem"), release: "2026.09.18" }), reason);
    const applied = await runApplied(root);
    assert.equal(applied.error?.status, 1);
    assert.deepEqual(applied.calls, []);
  });
}

test("rejects a different publisher key before any registry mutation", async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const { publicKey } = generateKeyPairSync("ed25519");
  await writeFile(join(root, "publisher.pem"), publicKey.export({ type: "spki", format: "pem" }));
  const applied = await runApplied(root);
  assert.equal(applied.error?.status, 1);
  assert.deepEqual(applied.calls, []);
});
