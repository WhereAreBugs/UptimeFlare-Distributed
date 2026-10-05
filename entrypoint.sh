#!/usr/bin/env bash
set -euo pipefail
umask 077

APP_DIR=${UPTIMEFLARE_APP_DIR:-/app}
STATE_DIR=${UPTIMEFLARE_STATE_DIR:-$APP_DIR/.wrangler/state}
WORKER_PORT=${UPTIMEFLARE_PORT:-8788}
LISTEN_IP=${UPTIMEFLARE_LISTEN_IP:-0.0.0.0}
LOCAL_PROTOCOL=${UPTIMEFLARE_LOCAL_PROTOCOL:-http}
RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/uptimeflare-runtime.XXXXXX")
CHILD_PIDS=()

cleanup() {
  trap - EXIT INT TERM
  for pid in "${CHILD_PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for ignored in 1 2 3 4 5; do
    active=false
    for pid in "${CHILD_PIDS[@]}"; do if kill -0 "$pid" 2>/dev/null; then active=true; fi; done
    if ! $active; then break; fi
    sleep 1
  done
  for pid in "${CHILD_PIDS[@]}"; do kill -KILL "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

export NEXT_TELEMETRY_DISABLED=1 WRANGLER_SEND_METRICS=false
export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false CLOUDFLARE_INCLUDE_PROCESS_ENV=false
export WRANGLER_LOG_PATH="$RUNTIME_DIR/wrangler.log"
export UPTIMEFLARE_APP_DIR="$APP_DIR" UPTIMEFLARE_RUNTIME_DIR="$RUNTIME_DIR"
export UPTIMEFLARE_WORKER_PORT="$WORKER_PORT" UPTIMEFLARE_LOCAL_PROTOCOL="$LOCAL_PROTOCOL"

# Local configs live beside an allowlisted, private .dev.vars file. No repository
# file or image layer receives runtime credentials, and no Cloudflare API token is loaded.
node <<'JS'
const fs = require('node:fs'); const path = require('node:path');
const app = path.resolve(process.env.UPTIMEFLARE_APP_DIR);
const runtime = process.env.UPTIMEFLARE_RUNTIME_DIR;
for (const name of ['UPTIMEFLARE_WORKER_PORT']) {
  const port=Number(process.env[name]); if (!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid local listen port');
}
if (!['http','https'].includes(process.env.UPTIMEFLARE_LOCAL_PROTOCOL)) throw new Error('Invalid local protocol');
const password=process.env.ADMIN_PASSWORD ?? ''; const session=process.env.ADMIN_SESSION_SECRET ?? '';
if (password.length<16 || session.length<32) throw new Error('ADMIN_PASSWORD must contain at least 16 characters; ADMIN_SESSION_SECRET at least 32');
let tokens={}; try {tokens=JSON.parse(process.env.PROBE_TOKENS || '{}')} catch {throw new Error('PROBE_TOKENS must be a JSON object')}
if (!tokens||typeof tokens!=='object'||Array.isArray(tokens)) throw new Error('PROBE_TOKENS must be a JSON object');
// Quoting follows Wrangler's dotenv parser without altering backslashes/Unicode.
function quote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Local secrets cannot contain line breaks or NUL');
  for (const delimiter of ["'",'`','"']) {
    if (!value.includes(delimiter) && (delimiter!=='"'||!value.includes('\\'))) return delimiter+value+delimiter;
  }
  throw new Error('Local administrator secrets require a dotenv-safe quote; use openssl rand -hex 32');
}
const registry=JSON.stringify(tokens).replace(/'/g,'\\u0027');
const lines={PROBE_TOKENS:registry,ADMIN_PASSWORD:password,ADMIN_SESSION_SECRET:session};
fs.writeFileSync(path.join(runtime,'.dev.vars'),Object.entries(lines).map(([key,value])=>`${key}=${quote(value)}`).join('\n')+'\n',{mode:0o600});
const version=process.env.UPTIMEFLARE_STATE_VERSION ?? '2'; if (version!=='2') throw new Error('Only storage version 2 is supported; migrate an existing legacy volume before starting');
const common={compatibility_date:'2025-04-02',compatibility_flags:['nodejs_compat'],d1_databases:[{binding:'UPTIMEFLARE_D1',database_name:'uptimeflare_d1',database_id:'00000000-0000-0000-0000-000000000000'}]};
fs.writeFileSync(path.join(runtime,'worker.json'),JSON.stringify({...common,name:'uptimeflare-local',main:path.join(app,'worker/src/index.ts'),assets:{directory:path.join(app,'out'),binding:'ASSETS',run_worker_first:true,not_found_handling:'404-page'},kv_namespaces:[{binding:'UPTIMEFLARE_PUBLIC_KV',id:'00000000000000000000000000000001'}],durable_objects:{bindings:[{name:'REMOTE_CHECKER_DO',class_name:'RemoteChecker'},{name:'COORDINATOR_DO',class_name:'Coordinator'}]},migrations:[{tag:'v1',new_sqlite_classes:['RemoteChecker']},{tag:'v2',new_sqlite_classes:['Coordinator']}],vars:{STATE_STORAGE_VERSION:version,METRICS_ENABLED:'0'},triggers:{crons:['* * * * *']}}));
// A missing marker is safe to initialize only when every data table is empty.
const tables=[...fs.readFileSync(path.join(app,'init.sql'),'utf8').matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map(x=>x[1]);
const emptyChecks=[...new Set(tables)].filter(x=>x!=='storage_versions').map(x=>`AND NOT EXISTS(SELECT 1 FROM ${x})`).join('\n');
fs.writeFileSync(path.join(runtime,'initialize-version.sql'),`INSERT INTO storage_versions(id,version,migrated_at)
SELECT 1,2,unixepoch() WHERE NOT EXISTS(SELECT 1 FROM storage_versions)
${emptyChecks};
SELECT version FROM storage_versions WHERE id=1;`);
JS

mkdir -p "$STATE_DIR"
STATE_DIR=$(cd "$STATE_DIR" && pwd)
WRANGLER="$APP_DIR/node_modules/wrangler/bin/wrangler.js"
if [[ ! -f "$APP_DIR/out/index.html" || ! -f "$WRANGLER" ]]; then
  echo "Build static assets and install dependencies before starting local deployment." >&2
  exit 1
fi

echo "Initializing local shared D1 schema..."
node "$WRANGLER" d1 execute uptimeflare_d1 --config "$RUNTIME_DIR/worker.json" --local --persist-to "$STATE_DIR" --file "$APP_DIR/init.sql" --yes --json >/dev/null
node "$WRANGLER" d1 execute uptimeflare_d1 --config "$RUNTIME_DIR/worker.json" --local --persist-to "$STATE_DIR" --file "$RUNTIME_DIR/initialize-version.sql" --yes --json >"$RUNTIME_DIR/storage-version.json"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.some(x=>x.results?.some(y=>y.version===2)))throw new Error("Local database requires a validated state-v2 migration; no legacy producer was started")' "$RUNTIME_DIR/storage-version.json"

echo "Starting local unified Worker..."
(cd "$APP_DIR/worker" && exec node "$WRANGLER" dev --config "$RUNTIME_DIR/worker.json" --local --test-scheduled --persist-to "$STATE_DIR" --ip "$LISTEN_IP" --port "$WORKER_PORT" --inspector-port 0 --local-protocol "$LOCAL_PROTOCOL" --log-level error) &
CHILD_PIDS+=("$!")

CURL_COMMAND=(curl)
if [[ "$LOCAL_PROTOCOL" == https ]]; then CURL_COMMAND+=(-k); fi
WORKER_URL="$LOCAL_PROTOCOL://127.0.0.1:$WORKER_PORT"
ready=false
for ignored in $(seq 1 60); do
  for pid in "${CHILD_PIDS[@]}"; do if ! kill -0 "$pid" 2>/dev/null; then echo "A local runtime exited during startup." >&2; exit 1; fi; done
  worker_status=$("${CURL_COMMAND[@]}" -s -o /dev/null -w '%{http_code}' --max-time 2 "$WORKER_URL/api/admin/config" || true)
  if [[ "$worker_status" == 401 ]]; then ready=true; break; fi
  sleep 1
 done
if ! $ready; then echo "Local runtimes did not become ready within 60 attempts." >&2; exit 1; fi

echo "Unified Worker ready on port $WORKER_PORT; D1 persisted at $STATE_DIR"
# One sequential loop awaits each scheduled invocation before the next minute.
# There is no cron daemon and no overlapping curl process.
schedule_loop() (
  trap - EXIT
  task_pid=''
  trap 'if [[ -n "$task_pid" ]]; then kill -TERM "$task_pid" 2>/dev/null || true; wait "$task_pid" 2>/dev/null || true; fi; exit 0' INT TERM
  while true; do
    "${CURL_COMMAND[@]}" --fail --silent --show-error --connect-timeout 2 --max-time 900 "$WORKER_URL/__scheduled" >/dev/null &
    task_pid=$!
    if ! wait "$task_pid"; then echo "Local scheduled invocation failed; retrying at the next minute." >&2; fi
    sleep "$((60-$(date +%s)%60))" &
    task_pid=$!
    wait "$task_pid"
  done
)
schedule_loop &
CHILD_PIDS+=("$!")

while true; do
  for pid in "${CHILD_PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "A local runtime exited; stopping the remaining processes." >&2
      exit 1
    fi
  done
  sleep 2
done
