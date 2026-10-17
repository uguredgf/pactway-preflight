// Runs the shipped controller with deterministic DOM/HTTP/storage doubles.
// Not a browser, layout, cookie, or real-network acceptance harness.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as messages from '../../public/messages.mjs';
import * as ui from '../../public/ui-state.mjs';

const html=readFileSync(new URL('../../app.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../../public/app.mjs',import.meta.url),'utf8');
const imports=[...source.matchAll(/^import \{([^}]+)\} from '[^']+';\r?$/gm)];
const names=imports.flatMap(match=>match[1].split(',').map(name=>name.trim()));
const controller=source.replace(/^import .+;\r?\n/gm,'');

class Element {
  constructor(tag='div') {
    this.tagName=tag.toUpperCase();this.children=[];this.listeners=new Map();
    this.dataset={};this.attributes={};this.value='';this.textContent='';
    this.hidden=false;this.disabled=false;this.checked=false;this.open=false;
    const classes=new Set();
    this.classList={add:name=>classes.add(name),remove:name=>classes.delete(name),
      toggle:(name,on)=>on?classes.add(name):classes.delete(name)};
  }
  addEventListener(type,listener){const list=this.listeners.get(type)??[];list.push(listener);this.listeners.set(type,list);}
  async fire(type,extra={}) {
    const event={target:this,currentTarget:this,defaultPrevented:false,
      preventDefault(){this.defaultPrevented=true;},...extra};
    for(const listener of this.listeners.get(type)??[])await listener(event);
    return event;
  }
  append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}}
  replaceChildren(...children){this.children=[];this.append(...children);}
  get firstChild(){return this.children[0];}
  setAttribute(name,value){this.attributes[name]=value;}
  focus(){this.focused=true;}
  showModal(){this.open=true;}
  close(){if(this.open){this.open=false;void this.fire('close');}}
  querySelectorAll(selector){
    assert.ok(['input','input:checked'].includes(selector),'Unsupported child selector: '+selector);
    const descendants=this.children.flatMap(child=>[child,...child.querySelectorAll('input')]);
    return [...new Set(descendants)].filter(child=>child.tagName==='INPUT' && (selector==='input' || child.checked));
  }
}

export async function startController({stored=[],storageThrows=false,respond}) {
  const elements=new Map([...html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map(match=>{
    const element=new Element(match[1]);element.hidden=/\bhidden\b/.test(match[0]);
    element.parentElement=new Element();return [match[2],element];
  }));
  const get=id=>{assert.ok(elements.has(id),'Missing real HTML target: '+id);return elements.get(id);};
  const intro=new Element(),document=new Element(),window=new Element();
  document.documentElement=new Element();document.body=new Element();document.hidden=false;
  document.createElement=tag=>new Element(tag);
  document.querySelector=selector=>{
    if(selector==='.intro')return intro;
    if(selector==='#policy-form input')return get('policy-form').elements.namedItem('budget');
    assert.match(selector,/^#[\w-]+$/);return get(selector.slice(1));
  };
  const fields=new Map(Object.keys(ui.fieldLabels).map(name=>[name,new Element('input')]));
  get('policy-form').elements={namedItem:name=>fields.get(name)};
  get('draft-edit-form').append(get('edit-fields'),get('unsupported-list'));
  get('draft-edit-form').elements={namedItem:name=>get('draft-edit-form').querySelectorAll('input').find(input=>input.name===name)??null};
  const storage=new Map(stored),calls=[],unexpected=[],intervals=new Map();
  const sessionStorage={getItem:key=>{if(storageThrows)throw Error('Storage denied');return storage.get(key)??null;},
    setItem:(key,value)=>{if(storageThrows)throw Error('Storage denied');storage.set(key,String(value));},
    removeItem:key=>{if(storageThrows)throw Error('Storage denied');storage.delete(key);}};
  const fetch=async(path,options)=>{
    const request={path,...options};calls.push(request);
    const reply=await respond(request);
    if(!reply){unexpected.push(request);throw Error('Unexpected request: '+path);}
    if(reply.error)throw reply.error;
    return {ok:(reply.status??200)<400,status:reply.status??200,json:async()=>structuredClone(reply.body),
      headers:{get:name=>name==='X-MG-Server-Time'?String(reply.time??1000):null}};
  };
  const dependencies={...messages,...ui};
  for(const name of names)assert.ok(name in dependencies,'Missing import: '+name);
  let performanceNow=0;
  const context={...dependencies,document,window,sessionStorage,fetch,performance:{now:()=>performanceNow},
    AbortSignal:{timeout:ms=>({timeoutMs:ms})},setInterval:(fn,ms)=>intervals.set(ms,fn),
    setTimeout:()=>1,clearTimeout:()=>{},FormData:class {
      constructor(form){assert.equal(form,get('policy-form'));}
      *[Symbol.iterator](){for(const [name,field] of fields)yield [name,field.value];}
    }};
  // Only import declarations are removed; all shipped controller functions/events execute unchanged.
  await runInNewContext('(async()=>{\n'+controller+'\n})()',context,{filename:'public/app.mjs'});
  const flush=async()=>{
    // Controller event callbacks intentionally fire-and-forget some async GETs.
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(unexpected,[],'Every fetch must have an explicit fixture response');
  };
  await flush();
  return {get,storage,calls,document,window,
    async fire(id,type,extra){const event=await get(id).fire(type,extra);await flush();return event;},
    async poll(){assert.ok(intervals.has(2000));intervals.get(2000)();await flush();},
    tick(ms){performanceNow+=ms;for(const fn of intervals.values())fn();},flush};
}
