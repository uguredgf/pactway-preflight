import {hashCanonical} from '../domain/governor.mjs';

// Explicit recovery allowlist. Browser sessions/CSRF credentials are never copied.
const V3_TABLES=Object.freeze({
  tasks:['id','state'],events:['id','task_id','sequence','receipt'],
  receipt_outbox:['task_id','sequence','status','transaction_hash'],
  model_call_budget:['provider','used'],model_workflows:['id','total','extraction','proposal'],
  policy_workflows:['id','owner_id','task_id','draft'],
  observations:['id','task_id','intent_id','observed_at_ms','source','payload','status'],
  observation_replays:['kind','observation_id','review_hash','result'],
  observation_review_actions:['kind','observation_id','review_hash','action','at_ms'],
  atk_tool_observations:['observation_id','session_id','call_id','connection_hash','catalog_hash','entry_hash','account_id',
    'task_id','intent_id','tool','received_at_ms','payload_hash','record','status'],
  atk_capture_sessions:['session_id','binding','binding_hash'],
  atk_capture_receipts:['observation_id','session_id','payload_hash','binding_hash'],
  campaigns:['id','state'],campaign_events:['id','campaign_id','kind','at_ms','record'],
});
export const RECOVERY_TABLES=Object.freeze({...V3_TABLES,
  preflight_policies:['id','owner_id','created_at_ms','record'],
  preflight_checks:['id','owner_id','client_request_id','input_hash','state','mode','created_at_ms','updated_at_ms','model_calls','record'],
});
for(const columns of Object.values(RECOVERY_TABLES))Object.freeze(columns);
const LEGACY_TABLES=Object.freeze(Object.fromEntries(Object.entries(V3_TABLES)
  .filter(([table])=>!['atk_capture_sessions','atk_capture_receipts','policy_workflows'].includes(table))));
const V2_TABLES=Object.freeze(Object.fromEntries(Object.entries(V3_TABLES).filter(([table])=>table!=='policy_workflows')));
const LIMIT=64*1024*1024;
export function encodeRecoverySnapshot(tables,createdAtMs) {
  const body={schemaVersion:4,createdAtMs,tables};
  return JSON.stringify({...body,checksum:hashCanonical(body)});
}
export function decodeRecoverySnapshot(text) {
  if(typeof text!=='string' || Buffer.byteLength(text,'utf8')>LIMIT)throw new Error('RECOVERY_SIZE');
  const value=JSON.parse(text);
  if(!value || typeof value!=='object' || Object.keys(value).sort().join(',')!=='checksum,createdAtMs,schemaVersion,tables'
      || ![1,2,3,4].includes(value.schemaVersion) || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs<0)
    throw new Error('RECOVERY_FORMAT');
  const {checksum,...body}=value;
  if(hashCanonical(body)!==checksum)throw new Error('RECOVERY_CHECKSUM');
  const expectedTables=value.schemaVersion===1?LEGACY_TABLES:value.schemaVersion===2?V2_TABLES:
    value.schemaVersion===3?V3_TABLES:RECOVERY_TABLES;
  if(!body.tables || Object.keys(body.tables).sort().join(',')!==Object.keys(expectedTables).sort().join(','))throw new Error('RECOVERY_TABLES');
  let count=0;
  for(const [table,columns] of Object.entries(expectedTables)) {
    const rows=body.tables[table];if(!Array.isArray(rows) || (count+=rows.length)>100000)throw new Error('RECOVERY_ROWS');
    for(const row of rows) {
      if(!row || typeof row!=='object' || Array.isArray(row) || Object.keys(row).sort().join(',')!==[...columns].sort().join(','))throw new Error('RECOVERY_COLUMNS');
      for(const cell of Object.values(row))if(cell!==null && typeof cell!=='string' && !Number.isSafeInteger(cell))throw new Error('RECOVERY_CELL');
    }
  }
  // Verify the original checksum before normalizing legacy imports. Old backups
  // have no capture lineage; never infer it from matching observation context.
  return {...value,tables:{...(value.schemaVersion===1?{atk_capture_sessions:[],atk_capture_receipts:[]}:{}),
    ...(value.schemaVersion<3?{policy_workflows:[]}:{}),
    ...(value.schemaVersion<4?{preflight_policies:[],preflight_checks:[]}:{}),...value.tables}};
}
