#!/usr/bin/env python3
"""Idempotently provision this installation; never print credentials or API bodies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('phase', choices=['prepare', 'domain', 'reconcile'])
args = parser.parse_args()
account = os.environ['CLOUDFLARE_ACCOUNT_ID']
token = os.environ['CLOUDFLARE_API_TOKEN']
project = os.environ.get('PAGES_PROJECT', 'uptimeflare-distributed')
database = os.environ.get('D1_DATABASE', 'uptimeflare-distributed-d1')
worker = os.environ.get('WORKER_NAME', 'uptimeflare-distributed')
snapshot_namespace = project + '-public-status'
schema_hash = hashlib.sha256(Path('init.sql').read_bytes()).hexdigest()
schema_state = Path('.deployment/schema-prepare.json')
for name in [project, database, worker]:
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,57}', name):
        raise SystemExit('Invalid deployment resource name')


def api(path, method='GET', body=None, missing=False):
    request = urllib.request.Request(
        'https://api.cloudflare.com/client/v4' + path,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404 and missing:
            return None
        raise SystemExit(f'Cloudflare {method} {path}: HTTP {error.code}') from None
    if not value.get('success'):
        codes = [error.get('code') for error in value.get('errors', [])]
        raise SystemExit(f'Cloudflare {method} {path}: error codes {codes}')
    return value['result']


# Provisioning never performs a data-format migration implicitly.
if os.environ.get('UNIFIED_DEPLOY_APPROVED') != '1':
    raise SystemExit('Unified deployment is disabled; complete backup/migration review before enabling UNIFIED_DEPLOY_APPROVED')

if args.phase in ('prepare', 'reconcile'):
    databases = api(f'/accounts/{account}/d1/database?per_page=1000')
    matches = [item for item in databases if item['name'] == database]
    if len(matches) > 1:
        raise SystemExit('Duplicate database names')
    db = matches[0] if matches else api(f'/accounts/{account}/d1/database', 'POST', {'name': database})
    database_id = db['uuid']
    if args.phase == 'reconcile':
        print('Unified producers update rollups transactionally; no full-history reconciliation required')
        raise SystemExit(0)
    if os.environ.get('D1_VERIFIED_SCHEMA_HASH') != schema_hash or os.environ.get('D1_VERIFIED_DATABASE_ID') != database_id:
        api(f'/accounts/{account}/d1/database/{database_id}/query', 'POST', {'sql': Path('init.sql').read_text(), 'params': []})
    storage_version = os.environ.get('STATE_STORAGE_VERSION', '1')
    if storage_version not in ('1', '2'):
        raise SystemExit('Unsupported storage version')
    if storage_version == '2':
        versions = api(f'/accounts/{account}/d1/database/{database_id}/query', 'POST', {'sql': 'SELECT version FROM storage_versions WHERE id=1', 'params': []})
        if not versions or not versions[0].get('results') or versions[0]['results'][0].get('version') != 2:
            raise SystemExit('Schema2 requires explicit validated migration, including for an empty installation')
    namespaces = api(f'/accounts/{account}/storage/kv/namespaces?per_page=1000')
    found = [item for item in namespaces if item['title'] == snapshot_namespace]
    if len(found) > 1:
        raise SystemExit('Duplicate public snapshot namespace names')
    namespace = found[0] if found else api(f'/accounts/{account}/storage/kv/namespaces', 'POST', {'title': snapshot_namespace})
    schema_state.parent.mkdir(exist_ok=True)
    schema_state.write_text(json.dumps({'database_id': database_id, 'schema_hash': schema_hash, 'version': storage_version}))
    # Paths are relative to worker/wrangler.deploy.json. Domain takeover is a separate explicit phase.
    Path('worker/wrangler.deploy.json').write_text(json.dumps({
        'name': worker, 'main': 'src/index.ts', 'account_id': account,
        'compatibility_date': '2025-04-02', 'compatibility_flags': ['nodejs_compat'],
        'assets': {'directory': '../out', 'binding': 'ASSETS', 'run_worker_first': True, 'not_found_handling': '404-page'},
        'd1_databases': [{'binding': 'UPTIMEFLARE_D1', 'database_name': database, 'database_id': database_id, 'migrations_dir': '../migrations'}],
        'kv_namespaces': [{'binding': 'UPTIMEFLARE_PUBLIC_KV', 'id': namespace['id']}],
        'durable_objects': {'bindings': [{'name': 'REMOTE_CHECKER_DO', 'class_name': 'RemoteChecker'}, {'name': 'COORDINATOR_DO', 'class_name': 'Coordinator'}]},
        'migrations': [{'tag': 'v1', 'new_sqlite_classes': ['RemoteChecker']}, {'tag': 'v2', 'new_sqlite_classes': ['Coordinator']}],
        'vars': {'STATE_STORAGE_VERSION': storage_version, 'METRICS_ENABLED': os.environ.get('METRICS_ENABLED', '0'), 'MIGRATION_MODE': os.environ.get('MIGRATION_MODE', '0')},
        'triggers': {'crons': ['* * * * *']}, 'observability': {'enabled': True},
    }, indent=2) + '\n')
    print(f'Prepared unified Worker {worker}, shared D1 and public KV (storage version {storage_version})')
else:
    domain = os.environ.get('STATUS_DOMAIN', '')
    if not domain:
        print('No custom domain configured; using workers.dev')
        raise SystemExit(0)
    zone_name = os.environ.get('DNS_ZONE', '')
    zones = api('/zones?name=' + urllib.parse.quote(zone_name))
    if len(zones) != 1 or zones[0]['account']['id'] != account:
        raise SystemExit('DNS zone does not uniquely belong to deployment account')
    zone = zones[0]['id']
    # Require deliberate removal of a previous Pages custom domain before changing its origin.
    pages_domains = api(f'/accounts/{account}/pages/projects/{project}/domains', missing=True) or []
    if any(item['name'] == domain for item in pages_domains):
        raise SystemExit('Remove the old Pages custom domain in the approved cutover window, then retry domain binding')
    existing = api(f'/accounts/{account}/workers/domains')
    conflicts = [item for item in existing if item.get('hostname') == domain and item.get('service') != worker]
    if conflicts:
        raise SystemExit('Custom domain belongs to another Worker; resolve the conflict first')
    api(f'/accounts/{account}/workers/domains', 'PUT', {'hostname': domain, 'service': worker, 'environment': 'production', 'zone_id': zone})
    print(f'Unified Worker custom domain configured: {domain}')
