#!/usr/bin/env python3
"""Idempotently provision this installation; never print credentials or API bodies."""
import argparse
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('phase', choices=['prepare', 'domain'])
args = parser.parse_args()
account = os.environ['CLOUDFLARE_ACCOUNT_ID']
token = os.environ['CLOUDFLARE_API_TOKEN']
project = os.environ.get('PAGES_PROJECT', 'uptimeflare-distributed')
database = os.environ.get('D1_DATABASE', 'uptimeflare-distributed-d1')
worker = os.environ.get('WORKER_NAME', 'uptimeflare-distributed-worker')
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


if args.phase == 'prepare':
    databases = api(f'/accounts/{account}/d1/database?per_page=1000')
    matches = [item for item in databases if item['name'] == database]
    if len(matches) > 1:
        raise SystemExit('Duplicate database names')
    db = matches[0] if matches else api(f'/accounts/{account}/d1/database', 'POST', {'name': database})
    database_id = db['uuid']
    api(f'/accounts/{account}/d1/database/{database_id}/query', 'POST', {'sql': Path('init.sql').read_text(), 'params': []})
    secret_bindings = {}
    for key in ['PROBE_TOKENS', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET']:
        value = os.environ.get(key)
        if not value:
            raise SystemExit(f'Missing {key}')
        secret_bindings[key] = {'type': 'secret_text', 'value': value}
    config = {
        'compatibility_date': '2025-04-02',
        'compatibility_flags': ['nodejs_compat'],
        'd1_databases': {'UPTIMEFLARE_D1': {'id': database_id}},
        'env_vars': secret_bindings,
    }
    path = f'/accounts/{account}/pages/projects/{project}'
    existing = api(path, missing=True)
    if existing:
        api(path, 'PATCH', {'deployment_configs': {'production': config}})
    else:
        api(f'/accounts/{account}/pages/projects', 'POST', {
            'name': project, 'production_branch': 'main',
            'deployment_configs': {'production': config},
        })
    Path('worker/wrangler.deploy.json').write_text(json.dumps({
        'name': worker, 'main': 'src/index.ts', 'account_id': account,
        'compatibility_date': '2025-04-02', 'compatibility_flags': ['nodejs_compat'],
        'd1_databases': [{'binding': 'UPTIMEFLARE_D1', 'database_name': database, 'database_id': database_id, 'migrations_dir': '../migrations'}],
        'durable_objects': {'bindings': [{'name': 'REMOTE_CHECKER_DO', 'class_name': 'RemoteChecker'}]},
        'migrations': [{'tag': 'v1', 'new_sqlite_classes': ['RemoteChecker']}],
        'triggers': {'crons': ['* * * * *']},
        'observability': {'enabled': True},
    }, indent=2) + '\n')
    print(f'Prepared D1 {database} and Pages {project}')
else:
    domain = os.environ.get('STATUS_DOMAIN', '')
    if not domain:
        print('No custom domain configured; using pages.dev')
        raise SystemExit(0)
    path = f'/accounts/{account}/pages/projects/{project}/domains'
    if not any(item['name'] == domain for item in api(path)):
        api(path, 'POST', {'name': domain})
    zone_name = os.environ.get('DNS_ZONE', '')
    if zone_name:
        zones = api('/zones?name=' + urllib.parse.quote(zone_name))
        if len(zones) != 1 or zones[0]['account']['id'] != account:
            raise SystemExit('DNS zone does not uniquely belong to deployment account')
        zone = zones[0]['id']
        records = api(f'/zones/{zone}/dns_records?name=' + urllib.parse.quote(domain))
        target = project + '.pages.dev'
        if not records:
            api(f'/zones/{zone}/dns_records', 'POST', {'type': 'CNAME', 'name': domain, 'content': target, 'proxied': True, 'ttl': 1})
        elif len(records) != 1 or records[0]['type'] != 'CNAME' or records[0]['content'] != target:
            raise SystemExit('Existing DNS record points elsewhere; resolve the conflict before deployment')
    print(f'Custom domain configured: {domain}')
