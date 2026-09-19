#!/usr/bin/env node
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MEDIA = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

function requireValue(condition, reason) { if (!condition) throw new Error(reason); }
function exactKeys(value, expected, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const keys = Object.keys(value).sort();
  requireValue(JSON.stringify(keys) === JSON.stringify([...expected].sort()), `${label} has unexpected or missing keys`);
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function decode(bytes, label) {
  requireValue(bytes.length <= 16 * 1024 * 1024, `${label} is too large`);
  try {
    const text = bytes.toString("utf8");
    const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
    const scopes = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === "{") scopes.push(new Set());
      else if (token === "[") scopes.push(null);
      else if (token === "}" || token === "]") scopes.pop();
      else if (token.startsWith('"') && tokens[index + 1] === ":") {
        const keys = scopes.at(-1);
        const key = JSON.parse(token);
        requireValue(keys instanceof Set && !keys.has(key), `${label} has a duplicate JSON key`);
        keys.add(key);
      }
    }
    return JSON.parse(text);
  } catch (error) {
    if (error.message?.includes("duplicate JSON key")) throw error;
    throw new Error(`${label} is not valid JSON`);
  }
}

async function safeFile(root, relative) {
  requireValue(typeof relative === "string" && relative.length > 0 && !posix.isAbsolute(relative), "invalid artifact path");
  const parts = relative.split("/");
  requireValue(!parts.some(part => !part || part === "." || part === ".."), "artifact path escapes bundle");
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const stat = await lstat(current);
    requireValue(!stat.isSymbolicLink(), "artifact symlinks are forbidden");
  }
  requireValue((await lstat(current)).isFile(), "artifact is not a file");
  return current;
}

async function checkedArtifact(root, descriptor, label, readMetadata = false) {
  exactKeys(descriptor, ["path", "sha256"], label);
  requireValue(HEX.test(descriptor.sha256), `${label} checksum is invalid`);
  const path = await safeFile(root, descriptor.path);
  requireValue(await sha256File(path) === descriptor.sha256, `${label} checksum mismatch`);
  return { path, bytes: readMetadata ? await readFile(path) : undefined };
}

async function rejectBundleSpecialFiles(root) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      requireValue(!entry.isSymbolicLink(), "bundle symlinks are forbidden");
      if (entry.isDirectory()) await visit(path);
      else requireValue(entry.isFile(), "bundle special files are forbidden");
    }
  }
  await visit(root);
}

