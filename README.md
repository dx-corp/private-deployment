# Deixic Private Deployment

This repository contains Mono-owned Helm chart source plus a consumer for the
signed private image bundle produced by the Deixic Kubernetes delivery owner.
It does not contain customer values, registry credentials, signing keys, or a
second release publisher.

Verify a delivered bundle completely offline with the public key received over
your approved trust channel:

```sh
node verify-bundle.mjs \
  --bundle /media/deixic-2026.09.18 \
  --public-key /etc/deixic/publisher.pem \
  --release 2026.09.18
```

Review the import plan before changing a registry. `--apply` requires Skopeo
and uses its existing authentication configuration. It copies all platforms,
preserves digests, and verifies the destination digest after each copy.

```sh
node import-bundle.mjs --bundle /media/deixic-2026.09.18 \
  --public-key /etc/deixic/publisher.pem --release 2026.09.18 \
  --registry registry.customer.example/deixic
node import-bundle.mjs --bundle /media/deixic-2026.09.18 \
  --public-key /etc/deixic/publisher.pem --release 2026.09.18 \
  --registry registry.customer.example/deixic --apply
```

The verifier requires the exact `deixic.private-distribution.v1` manifest,
Ed25519 signature, artifact checksums, OCI graph, CycloneDX image binding, and
SLSA provenance subject and builder fields. The bundle may state only
`unqualified`.

The charts under `charts/` are real Mono-owned service chart inputs. They do
not form a complete supported installation: cloud resources, databases,
identity, customer values, secrets, network policy, migration authorization,
qualification, upgrades, and rollback remain owned by their delivery paths.
Use immutable image digests in values and render against reviewed customer
configuration before any Helm mutation.

`node validate-charts.mjs` uses Helm 3.16.3 to lint and render every chart with
the local digest fixture, rejects any rendered tag-based workload image, and
emits a deterministic inventory of the exact chart set and content digests. It
also rejects nonempty credential defaults and ensures the three runtime charts
require immutable image digests.

Local validation is offline and does not contact a registry or cluster:

```sh
node scripts/distribution-validation.mjs --name private-deployment --target .
```
