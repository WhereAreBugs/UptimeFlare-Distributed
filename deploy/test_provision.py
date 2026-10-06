"""Deployment boundaries: fresh v2, explicit legacy rejection, and frozen Cron."""
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = (ROOT / 'init.sql').read_text()
DATABASE_ID = '00000000-1111-2222-3333-444444444444'


class ProvisionTests(unittest.TestCase):
    def run_prepare(self, *, fresh=False, version=2, overrides=None):
        calls = []

        def response(request, **unused):
            path = request.full_url.removeprefix('https://api.cloudflare.com/client/v4')
            body = json.loads(request.data) if request.data else None
            calls.append((request.method, path, body))
            if path.endswith('/d1/database?per_page=1000'):
                result = [] if fresh else [{'name': 'uptimeflare-distributed-d1', 'uuid': DATABASE_ID}]
            elif path.endswith('/d1/database') and request.method == 'POST':
                result = {'uuid': DATABASE_ID}
            elif path.endswith('/query'):
                result = [{'results': [] if version is None else [{'version': version}]}] if body['sql'].startswith('SELECT version') else []
            elif path.endswith('/storage/kv/namespaces?per_page=1000'):
                result = [{'title': 'uptimeflare-distributed-public-status', 'id': 'test-kv'}]
            else:
                raise AssertionError('Unexpected resource operation: ' + path)
            return io.BytesIO(json.dumps({'success': True, 'result': result}).encode())

        env = {'CLOUDFLARE_ACCOUNT_ID': 'test-account', 'CLOUDFLARE_API_TOKEN': 'dummy', 'UNIFIED_DEPLOY_APPROVED': '1'}
        env.update(overrides or {})
        with tempfile.TemporaryDirectory() as directory:
            previous = Path.cwd()
            try:
                os.chdir(directory)
                Path('worker').mkdir()
                Path('init.sql').write_text(SCHEMA)
                with patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', ['provision.py', 'prepare']), patch('urllib.request.urlopen', response), patch('sys.stdout', io.StringIO()):
                    try:
                        runpy.run_path(str(ROOT / 'deploy/provision.py'), run_name='__main__')
                    except SystemExit as error:
                        return calls, None, str(error)
                return calls, json.loads(Path('worker/wrangler.deploy.json').read_text()), None
            finally:
                os.chdir(previous)

    def test_fresh_database_is_initialized_as_v2_without_pages(self):
        calls, config, error = self.run_prepare(fresh=True)
        self.assertIsNone(error)
        initialization = [body['sql'] for method, path, body in calls if path.endswith('/query') and not body['sql'].startswith('SELECT')]
        self.assertEqual(len(initialization), 1)
        self.assertIn('INSERT INTO storage_versions(id,version,migrated_at) VALUES(1,2,unixepoch())', initialization[0])
        self.assertEqual(config['vars']['STATE_STORAGE_VERSION'], '2')
        self.assertEqual(config['vars']['PACKED_PROBE_COUNTERS'], '1')
        self.assertFalse(any('/pages/' in path for _, path, _ in calls))

    def test_existing_legacy_or_unmarked_database_is_not_relabelled(self):
        for version in [1, None]:
            with self.subTest(version=version):
                calls, config, error = self.run_prepare(version=version)
                self.assertIsNone(config)
                self.assertIn('validated state-v2 migration', error)
                self.assertFalse(any('INSERT INTO storage_versions' in (body or {}).get('sql', '') for _, _, body in calls))

    def test_explicit_legacy_deployment_fails_before_cloud_mutation(self):
        calls, config, error = self.run_prepare(overrides={'STATE_STORAGE_VERSION': '1'})
        self.assertEqual(calls, [])
        self.assertIsNone(config)
        self.assertIn('only supports storage version 2', error)

    def test_verified_schema_skips_ddl_but_checks_version_and_keeps_cron_off(self):
        calls, config, error = self.run_prepare(overrides={'D1_VERIFIED_SCHEMA_HASH': hashlib.sha256(SCHEMA.encode()).hexdigest(), 'D1_VERIFIED_DATABASE_ID': DATABASE_ID, 'CRON_ENABLED': '0'})
        self.assertIsNone(error)
        queries = [body['sql'] for _, path, body in calls if path.endswith('/query')]
        self.assertEqual(queries, ['SELECT version FROM storage_versions WHERE id=1'])
        self.assertEqual(config['triggers']['crons'], [])
        self.assertEqual(config['vars']['STATE_STORAGE_VERSION'], '2')


if __name__ == '__main__':
    unittest.main()


class TelemetryProvisionTests(ProvisionTests):
    def test_telemetry_is_opt_in_and_does_not_create_storage(self):
        calls, config, error = self.run_prepare(overrides={'TELEMETRY_ENABLED':'1','OTEL_EXPORTER_OTLP_ENDPOINT':'https://collector.invalid/api/default','OTEL_TRACES_SAMPLER_ARG':'0.1','GITHUB_SHA':'fixture-sha','CF_OTEL_TRACES_DESTINATION':'fixture-traces'})
        self.assertIsNone(error)
        self.assertEqual(config['vars']['TELEMETRY_ENABLED'],'1')
        self.assertEqual(config['vars']['OTEL_SERVICE_VERSION'],'fixture-sha')
        self.assertNotIn('OTEL_EXPORTER_OTLP_HEADERS',config['vars'])
        self.assertFalse(config['observability']['traces']['persist'])
        self.assertEqual(config['observability']['traces']['destinations'],['fixture-traces'])
        self.assertFalse(any('/observability/' in path for _,path,_ in calls))
        _, disabled, _ = self.run_prepare(overrides={'CF_OTEL_TRACES_DESTINATION':'fixture-traces'})
        self.assertNotIn('traces',disabled['observability'])
