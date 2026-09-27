#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
if command -v docker >/dev/null 2>&1; then
  docker_bin="$(command -v docker)"
elif [[ -x "${HOME}/Applications/Docker.app/Contents/Resources/bin/docker" ]]; then
  docker_bin="${HOME}/Applications/Docker.app/Contents/Resources/bin/docker"
  if [[ -S "${HOME}/.docker/run/docker.sock" ]]; then
    export DOCKER_HOST="unix://${HOME}/.docker/run/docker.sock"
  fi
else
  echo 'Docker Desktop is required for the local restore rehearsal.' >&2
  exit 1
fi

compose() { "${docker_bin}" compose "$@"; }
compose up -d --wait postgres >/dev/null

run_id="$(openssl rand -hex 6)"
source_db="pss_dr_source_${run_id}"
restored_db="pss_dr_restored_${run_id}"
cleanup() {
  compose exec -T postgres dropdb -U pss_local --if-exists --force "$restored_db" >/dev/null 2>&1 || true
  compose exec -T postgres dropdb -U pss_local --if-exists --force "$source_db" >/dev/null 2>&1 || true
}
trap cleanup EXIT

compose exec -T postgres createdb -U pss_local "$source_db"
compose exec -T postgres createdb -U pss_local "$restored_db"
source_url="postgresql://pss_local:pss_local_only@127.0.0.1:5432/${source_db}"
DATABASE_URL="$source_url" pnpm --filter @pss/audit db:migrate >/dev/null
DATABASE_URL="$source_url" pnpm --filter @pss/platform db:migrate >/dev/null
DATABASE_URL="$source_url" pnpm --filter @pss/identity db:migrate >/dev/null

compose exec -T postgres psql -U pss_local -d "$source_db" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO identity.user_account (id, organization_id, idp_subject, display_name, status)
VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
        'restore-rehearsal-subject', 'Synthetic Restore Probe', 'ACTIVE');

INSERT INTO audit.audit_entry (
  id, organization_id, actor_service_identity, action, entity_domain,
  entity_type, entity_id, entity_version, changes, request_id,
  correlation_id, source
) VALUES (
  '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
  'local_restore_rehearsal', 'IDENTITY_PROBE_CREATED', 'identity',
  'User', '22222222-2222-4222-8222-222222222222', 1, '[]',
  'local-restore-rehearsal', 'local-restore-rehearsal', 'SYSTEM'
);

INSERT INTO platform.outbox_event (
  event_id, event_type, aggregate_type, aggregate_id, aggregate_version, envelope
) VALUES (
  '0195a843-6abc-7000-8000-000000000777', 'DELIVERY_ORDER_CLOSED',
  'DeliveryOrder', '44444444-4444-4444-8444-444444444444', 1,
  '{"eventId":"0195a843-6abc-7000-8000-000000000777","eventType":"DELIVERY_ORDER_CLOSED","eventVersion":1,"occurredAt":"2026-09-27T00:00:00.000Z","businessDate":"2026-09-27","organizationId":"11111111-1111-4111-8111-111111111111","aggregateType":"DeliveryOrder","aggregateId":"44444444-4444-4444-8444-444444444444","aggregateVersion":1,"producer":"fulfillment","correlationId":"local-restore-rehearsal","causationId":"local-restore-rehearsal","payload":{"doId":"44444444-4444-4444-8444-444444444444"}}'::jsonb
);
SQL

compose exec -T postgres pg_dump -U pss_local --format=custom --no-owner --no-acl "$source_db" |
  compose exec -T postgres pg_restore -U pss_local --no-owner --no-acl --dbname="$restored_db"

verification_sql="SELECT (SELECT count(*) FROM identity.user_account)::text || ':' ||
  (SELECT count(*) FROM audit.audit_entry)::text || ':' ||
  (SELECT count(*) FROM platform.outbox_event)::text || ':' ||
  (SELECT idp_subject FROM identity.user_account LIMIT 1) || ':' ||
  (SELECT event_id::text FROM platform.outbox_event LIMIT 1)"
source_signature="$(compose exec -T postgres psql -U pss_local -d "$source_db" -At -c "$verification_sql")"
restored_signature="$(compose exec -T postgres psql -U pss_local -d "$restored_db" -At -c "$verification_sql")"
if [[ "$source_signature" != "$restored_signature" || "$restored_signature" != '1:1:1:restore-rehearsal-subject:0195a843-6abc-7000-8000-000000000777' ]]; then
  echo 'Local restore rehearsal failed: schema or synthetic records differ.' >&2
  exit 1
fi

echo 'PLT-012 local restore rehearsal passed: identity, audit, and outbox records restored to an isolated database.'
echo 'This does not test PITR, managed backup retention, finance invariants, or production restore approval.'
