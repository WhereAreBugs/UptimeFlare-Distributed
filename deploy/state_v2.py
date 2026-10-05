#!/usr/bin/env python3
"""Offline, validated SQLite migration. Never prints row values or private configuration.
Pause writers and take an independent D1 backup before exporting/restoring a production database.
"""
import argparse
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import struct
import time
import uuid

MAX_STATE_BYTES = 32 * 1024 * 1024
SCHEMA = Path(__file__).resolve().parents[1] / 'migrations/0008_state_v2.sql'

def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

def stamp(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 4102444800:
        raise ValueError('Invalid timestamp')
    return value

def decode_state(value):
    if value is None:
        return {'lastUpdate': 0, 'incident': {}, 'latency': {}}
    if isinstance(value, bytes):
        if value.startswith(b'\x1f\x8b'):
            import io
            with gzip.GzipFile(fileobj=io.BytesIO(value)) as stream:
                value = stream.read(MAX_STATE_BYTES + 1)
        if len(value) > MAX_STATE_BYTES:
            raise ValueError('State byte budget exceeded')
        value = value.decode('utf-8')
    if len(value.encode('utf-8')) > MAX_STATE_BYTES:
        raise ValueError('State byte budget exceeded')
    state = json.loads(value)
    if not isinstance(state, dict) or set(state) - {'lastUpdate','overallUp','overallDown','incident','latency'}:
        raise ValueError('Unknown legacy state shape')
    stamp(state['lastUpdate'])
    if not isinstance(state['incident'], dict) or not isinstance(state['latency'], dict):
        raise ValueError('Invalid state maps')
    result = {'lastUpdate': state['lastUpdate'], 'incident': {}, 'latency': {}}
    for monitor, values in state['incident'].items():
        if isinstance(values, dict):
            if set(values) != {'start','end','error'} or len(values['start']) != len(values['end']) or len(values['start']) != len(values['error']):
                raise ValueError('Invalid incident columns')
            values = [dict(start=start,end=end,error=error) for start,end,error in zip(values['start'],values['end'],values['error'])]
        if not isinstance(values, list):
            raise ValueError('Invalid incident array')
        previous_end = -1
        for incident in values:
            starts, errors = incident['start'], incident['error']
            if not starts or len(starts) != len(errors) or any(not isinstance(e,str) for e in errors):
                raise ValueError('Invalid incident reason arrays')
            for value in starts: stamp(value)
            if starts != sorted(set(starts)) or starts[0] < previous_end:
                raise ValueError('Overlapping/unsorted incidents')
            end = incident.get('end')
            if end is not None and stamp(end) < starts[-1]:
                raise ValueError('Invalid incident end')
            if previous_end == 4102444801:
                raise ValueError('Incident follows an open incident')
            previous_end = end if end is not None else 4102444801
        result['incident'][monitor] = values
    for monitor, values in state['latency'].items():
        if isinstance(values, dict):
            if set(values) != {'time','ping','loc'} or not isinstance(values['loc'],dict):
                raise ValueError('Unknown compacted latency format')
            raw_time = bytes.fromhex(values['time']); raw_ping = bytes.fromhex(values['ping'])
            if len(raw_time)%4 or len(raw_ping)%2 or len(raw_time)//4 != len(raw_ping)//2:
                raise ValueError('Invalid compressed numeric arrays')
            times = [v[0] for v in struct.iter_unpack('<I',raw_time)]
            pings = [v[0] for v in struct.iter_unpack('<H',raw_ping)]
            counts, labels = values['loc']['c'], values['loc']['v']
            if len(counts)!=len(labels) or any(isinstance(c,bool) or not isinstance(c,int) or c<=0 for c in counts) or sum(counts)!=len(times) or any(not isinstance(v,str) for v in labels):
                raise ValueError('Invalid location RLE')
            locations = [label for label,count in zip(labels,counts) for _ in range(count)]
            values = [dict(time=t,ping=p,loc=l) for t,p,l in zip(times,pings,locations)]
        if not isinstance(values,list) or len(values)>100000:
            raise ValueError('Latency array budget exceeded')
        previous = -1
        for sample in values:
            stamp(sample['time'])
            if sample['time']<=previous or not isinstance(sample['loc'],str) or isinstance(sample['ping'],bool) or not isinstance(sample['ping'],(int,float)) or not 0<=sample['ping']<=300000:
                raise ValueError('Invalid/unsorted latency sample')
            previous = sample['time']
        result['latency'][monitor] = values
    return result

def compact(state):
    result = dict(lastUpdate=state['lastUpdate'],overallUp=0,overallDown=0,incident={},latency={})
    for monitor, episodes in state['incident'].items():
        result['incident'][monitor] = {k:[e.get(k) for e in episodes] for k in ['start','end','error']}
    for monitor, samples in state['latency'].items():
        labels, counts = [], []
        for sample in samples:
            if labels and labels[-1] == sample['loc']: counts[-1] += 1
            else: labels.append(sample['loc']); counts.append(1)
        result['latency'][monitor] = dict(time=b''.join(struct.pack('<I',s['time']) for s in samples).hex(),ping=b''.join(struct.pack('<H',min(65535,round(s['ping']))) for s in samples).hex(),loc={'v':labels,'c':counts})
    return encode(result)

def semantic_hash(state):
    return hashlib.sha256(encode(state).encode()).hexdigest()

def plan_native(state):
    hot, incidents, reasons, blocks = [], [], [], []
    for monitor in sorted(set(state['latency'])|set(state['incident'])):
        samples=state['latency'].get(monitor,[]);episodes=state['incident'].get(monitor,[])
        real=[e for e in episodes if e['error'][0]!='dummy']
        if samples:
            latest=samples[-1];opened=real[-1] if real and real[-1]['end'] is None else None
            first=episodes[0]['start'][0] if episodes else samples[0]['time']
            hot.append((monitor,latest['time'],0 if opened else 1,latest['ping'],latest['loc'],opened['error'][-1] if opened else '',opened['start'][0] if opened else None,first,0))
        for episode in real:
            incidents.append((monitor,episode['start'][0],episode.get('end')))
            reasons += [(monitor,episode['start'][0],t,e) for t,e in zip(episode['start'],episode['error'])]
        windows={}
        for sample in samples: windows.setdefault(sample['time']//300*300,[]).append(sample)
        for window,values in windows.items():
            if len(encode(values).encode())>32768: raise ValueError('Legacy native window exceeds capacity')
            blocks.append((monitor,window,encode(values)))
    return hot,incidents,reasons,blocks

def reconstruct(db,anchor):
    state={'lastUpdate':anchor['lastUpdate'],'incident':{},'latency':{}}
    for row in db.execute('SELECT monitor_id,value FROM native_latency_blocks ORDER BY monitor_id,window'):
        state['latency'].setdefault(row[0],[]).extend(json.loads(row[1]))
    for monitor,first_seen in db.execute('SELECT monitor_id,first_seen FROM native_hot'):
        if monitor not in anchor['incident']:
            state['incident'][monitor]=[dict(start=[first_seen],end=first_seen,error=['dummy'])]
    for monitor,episodes in anchor['incident'].items():
        state['incident'][monitor]=[e for e in episodes if e['error'][0]=='dummy']
    for monitor,start,end in db.execute('SELECT monitor_id,start,end FROM native_incidents ORDER BY monitor_id,start'):
        changes=list(db.execute('SELECT time,error FROM native_incident_reasons WHERE monitor_id=? AND incident_start=? ORDER BY time',(monitor,start)))
        state['incident'].setdefault(monitor,[]).append(dict(start=[r[0] for r in changes],end=end,error=[r[1] for r in changes]))
    for monitor in anchor['latency']: state['latency'].setdefault(monitor,[])
    for monitor in anchor['incident']: state['incident'].setdefault(monitor,[])
    state['lastUpdate']=max([state['lastUpdate']]+[s['time'] for values in state['latency'].values() for s in values])
    return state

def pack_probes(db):
    from itertools import groupby
    rows=db.execute('SELECT s.*,d.details FROM probe_samples s LEFT JOIN probe_sample_details d USING(probe_id,monitor_id,time) ORDER BY probe_id,CAST(time/300 AS INTEGER),monitor_id,time')
    for (probe,window),values in groupby(rows,key=lambda r:(r[0],r[2]//300*300)):
        chunk,block=0,[]
        for row in values:
            stamp(row[2])
            if row[3] not in (0,1) or isinstance(row[4],bool) or not isinstance(row[4],(int,float)) or not math.isfinite(row[4]) or not 0<=row[4]<=300000:raise ValueError('Invalid legacy probe sample')
            if any(not isinstance(row[i],str) for i in (1,5,6,7)):raise ValueError('Invalid legacy probe fields')
            sample=dict(monitor_id=row[1],time=row[2],up=bool(row[3]),latency_ms=row[4],stage=row[5],code=row[6],message=row[7])
            if row[8]:
                metadata=json.loads(row[8]); mapping={'certificateExpiresAt':'certificate_expires_at','certificateDaysRemaining':'certificate_days_remaining','icmpLatencyMs':'icmp_latency_ms'}
                for name,value in metadata.items():
                    if name not in mapping: raise ValueError('Unknown sparse sample metadata')
                    sample[mapping[name]]=value
            if len(encode([sample]).encode())>32768:raise ValueError('Legacy sample exceeds block budget')
            if block and (len(block)>=40 or len(encode(block+[sample]).encode())>32768):
                yield probe,window,chunk,encode(block);chunk+=1;block=[]
                if chunk>=128:raise ValueError('Legacy window exceeds chunk budget')
            block.append(sample)
        if block: yield probe,window,chunk,encode(block)

def migrate(db,dry_run=False,fail_after=None):
    # All local conversion and semantic verification occur under one write transaction.
    has_version=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_versions'").fetchone()
    version=db.execute('SELECT version FROM storage_versions WHERE id=1').fetchone() if has_version else None
    if version and version[0] not in (1,2):raise ValueError('Unknown schema version')
    if version and version[0]==2:
        completed=db.execute("SELECT source_hash,status FROM migration_runs WHERE name='state-v2'").fetchone()
        if not completed or completed[1]!='complete':raise ValueError('Unexplained migrated state')
        return {'alreadyMigrated':True}
    source=db.execute("SELECT value FROM uptimeflare WHERE key='state'").fetchone()
    state=decode_state(source[0] if source else None);hash_value=semantic_hash(state)
    planned=plan_native(state)
    if dry_run:return {'sourceHash':hash_value,'hotRows':len(planned[0]),'incidents':len(planned[1]),'reasons':len(planned[2]),'latencyBlocks':len(planned[3])}
    db.executescript(SCHEMA.read_text())
    owner=str(uuid.uuid4());now=int(time.time())
    db.execute('BEGIN IMMEDIATE')
    try:
        existing=db.execute("SELECT owner,lease_until,source_hash,status FROM migration_runs WHERE name='state-v2'").fetchone()
        if existing and (existing[1]>now or (existing[2]!=hash_value and existing[3]!='rolledback')):raise ValueError('Migration busy or source drift')
        if not existing and any(db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ['native_hot','native_incidents','native_incident_reasons','native_latency_blocks','probe_result_blocks','probe_failure_events']):raise ValueError('Unexplained destination drift')
        db.execute("INSERT INTO migration_runs VALUES('state-v2',?,?,?,'running',2) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until,source_hash=excluded.source_hash,status='running'",(owner,now+300,hash_value))
        for table in ['native_hot','native_incidents','native_incident_reasons','native_latency_blocks','probe_result_blocks','probe_failure_events']:db.execute('DELETE FROM '+table)
        tables=[('native_hot',9),('native_incidents',3),('native_incident_reasons',4),('native_latency_blocks',3)]
        written=0
        for (table,width),rows in zip(tables,planned):
            for row in rows:
                db.execute('INSERT OR REPLACE INTO '+table+' VALUES('+','.join('?'*width)+')',row);written+=1
                if fail_after is not None and written>=fail_after:raise ValueError('Injected conversion failure')
                if written%128==0:renew(db,owner)
        for row in pack_probes(db):
            db.execute('INSERT OR REPLACE INTO probe_result_blocks VALUES(?,?,?,?)',row)
            for sample in json.loads(row[3]):
                if not sample['up']:db.execute('INSERT OR IGNORE INTO probe_failure_events VALUES(?,?,?,?,?,?)',(row[0],sample['monitor_id'],sample['time'],sample['stage'],sample['code'],sample['message']))
            renew(db,owner)
        for (table,_),rows in zip(tables,planned):
            if sorted(db.execute('SELECT * FROM '+table),key=lambda row:encode(row[:3]))!=sorted(rows,key=lambda row:encode(row[:3])):raise ValueError('Converted table semantics mismatch')
        if semantic_hash(reconstruct(db,state))!=hash_value:raise ValueError('Converted native semantics mismatch')
        source_count=db.execute('SELECT COUNT(*) FROM probe_samples').fetchone()[0]
        converted_count=sum(len(json.loads(r[0])) for r in db.execute('SELECT value FROM probe_result_blocks'))
        if source_count!=converted_count:raise ValueError('Converted probe count mismatch')
        # Compare complete sorted probe values, not merely row counts.
        legacy=sorted((probe,encode(s)) for probe,_,_,value in pack_probes(db) for s in json.loads(value))
        converted=sorted((probe,encode(s)) for probe,value in db.execute('SELECT probe_id,value FROM probe_result_blocks') for s in json.loads(value))
        if legacy!=converted:raise ValueError('Converted probe semantics mismatch')
        renew(db,owner)
        db.execute('INSERT OR REPLACE INTO storage_versions VALUES(1,2,?)',(int(time.time()),))
        db.execute("UPDATE migration_runs SET status='complete',lease_until=0 WHERE name='state-v2' AND owner=?",(owner,))
        db.commit()
        return {'migrated':True,'sourceHash':hash_value,'probeSamples':source_count,'nativeHotRows':len(planned[0])}
    except BaseException:
        db.rollback();raise

def renew(db,owner):
    now=int(time.time())
    changed=db.execute("UPDATE migration_runs SET lease_until=? WHERE name='state-v2' AND owner=? AND status='running' AND lease_until>?",(now+300,owner,now)).rowcount
    if changed!=1:raise ValueError('Migration lease expired or replaced')

def rollback(db):
    if db.execute("SELECT 1 FROM uptimeflare WHERE key GLOB 'probe-counters:v1:*' LIMIT 1").fetchone():
        raise ValueError('Packed counters require a compatible v2 server; legacy rollback is refused')
    version=db.execute('SELECT version FROM storage_versions WHERE id=1').fetchone()
    if not version or version[0]!=2:raise ValueError('Rollback requires schema2')
    source=db.execute("SELECT value FROM uptimeflare WHERE key='state'").fetchone();anchor=decode_state(source[0] if source else None)
    db.execute('BEGIN IMMEDIATE')
    try:
        state=reconstruct(db,anchor)
        if any(s['ping']!=round(s['ping']) or s['ping']>65535 for samples in state['latency'].values() for s in samples):raise ValueError('Legacy latency representation cannot preserve values; use full backup restore')
        db.execute("INSERT INTO uptimeflare(key,value) VALUES('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(compact(state),))
        for probe,value in db.execute('SELECT probe_id,value FROM probe_result_blocks'):
            for s in json.loads(value):
                db.execute('INSERT OR IGNORE INTO probe_samples VALUES(?,?,?,?,?,?,?,?)',(probe,s['monitor_id'],s['time'],int(s['up']),s['latency_ms'],s.get('stage',''),s.get('code',''),s.get('message','')))
                mapping={'certificate_expires_at':'certificateExpiresAt','certificate_days_remaining':'certificateDaysRemaining','icmp_latency_ms':'icmpLatencyMs'}
                details={dest:s[src] for src,dest in mapping.items() if src in s}
                if details:db.execute('INSERT OR IGNORE INTO probe_sample_details VALUES(?,?,?,?)',(probe,s['monitor_id'],s['time'],encode(details)))
        db.execute('UPDATE storage_versions SET version=1 WHERE id=1');db.execute("UPDATE migration_runs SET status='rolledback',lease_until=0 WHERE name='state-v2'");db.commit()
        return {'rolledBack':True,'compatibleCode':'this refactor with STATE_STORAGE_VERSION=1; legacy producers retained'}
    except BaseException:db.rollback();raise

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database',type=Path)
    action=parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--dry-run',action='store_true');action.add_argument('--apply',action='store_true');action.add_argument('--rollback',action='store_true');action.add_argument('--restore',type=Path)
    parser.add_argument('--backup',type=Path)
    parser.add_argument('--plan',type=Path,help='Private validated input for the D1 migration runner')
    args=parser.parse_args()
    if not args.database.exists():raise SystemExit('Database file does not exist')
    db=sqlite3.connect(args.database)
    try:
        if args.restore:
            with sqlite3.connect(args.restore) as backup:backup.backup(db)
            print(encode({'restored':True}));return
        if args.plan:
            source=db.execute("SELECT value FROM uptimeflare WHERE key='state'").fetchone()
            source_value=source[0] if source else None
            if isinstance(source_value,bytes):source_value=source_value.decode('utf-8')
            planned=plan_native(decode_state(source_value))
            raw_blocks=list(pack_probes(db))
            failures=[]
            for probe,_,_,value in raw_blocks:
                for sample in json.loads(value):
                    if not sample['up']:failures.append((probe,sample['monitor_id'],sample['time'],sample['stage'],sample['code'],sample['message']))
            value={'version':2,'sourceValue':source_value,'sourceHash':hashlib.sha256((source_value if source_value is not None else 'null').encode()).hexdigest(),'tables':dict(zip(['native_hot','native_incidents','native_incident_reasons','native_latency_blocks'],planned))}
            value['tables']['probe_result_blocks']=raw_blocks;value['tables']['probe_failure_events']=failures
            fd=os.open(args.plan,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            with os.fdopen(fd,'w') as output:output.write(encode(value))
        if not args.dry_run:
            path=args.backup or args.database.with_name(args.database.name+'.backup-'+str(int(time.time())))
            if path.exists():raise SystemExit('Backup already exists; choose a new path')
            fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
            with sqlite3.connect(path) as backup:db.backup(backup)
        print(encode(rollback(db) if args.rollback else migrate(db,args.dry_run)))
    except (ValueError,sqlite3.Error):raise SystemExit('Migration/rollback refused: validation, lease, schema or semantic check failed') from None
    finally:db.close()
if __name__=='__main__':main()
