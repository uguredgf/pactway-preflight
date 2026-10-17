// Test sources only. No application, database migration, model or exchange is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dataDirectory } from '../src/persistence/data-directory.mjs';

test('persistent data stays outside workspace/sync and legacy ledger cannot be silently reset',()=>{
  const root=mkdtempSync(join(tmpdir(),'mandateguard-data-path-'));
  const workspace=join(root,'workspace'),safe=join(root,'persistent'),sync=join(root,'OneDrive');
  mkdirSync(workspace);mkdirSync(sync);
  try {
    assert.equal(dataDirectory({workspaceRoot:workspace,environment:{MG_DATA_DIR:safe}}),join(realpathSync(root),'persistent'));
    assert.throws(()=>dataDirectory({workspaceRoot:workspace,environment:{MG_DATA_DIR:join(workspace,'data')}}),/workspace/);
    assert.throws(()=>dataDirectory({workspaceRoot:workspace,environment:{MG_DATA_DIR:join(sync,'data'),OneDrive:sync}}),/OneDrive/);
    assert.throws(()=>dataDirectory({workspaceRoot:workspace,environment:{MG_DATA_DIR:'relative'}}),/mutlak/);
    mkdirSync(join(workspace,'.local'));writeFileSync(join(workspace,'.local','mandateguard.db'),'test-only-legacy-placeholder');
    assert.throws(()=>dataDirectory({workspaceRoot:workspace,environment:{MG_DATA_DIR:safe}}),/Eski workspace veritabanı/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
