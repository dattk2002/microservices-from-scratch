import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
import { amount, envelope, initial, joinSnapshots, parseSnapshot, rights, validate } from './model.mts';
import type { Envelope, Replica, Snapshot } from './model.mts';

// One private file and one sequential writer per actor; SQL serializes local commands.
export class Store {
  readonly db:DatabaseSync;
  readonly replica:Replica;
  constructor(path:string, replica:Replica) {
    this.replica=replica;
    this.db=new DatabaseSync(path);
    try {
      this.transaction(()=>{
        this.db.exec('CREATE TABLE IF NOT EXISTS escrow (id INTEGER PRIMARY KEY CHECK(id=1), replica TEXT NOT NULL, snapshot TEXT NOT NULL) STRICT');
        this.db.prepare('INSERT OR IGNORE INTO escrow VALUES(1,?,?)').run(replica,JSON.stringify(initial()));
        if(this.db.prepare('SELECT replica FROM escrow WHERE id=1').get()?.replica!==replica) throw new Error('Replica identity conflict');
        this.read();
      });
    } catch(error) { this.db.close(); throw error; }
  }
  private transaction<T>(operation:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=operation(); this.db.exec('COMMIT'); return result; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private read():Snapshot {
    const row=this.db.prepare('SELECT snapshot FROM escrow WHERE id=1').get();
    if(typeof row?.snapshot!=='string') throw new Error('Missing escrow snapshot');
    const value:unknown=JSON.parse(row.snapshot);
    return parseSnapshot(value);
  }
  private write(snapshot:Snapshot):Envelope {
    this.db.prepare('UPDATE escrow SET snapshot=? WHERE id=1').run(JSON.stringify(snapshot));
    return envelope(this.replica,snapshot);
  }
  envelope():Envelope { return envelope(this.replica,this.read()); }
  spend(input:unknown):Envelope { return this.change(input,'spend'); }
  transfer(input:unknown):Envelope { return this.change(input,'transfer'); }
  private change(input:unknown,kind:'spend'|'transfer'):Envelope {
    const n=amount(input);
    return this.transaction(()=>{
      const s=this.read();
      if(n>rights(s)[this.replica]) throw new HttpError(409,'insufficient_rights','Insufficient local rights');
      if(kind==='spend') s.spent[this.replica]+=n;
      else {
        const outbound=this.replica==='a'?'ab':'ba';
        if(s.transferred[outbound]+n>16) throw new HttpError(429,'transfer_limit','Outbound transfer limit reached');
        s.transferred[outbound]+=n;
      }
      return this.write(validate(s));
    });
  }
  receive(input:unknown):Envelope {
    const incoming=parseSnapshot(input);
    return this.transaction(()=>this.write(joinSnapshots(this.read(),incoming)));
  }
  close():void { this.db.close(); }
}
