import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