function tarEntries(archive) {
  const names = execFileSync("tar", ["-tf", archive], { encoding: "utf8", timeout: 30000 }).trim().split("\n").filter(Boolean);
  const verbose = execFileSync("tar", ["-tvf", archive], { encoding: "utf8", timeout: 30000 }).trim().split("\n").filter(Boolean);
  requireValue(names.length === verbose.length, "archive listing mismatch");
  const normalized = new Set();
  for (let index = 0; index < names.length; index += 1) {
    const type = verbose[index][0];
    requireValue(type === "-" || type === "d", "archive links and special files are forbidden");
    const name = names[index].replace(/^\.\//, "").replace(/\/$/, "");
    requireValue(name === "oci-layout" || name === "index.json" || name === "blobs" || name === "blobs/sha256"
      || /^blobs\/sha256\/[0-9a-f]{64}$/.test(name), "invalid OCI archive path");
    requireValue(!normalized.has(name), "duplicate OCI archive member");
    normalized.add(name);
  }
  return normalized;
}

function tarRead(archive, members, name) {
  requireValue(members.has(name), `OCI object missing: ${name}`);
  return execFileSync("tar", ["-xOf", archive, name], { maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
}

async function tarDigest(archive, members, name) {
  requireValue(members.has(name), `OCI object missing: ${name}`);
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("tar", ["-xOf", archive, name], { stdio: ["ignore", "pipe", "pipe"] });
    const hash = createHash("sha256");
    let size = 0;
    let diagnostic = "";
    child.stdout.on("data", chunk => { size += chunk.length; hash.update(chunk); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { if (diagnostic.length < 4096) diagnostic += chunk; });
    child.on("error", rejectPromise);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 300000);
    child.on("close", code => code === 0
      ? (clearTimeout(timeout), resolvePromise({ size, digest: hash.digest("hex") }))
      : (clearTimeout(timeout), rejectPromise(new Error(`tar failed for ${name}: ${diagnostic.trim()}`))));
  });
}

export async function verifyOciArchive(archive, expectedDigest) {
  requireValue(DIGEST.test(expectedDigest), "invalid image digest");
  const members = tarEntries(archive);
  exactKeys(decode(tarRead(archive, members, "oci-layout"), "oci-layout"), ["imageLayoutVersion"], "oci-layout");
  requireValue(decode(tarRead(archive, members, "oci-layout"), "oci-layout").imageLayoutVersion === "1.0.0", "unsupported OCI layout");
  const index = decode(tarRead(archive, members, "index.json"), "index.json");
  requireValue(Array.isArray(index.manifests) && index.manifests.length === 1, "archive must select one image or index");
  requireValue(index.manifests[0].digest === expectedDigest, "archive image differs from signed digest");
  requireValue(MEDIA.has(index.manifests[0].mediaType), "OCI root must be an image or index");
  const seen = new Set();
  const visit = async descriptor => {
    requireValue(descriptor && DIGEST.test(descriptor.digest) && Number.isSafeInteger(descriptor.size), "invalid OCI descriptor");
    const name = `blobs/sha256/${descriptor.digest.slice(7)}`;
    if (seen.has(descriptor.digest)) return;
    seen.add(descriptor.digest);
    if (descriptor.mediaType.endsWith("image.index.v1+json") || descriptor.mediaType.endsWith("manifest.list.v2+json")) {
      const bytes = tarRead(archive, members, name);
      requireValue(bytes.length === descriptor.size && sha256(bytes) === descriptor.digest.slice(7), "OCI metadata digest or size mismatch");
      const child = decode(bytes, name);
      requireValue(Array.isArray(child.manifests) && child.manifests.length > 0, "empty OCI index");
      for (const item of child.manifests) await visit(item);
    } else if (descriptor.mediaType.endsWith("image.manifest.v1+json") || descriptor.mediaType.endsWith("manifest.v2+json")) {
      const bytes = tarRead(archive, members, name);
      requireValue(bytes.length === descriptor.size && sha256(bytes) === descriptor.digest.slice(7), "OCI metadata digest or size mismatch");
      const manifest = decode(bytes, name);
      await visit(manifest.config);
      requireValue(Array.isArray(manifest.layers), "OCI manifest layers are missing");
      for (const layer of manifest.layers) await visit(layer);
    } else {
      requireValue(descriptor.mediaType === "application/vnd.oci.image.config.v1+json"
        || descriptor.mediaType === "application/vnd.docker.container.image.v1+json"
        || descriptor.mediaType.startsWith("application/vnd.oci.image.layer.v1.tar")
        || descriptor.mediaType === "application/vnd.docker.image.rootfs.diff.tar.gzip", "unsupported OCI media type");
      if (descriptor.mediaType === "application/vnd.oci.image.config.v1+json"
        || descriptor.mediaType === "application/vnd.docker.container.image.v1+json") {
        const bytes = tarRead(archive, members, name);
        requireValue(bytes.length === descriptor.size && sha256(bytes) === descriptor.digest.slice(7), "OCI config digest or size mismatch");
        decode(bytes, name);
      } else {
        const streamed = await tarDigest(archive, members, name);
        requireValue(streamed.size === descriptor.size && streamed.digest === descriptor.digest.slice(7), "OCI layer digest or size mismatch");
      }
    }
  };
  await visit(index.manifests[0]);
}

export async function verifyBundle({ bundle, publicKey, release }) {
  requireValue(RELEASE.test(release), "invalid expected release");
  const root = resolve(bundle);
  await rejectBundleSpecialFiles(root);
  const manifestPath = await safeFile(root, "manifest.json");
  const signaturePath = await safeFile(root, "manifest.sig");
  const [manifestBytes, signatureBytes, keyBytes] = await Promise.all([
    readFile(manifestPath), readFile(signaturePath), readFile(resolve(publicKey)),
  ]);
  const key = createPublicKey(keyBytes);
  requireValue(key.asymmetricKeyType === "ed25519", "only Ed25519 publisher keys are accepted");
  requireValue(signatureBytes.length === 64 && verifySignature(null, manifestBytes, key, signatureBytes), "invalid bundle signature");
  const manifest = decode(manifestBytes, "manifest.json");
  exactKeys(manifest, ["schema", "release", "qualification", "components"], "manifest");
  requireValue(manifest.schema === "deixic.private-distribution.v1", "unsupported bundle schema");
  requireValue(manifest.release === release, "unexpected release");
  requireValue(manifest.qualification === "unqualified", "bundle cannot assert deployment qualification");
  requireValue(Array.isArray(manifest.components) && manifest.components.length > 0, "empty component list");
  const names = new Set();
  for (const component of manifest.components) {
    exactKeys(component, ["name", "digest", "archive", "sbom", "provenance"], "component");
    requireValue(NAME.test(component.name) && !names.has(component.name), "invalid or duplicate component name");
    names.add(component.name);
    requireValue(DIGEST.test(component.digest), "invalid component digest");
    const archive = await checkedArtifact(root, component.archive, "archive");
    await verifyOciArchive(archive.path, component.digest);
    const sbom = decode((await checkedArtifact(root, component.sbom, "sbom", true)).bytes, "sbom");
    requireValue(sbom.bomFormat === "CycloneDX" && ["1.5", "1.6"].includes(sbom.specVersion), "unsupported SBOM format");
    const subject = sbom.metadata?.component;
    requireValue(subject?.name === component.name && Array.isArray(subject.hashes)
      && subject.hashes.some(hash => hash?.alg === "SHA-256" && hash?.content === component.digest.slice(7)), "SBOM subject mismatch");
    const provenance = decode((await checkedArtifact(root, component.provenance, "provenance", true)).bytes, "provenance");
    requireValue(provenance._type === "https://in-toto.io/Statement/v1"
      && provenance.predicateType === "https://slsa.dev/provenance/v1", "unsupported provenance format");
    requireValue(JSON.stringify(provenance.subject) === JSON.stringify([{ name: component.name, digest: { sha256: component.digest.slice(7) } }]), "provenance subject mismatch");
    requireValue(Boolean(provenance.predicate?.runDetails?.builder?.id)
      && Boolean(provenance.predicate?.buildDefinition?.buildType), "missing provenance builder or build type");
  }
  return manifest;
}

async function main() {
  const { values } = parseArgs({ options: {
    bundle: { type: "string" }, "public-key": { type: "string" }, release: { type: "string" },
  } });
  requireValue(values.bundle && values["public-key"] && values.release,
    "usage: node verify-bundle.mjs --bundle <dir> --public-key <pem> --release <release>");
  const manifest = await verifyBundle({ bundle: values.bundle, publicKey: values["public-key"], release: values.release });
  process.stdout.write(JSON.stringify({ release: manifest.release, qualification: "unqualified", verified: true }) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { await main(); }
  catch { console.error("private bundle validation failed; no deployment qualification granted"); process.exitCode = 1; }
}
