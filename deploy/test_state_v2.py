import copy
import gzip
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
import state_v2 as migration

NOW=1700000000
STATE={'lastUpdate':NOW,'overallUp':0,'overallDown':1,'incident':{'web':[{'start':[NOW-300], 'end':NOW-300,'error':['dummy']},{'start':[NOW-120,NOW-60],'end':None,'error':['[tcp/refused] TCP connection was refused','[dns/not_found] DNS name was not found']}]},'latency':{'web':[{'time':NOW-120,'ping':0,'loc':'SIN'},{'time':NOW-60,'ping':12,'loc':'SIN'},{'time':NOW,'ping':6,'loc':'NRT'}]}}
class MigrationTests(unittest.TestCase):
 def test_probe_only_installation_without_native_state_preserves_complete_history(self):
  db=sqlite3.connect(':memory:');db.executescript((Path(__file__).resolve().parents[1]/'init.sql').read_text())
  db.execute("INSERT INTO probe_samples VALUES('a','web',?,1,7,'','','')",(NOW,));db.commit()
  self.assertEqual(migration.decode_state(None),{'lastUpdate':0,'incident':{},'latency':{}})
  self.assertTrue(migration.migrate(db)['migrated'])
  self.assertEqual(db.execute('SELECT COUNT(*) FROM native_hot').fetchone()[0],0)
  self.assertEqual(sum(len(json.loads(r[0])) for r in db.execute('SELECT value FROM probe_result_blocks')),1)
  self.assertTrue(migration.migrate(db)['alreadyMigrated'])
 def database(self):
  db=sqlite3.connect(':memory:');db.executescript((Path(__file__).resolve().parents[1]/'init.sql').read_text())
  db.execute("INSERT INTO uptimeflare VALUES('state',?)",(migration.compact(STATE),))
  db.execute("INSERT INTO probe_samples VALUES('a','web',?,0,0,'tcp','refused','private-detail')",(NOW,));db.commit();return db
 def test_compressed_roundtrip_and_rle_validation(self):
  compact=migration.compact(STATE)
  expected=migration.decode_state(json.dumps(STATE))
  self.assertEqual(migration.decode_state(compact),expected)
  self.assertEqual(migration.decode_state(gzip.compress(compact.encode())),expected)
  bad=json.loads(compact);bad['latency']['web']['loc']['c']=[1000000000]
  with self.assertRaises(ValueError):migration.decode_state(json.dumps(bad))
  bad=json.loads(compact);bad['incident']['web']['end']=[]
  with self.assertRaises(ValueError):migration.decode_state(json.dumps(bad))
 def test_dry_run_failure_atomicity_repeat_and_complete_semantics(self):
  db=self.database();before=list(db.iterdump())
  self.assertEqual(migration.migrate(db,True)['hotRows'],1)
  self.assertEqual(list(db.iterdump()),before)
  with self.assertRaises(ValueError):migration.migrate(db,fail_after=2)
  self.assertEqual(db.execute('SELECT COUNT(*) FROM native_hot').fetchone()[0],0)
  self.assertTrue(migration.migrate(db)['migrated'])
  self.assertTrue(migration.migrate(db)['alreadyMigrated'])
  self.assertEqual(migration.reconstruct(db,migration.decode_state(migration.compact(STATE))),migration.decode_state(json.dumps(STATE)))
  self.assertTrue(migration.rollback(db)['rolledBack'])
  self.assertEqual(migration.decode_state(db.execute("SELECT value FROM uptimeflare WHERE key='state'").fetchone()[0]),migration.decode_state(json.dumps(STATE)))
  self.assertTrue(migration.migrate(db)['migrated'])
 def test_full_backup_restore_preserves_private_config_and_notifications(self):
  db=self.database();db.execute("INSERT INTO admin_config VALUES(1,3,?,?)",('{"fixtureSecret":"dummy-private"}',NOW));db.commit()
  backup=sqlite3.connect(':memory:');db.backup(backup)
  original=list(backup.iterdump());migration.migrate(db);db.execute('DELETE FROM admin_config');db.commit();backup.backup(db)
  self.assertEqual(list(db.iterdump()),original)
 def test_unknown_version_and_destination_drift_stop(self):
  db=self.database();db.execute('INSERT INTO storage_versions VALUES(1,99,0)');db.commit()
  with self.assertRaises(ValueError):migration.migrate(db)
  db.execute('DELETE FROM storage_versions');db.execute("INSERT INTO native_hot VALUES('unknown',1,1,1,'SIN','',NULL,1,0)");db.commit()
  with self.assertRaises(ValueError):migration.migrate(db)
 def test_expired_or_replaced_lease_cannot_renew(self):
  db=self.database();db.execute("INSERT INTO migration_runs VALUES('state-v2','other',1,'hash','running',2)");db.commit()
  with self.assertRaises(ValueError):migration.renew(db,'owner')
if __name__=='__main__':unittest.main()

class ArchiveTests(unittest.TestCase):
 def test_bounded_archive_excludes_open_incidents_and_never_changes_source(self):
  import archive_v2
  with tempfile.TemporaryDirectory() as temp:
   database=Path(temp)/'fixture.sqlite';db=sqlite3.connect(database);db.executescript((Path(__file__).resolve().parents[1]/'init.sql').read_text())
   db.execute("INSERT INTO native_incidents VALUES('open',1,NULL)");db.execute("INSERT INTO native_incidents VALUES('closed',1,2)")
   db.execute("INSERT INTO native_incident_reasons VALUES('open',1,1,'private')");db.execute("INSERT INTO native_incident_reasons VALUES('closed',1,1,'reason')");db.commit()
   before=list(db.iterdump());output=Path(temp)/'archive.gz'
   result=archive_v2.archive(database,output,1000)
   self.assertEqual(result['rows'],2);self.assertFalse(result['sourceModified']);self.assertEqual(list(db.iterdump()),before)
   with gzip.open(output,'rt') as stream:rows=[json.loads(line) for line in stream]
   self.assertTrue(all(row['row'][0]=='closed' for row in rows))
