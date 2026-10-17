// Executes the shipped preflight controller with deterministic DOM, HTTP and storage doubles.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {TextEncoder} from 'node:util';

const html=readFileSync(new URL('../../preflight.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../../public/preflight.mjs',import.meta.url),'utf8');

class Element {
  constructor(tag='div',document=null){this.tagName=tag.toUpperCase();this.ownerDocument=document;this.children=[];this.listeners=new Map();this.attributes=new Map();this.dataset={};this.className='';this.value='';this.textContent='';this.hidden=false;this.disabled=false;this.checked=false;this.type='';this.title='';this.open=false;}
  addEventListener(type,listener){const list=this.listeners.get(type)??[];list.push(listener);this.listeners.set(type,list);}
  async fire(type,extra={}){const event={target:this,currentTarget:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...extra};for(const listener of this.listeners.get(type)??[])await listener(event);return event;}
  append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}}
  replaceChildren(...children){this.children=[];this.append(...children);}
  reset(){for(const field of this.fields?.values()??[])field.value='';}
  click(){this.clicked=true;}
  remove(){this.removed=true;}
  focus(){if(this.ownerDocument)this.ownerDocument.activeElement=this;this.focused=true;}
  setAttribute(name,value){this.attributes.set(name,String(value));if(name==='aria-label')this.ariaLabel=String(value);}
  removeAttribute(name){this.attributes.delete(name);}
  getAttribute(name){return this.attributes.get(name)??null;}
}

export const response=(body,{status=200}={})=>({body,status});
export async function startPreflightController({respond,stored=[],storageThrows=false,nowMs=1792231200000}={}){
  const elements=new Map(),buttons=[],document={activeElement:null};
  for(const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)\bid="([^"]+)"([^>]*)>/g)){
    const element=new Element(match[1],document),attrs=match[2]+match[4];element.hidden=/\bhidden\b/.test(attrs);element.disabled=/\bdisabled\b/.test(attrs);element.open=/\bopen\b/.test(attrs);
    for(const attribute of attrs.matchAll(/([\w-]+)="([^"]*)"/g))element.setAttribute(attribute[1],attribute[2]);
    const example=attrs.match(/\bdata-example="([^"]+)"/);if(example)element.dataset.example=example[1];
    elements.set(match[3],element);if(element.tagName==='BUTTON')buttons.push(element);
  }
  const get=id=>{assert.ok(elements.has(id),'Missing real preflight target: '+id);return elements.get(id);};
  const policyFields=new Map([['maxNotional',get('max-notional')],['maxPrice',get('max-price')],['durationSeconds',get('duration-seconds')]]);
  const candidateFields=new Map([['price',get('candidate-price')],['size',get('candidate-size')]]);
  get('policy-form').fields=policyFields;get('candidate-form').fields=candidateFields;
  Object.assign(document,{body:new Element('body',document),querySelector:selector=>{assert.match(selector,/^#[\w-]+$/);return get(selector.slice(1));},
    querySelectorAll:selector=>selector==='button'?buttons:selector==='[data-example]'?buttons.filter(button=>button.dataset.example):[],createElement:tag=>new Element(tag,document)});
  const storage=new Map(stored),calls=[],unexpected=[],timers=[];let uuid=0,timerId=0;
  const sessionStorage={getItem:key=>{if(storageThrows)throw Error('storage denied');return storage.get(key)??null;},
    setItem:(key,value)=>{if(storageThrows)throw Error('storage denied');storage.set(key,String(value));},removeItem:key=>{if(storageThrows)throw Error('storage denied');storage.delete(key);}};
  const fetch=async(path,options={})=>{const request={path,...options};calls.push(request);const reply=await respond(request);
    if(!reply){unexpected.push(request);throw Error('Unexpected request: '+path);}if(reply.error)throw reply.error;
    return {ok:(reply.status??200)<400,status:reply.status??200,json:async()=>structuredClone(reply.body)};};
  class FormData {constructor(form){this.fields=form.fields;}get(name){return this.fields.get(name)?.value??null;}}
  class FixedDate extends Date {static now(){return nowMs;}}
  const context={document,sessionStorage,fetch,FormData,Date:FixedDate,Blob:class{},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:()=>{}},
    crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`,subtle:webcrypto.subtle},TextEncoder,Uint8Array,AbortSignal:{timeout:ms=>({timeoutMs:ms})},
    setTimeout:(fn,ms)=>{const timer={id:++timerId,fn,ms,cancelled:false};timers.push(timer);return timer.id;},clearTimeout:id=>{const timer=timers.find(item=>item.id===id);if(timer)timer.cancelled=true;},structuredClone,console};
  await runInNewContext('(async()=>{\n'+source+'\n})()',context,{filename:'public/preflight.mjs'});
  const flush=async(count=5)=>{for(let index=0;index<count;index++)await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(unexpected,[],'Every request needs an explicit fixture response');};
  await flush();
  const runMatchingTimer=async predicate=>{const index=timers.findIndex(timer=>!timer.cancelled&&predicate(timer));assert.notEqual(index,-1,'Missing matching timer');const [timer]=timers.splice(index,1);timer.fn();await flush();};
  return {get,calls,storage,timers,document,fields:{policy:policyFields,candidate:candidateFields},
    async fire(id,type='click',extra={}){const event=await get(id).fire(type,extra);await flush();return event;},flush,
    async runTimer(index=0){const active=timers.filter(timer=>!timer.cancelled),timer=active[index];assert.ok(timer,'Missing timer');timers.splice(timers.indexOf(timer),1);timer.fn();await flush();},
    async runTimerByDelay(ms){await runMatchingTimer(timer=>timer.ms===ms);},
    setNow(value){nowMs=value;}};
}
