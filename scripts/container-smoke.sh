#!/usr/bin/env bash
set -euo pipefail
: "${IMAGE:=sms-code-relay:local}"
container_id="$(docker run --rm -d -e GOOGLE_CLOUD_PROJECT=demo-sms-relay -p 127.0.0.1::8080 "$IMAGE")"
trap 'docker stop "$container_id" >/dev/null 2>&1 || true' EXIT
port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}' "$container_id")"
health="$(curl --retry 10 --retry-all-errors --retry-connrefused --retry-delay 1 --silent --show-error --fail "http://127.0.0.1:$port/health")"
[[ "$health" == '{"ok":true}' ]]
status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/v1/devices")"
[[ "$status" == 401 ]]
printf 'Container startup, health, and authentication smoke passed.\n'
