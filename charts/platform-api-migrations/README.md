# Explicit Platform schema migration

This chart runs the existing `platform-api --migrate-only` command as a separate
Job. The command calls the authoritative embedded migrations and exits before
starting the API listener. It does not introduce a second migration mechanism.
The ordinary Platform API chart always uses `PLATFORM_API_SCHEMA_MODE=validate`
and never creates this Job or runs migrations in an init container.

Prepare a dedicated customer database-owner Secret and migration service account.
The owner DSN must have the database's approved migration privileges. Supplying a
different Secret name cannot prove different underlying database privileges; the
customer's database administrator owns that grant. The serving Secret must be a
separate reference and is never mounted or read by this Job.

Example operator values (replace the illustrative digest):

```yaml
image:
  repository: registry.customer.example/platform-api
  digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
migration:
  existingOwnerSecretName: platform-schema-owner
  existingRuntimeSecretName: platform-api-runtime
  ownerDatabaseURLKey: PLATFORM_API_DATABASE_URL
serviceAccount:
  name: platform-schema-migrator
```

Pin the same approved release image selected for the API. Provide customer TLS
files through `volumes` and `volumeMounts` if required by the owner DSN. Existing
registry credentials can be named through `imagePullSecrets`. There are no
vendor project, registry, database, or identity defaults.

Review the rendered Job, then submit it explicitly to the customer context:

```sh
helm template schema-v20260918 build/platform-api-migrations/chart \
  --namespace deixic --values customer-migration.yaml > migration-job.yaml
kubectl --context customer --namespace deixic create --filename migration-job.yaml
kubectl --context customer --namespace deixic wait \
  --for=condition=complete job/schema-v20260918-platform-api-migrations --timeout=600s
```

Use a distinct release name for a new approved attempt. A failed Job is retained
for inspection, has zero automatic retries, and never becomes install success.
The Job has a ten-minute active deadline and a one-day completion retention TTL
by default. A timeout requires investigation before another explicit attempt.
Migration success alone does not prove runtime readiness, restore compatibility,
mission completion, or safe rollback to an older application release.
