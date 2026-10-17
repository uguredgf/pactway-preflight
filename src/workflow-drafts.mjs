import {randomUUID} from 'node:crypto';
import {hashPolicy,hashCanonical} from './domain/governor.mjs';
import {DRAFT_FIELDS,draftFields,safeDraftText,inspectDraftText} from './domain/draft-fields.mjs';

const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const exact=(value,allowed)=>{
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k)))fail('DRAFT_INPUT',400);
};
/** Persistent drafts grant no execution authority. Approval/task creation remains
 * a separate boundary; the task inherits this workflow's existing counters. */
export class WorkflowDrafts {
  constructor(store,{makePolicy,extractor=null,isOwnerActive=()=>true,capturePolicyContext=()=>null}) {
    this.store=store;this.makePolicy=makePolicy;this.extractor=extractor;this.isOwnerActive=isOwnerActive;
    this.capturePolicyContext=capturePolicyContext;
  }
  #owner(ownerId) {if(!this.isOwnerActive(ownerId))fail('DRAFT_OWNER_INACTIVE',401);}
  #project(draft,revision,nowMs) {
    draft.missing=DRAFT_FIELDS.filter(key=>draft.fields[key]===null);
    draft.unresolved=draft.unsupported.filter(clause=>!draft.removedConditions.includes(clause));
    draft.ready=!draft.missing.length && !draft.unresolved.length && draft.extractionState!=='RUNNING';
    draft.policy=null;draft.policyHash=null;
    if(draft.ready) {
      draft.policy=this.makePolicy(draft.fields,{id:draft.id,policyId:draft.policyId,ownerId:draft.ownerId,
        workflowId:draft.workflowId,revision,createdAtMs:draft.createdAtMs,nowMs,policyContext:draft.policyContext??null});
      if(draft.policy.taskId!==draft.id || draft.policy.workflowId!==draft.workflowId
          || draft.policy.id!==draft.policyId || draft.policy.draftRevision!==revision)fail('DRAFT_POLICY_BINDING');
      draft.policyHash=hashPolicy(draft.policy);
      if(draft.policy.expiresAtMs<=nowMs)fail('DRAFT_POLICY_EXPIRED');
    }
  }
  create(ownerId,input) {
    this.#owner(ownerId);exact(input,[...DRAFT_FIELDS,'text']);
    const nowMs=Date.now(),text=Object.hasOwn(input,'text')?safeDraftText(input.text):null;
    if(text && Object.keys(input).length!==1)fail('DRAFT_INPUT',400);
    const fields=text?Object.fromEntries(DRAFT_FIELDS.map(key=>[key,null])):draftFields(input);
    const inspected=text?inspectDraftText(text):null;
    const id=randomUUID(),draft={id,workflowId:id,policyId:randomUUID(),ownerId,revision:1,
      createdAtMs:nowMs,validUntilMs:nowMs+600000,originalText:text,fields,policyContext:this.capturePolicyContext(),
      unsupported:inspected?.unsupported??[],removedConditions:[],evidence:{},extractionState:text?'NOT_REQUESTED':'NOT_NEEDED'};
    this.#project(draft,1,nowMs);
    return this.store.createPolicyWorkflow(draft);
  }
  get(ownerId,id) {this.#owner(ownerId);return this.store.policyWorkflow(id,ownerId);}
  edit(ownerId,id,input) {
    this.#owner(ownerId);exact(input,['expectedRevision','fields','removeConditions']);
    const fields=draftFields(input.fields??{},{partial:true}),removed=input.removeConditions??[];
    if(!Number.isSafeInteger(input.expectedRevision) || !Array.isArray(removed) || removed.length>20
        || removed.some(s=>typeof s!=='string') || new Set(removed).size!==removed.length)fail('DRAFT_INPUT',400);
    return this.store.updatePolicyWorkflow(id,ownerId,input.expectedRevision,draft=>{
      if(removed.some(clause=>!draft.unsupported.includes(clause)))fail('DRAFT_CONDITION_UNKNOWN',400);
      draft.fields={...draft.fields,...fields};
      draft.removedConditions=[...new Set([...draft.removedConditions,...removed])];
      // Edits invalidate in-flight extraction, but do not refund its slot.
      if(draft.extractionState==='RUNNING')draft.extractionState='EDITED_DURING_EXTRACTION';
      this.#project(draft,draft.revision+1,Date.now());
    });
  }
  async extract(ownerId,id,{expectedRevision}={}) {
    this.#owner(ownerId);
    if(!this.extractor)fail('EXTRACTOR_NOT_CONFIGURED');
    const start=this.store.updatePolicyWorkflow(id,ownerId,expectedRevision,draft=>{
      if(!draft.originalText || draft.extractionState!=='NOT_REQUESTED')fail('EXTRACTION_ALREADY_ATTEMPTED');
      draft.extractionState='RUNNING';draft.ready=false;draft.policy=null;draft.policyHash=null;
    });
    let result;
    try {
      result=await this.extractor.extract({text:start.originalText,workflowId:start.workflowId,ownerId,draftRevision:start.revision});
      this.#owner(ownerId);this.store.assertNewWorkAllowed();
      // Independently ground even an injected extractor; never accept authority
      // or omitted unsupported clauses from a model/provider.
      const expected=inspectDraftText(start.originalText);
      if(hashCanonical(result.fields)!==hashCanonical(expected.fields)
          || hashCanonical(result.unsupported)!==hashCanonical(expected.unsupported))fail('EXTRACTOR_NOT_GROUNDED');
      return this.store.updatePolicyWorkflow(id,ownerId,start.revision,draft=>{
        draft.fields=expected.fields;draft.unsupported=expected.unsupported;draft.evidence=expected.evidence;
        draft.extractionState='COMPLETED';this.#project(draft,draft.revision+1,Date.now());
      });
    } catch(error) {
      // Never overwrite an edit or re-enable an expired/revoked workflow. No raw
      // provider error/body is persisted. A failed call is not a fixture result.
      if(this.isOwnerActive(ownerId))try {
        this.store.updatePolicyWorkflow(id,ownerId,start.revision,draft=>{
          draft.extractionState=error?.code==='MODEL_CALL_LIMIT'?'QUOTA_EXHAUSTED':'FAILED';
          draft.ready=false;draft.policy=null;draft.policyHash=null;
        });
      } catch {}
      fail(error?.code==='MODEL_CALL_LIMIT'?'MODEL_CALL_LIMIT':'EXTRACTION_NOT_APPLIED');
    }
  }
}
