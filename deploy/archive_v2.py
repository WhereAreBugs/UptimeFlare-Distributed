#!/usr/bin/env python3
"""Bounded, private offline archive. Never deletes source rows; only archives closed incidents."""
import argparse,gzip,json,os,sqlite3
from pathlib import Path
MAX_BYTES=64*1024*1024

def archive(database, output, before):
    if before<0:raise ValueError('Invalid cutoff')
    db=sqlite3.connect(f'file:{database.resolve()}?mode=ro',uri=True)
    fd=os.open(output,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    rows=size=0
    queries={
        'probe_result_blocks':('SELECT * FROM probe_result_blocks WHERE window<? ORDER BY probe_id,window,chunk',(before//300*300-300,)),
        'native_latency_blocks':('SELECT * FROM native_latency_blocks WHERE window<? ORDER BY monitor_id,window',(before//300*300-300,)),
        'native_incidents':('SELECT * FROM native_incidents WHERE end IS NOT NULL AND end<? ORDER BY monitor_id,start',(before,)),
        'native_incident_reasons':('SELECT r.* FROM native_incident_reasons r JOIN native_incidents i ON i.monitor_id=r.monitor_id AND i.start=r.incident_start WHERE i.end IS NOT NULL AND i.end<? ORDER BY r.monitor_id,r.incident_start,r.time',(before,))}
    try:
        with os.fdopen(fd,'wb') as raw,gzip.GzipFile(fileobj=raw,mode='wb') as stream:
            db.execute('BEGIN')
            for table,(sql,params) in queries.items():
                cursor=db.execute(sql,params);columns=[item[0] for item in cursor.description]
                while batch:=cursor.fetchmany(1000):
                    for row in batch:
                        value=(json.dumps({'table':table,'columns':columns,'row':row},ensure_ascii=False,separators=(',',':'))+'\n').encode()
                        size+=len(value)
                        if size>MAX_BYTES:raise ValueError('Archive exceeds 64MiB; use an earlier cutoff or separate database snapshot')
                        stream.write(value);rows+=1
            db.rollback()
        return {'rows':rows,'uncompressedBytes':size,'sourceModified':False}
    except BaseException:
        output.unlink(missing_ok=True);raise
    finally:db.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('database',type=Path);parser.add_argument('--output',required=True,type=Path);parser.add_argument('--before',required=True,type=int)
    args=parser.parse_args();print(json.dumps(archive(args.database,args.output,args.before)))
