// Controller tests with DOM/animation doubles, not browser or visual acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../public/motion.js',import.meta.url),'utf8');
function setup({reduced=false,state='idle',animate=true,intersection=true}={}){
  const animations=[];
  class Element {
    constructor(){this.dataset={};this.listeners={};this.attributes={};this.hidden=false;}
    addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
    fire(type){for(const fn of this.listeners[type]??[])fn();}
    setAttribute(name,value){this.attributes[name]=value;}
    getTotalLength(){return 80;}
    animate(frames,options){const a={frames,options,cancelled:false,cancel(){this.cancelled=true;},finished:new Promise(()=>{})};animations.push(a);return a;}
  }
  const scene=new Element(),figure=new Element(),hint=new Element();
  const papers=[new Element(),new Element()];
  const buttons=['proposal','guard','record'].map(stage=>{const b=new Element();b.dataset.graphicStage=stage;return b;});
  const zones=['proposal','guard','record'].map(stage=>{const z=new Element();z.dataset.graphicZone=stage;return z;});
  const groups={'.proposal-piece':Array.from({length:4},()=>new Element()),'.guard-plane':[new Element(),new Element()],
    '.route-light':[new Element(),new Element()],'.record-piece':[new Element(),new Element(),new Element()]};
  const singles={'.guard-scan':new Element(),'.route-light:not(.red)':groups['.route-light'][0],
    '.route-light.red':groups['.route-light'][1],'.record-lines':new Element()};
  scene.querySelectorAll=selector=>selector==='[data-graphic-zone]'?zones:groups[selector]??[];scene.querySelector=selector=>singles[selector]??null;
  figure.querySelectorAll=selector=>selector==='.example-paper'?papers:buttons;if(!animate)scene.animate=undefined;
  const ids={'opening-graphic':figure,'opening-scene':scene,'opening-hint':hint};
  const document=new Element();document.documentElement=new Element();document.documentElement.dataset.motionState=state;
  document.querySelectorAll=()=>[];document.getElementById=id=>ids[id]??null;
  const media=new Element();media.matches=reduced;
  let intersect,mutate;
  class IntersectionObserver{constructor(fn){intersect=fn;}observe(){}}
  class MutationObserver{constructor(fn){mutate=fn;}observe(){}}
  runInNewContext(source,{document,matchMedia:()=>media,MutationObserver,IntersectionObserver,
    window:intersection?{IntersectionObserver}:{}});
  return {animations,scene,buttons,zones,hint,document,media,
    visible(value=true){intersect([{isIntersecting:value}]);},
    state(value){document.documentElement.dataset.motionState=value;mutate();}};
}

test('opening and two papers enter once, with no replay loop or replay control',()=>{
  const f=setup();assert.equal(f.animations.length,0);f.visible();
  assert.equal(f.animations.length,14);
  assert.ok(f.animations.every(a=>a.options.duration<=850 && a.options.iterations===undefined));
  f.visible(false);assert.ok(f.animations.every(a=>a.cancelled));f.visible();assert.equal(f.animations.length,14);
  assert.deepEqual(f.animations.slice(-2).map(a=>a.options.delay),[300,480]);
});
test('hovering drawing zones animates; hovering labels does not; leaving settles motion',()=>{
  const f=setup();f.visible();const initial=f.animations.length;
  for(const button of f.buttons)button.fire('pointerenter');
  assert.equal(f.animations.length,initial);
  for(const zone of f.zones){
    const before=f.animations.length;zone.fire('pointerenter');
    assert.ok(f.animations.length>before);assert.equal(f.scene.dataset.active,zone.dataset.graphicZone);
    zone.fire('pointerleave');assert.ok(f.animations.every(a=>a.cancelled));
    zone.fire('click');assert.ok(f.animations.length>before);
  }
});
test('drawing interaction preserves reduced-motion and offline guards',()=>{
  for(const options of [{reduced:true},{state:'offline'}]){
    const f=setup(options);f.visible();
    f.zones[1].fire('pointerenter');f.zones[1].fire('click');
    assert.equal(f.animations.length,0);assert.match(f.hint.textContent,/reddedilebilir/);
  }
});
test('offline/blocked/unknown state cancels motion and does not replay after reconnection',()=>{
  const f=setup({state:'offline'});f.visible();assert.equal(f.animations.length,0);
  f.state('idle');assert.equal(f.animations.length,14);
  for(const state of ['blocked','offline','unexpected']){
    f.state(state);assert.ok(f.animations.every(a=>a.cancelled));
    const count=f.animations.length;f.buttons[1].fire('click');assert.equal(f.animations.length,count);
  }
  f.state('idle');assert.equal(f.animations.length,14);
});
test('hidden document and offscreen figure settle animation without losing explanatory text',()=>{
  const f=setup();f.visible();f.buttons[2].fire('click');assert.match(f.hint.textContent,/gerçekleştiği/);
  f.document.hidden=true;f.document.fire('visibilitychange');assert.ok(f.animations.every(a=>a.cancelled));
  const count=f.animations.length;f.document.hidden=false;f.document.fire('visibilitychange');assert.equal(f.animations.length,count);
  f.buttons[0].fire('focus');f.visible(false);assert.ok(f.animations.every(a=>a.cancelled));
});
test('reduced motion keeps static exploration and preference change cancels active animations',()=>{
  const f=setup({reduced:true});f.visible();f.buttons[1].fire('click');
  assert.equal(f.animations.length,0);assert.match(f.hint.textContent,/reddedilebilir/);
  assert.equal(f.buttons[1].attributes['aria-pressed'],'true');
  f.media.matches=false;f.media.fire('change');assert.ok(f.animations.length>0);
  f.media.matches=true;f.media.fire('change');assert.ok(f.animations.every(a=>a.cancelled));
});
test('native button focus/click chooses one schematic stage; no animation API has static fallback',()=>{
  const f=setup({animate:false});f.visible();
  for(const button of f.buttons){button.fire('focus');button.fire('click');
    assert.equal(f.scene.dataset.active,button.dataset.graphicStage);
    assert.equal(f.buttons.filter(b=>b.attributes['aria-pressed']==='true').length,1);
  }
  assert.equal(f.animations.length,0);
  const fallback=setup({intersection:false});assert.equal(fallback.animations.length,14);
});
test('graphic stays separate from trading, uses native controls and existing same-origin assets',()=>{
  const html=readFileSync(new URL('../app.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/motion.css',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(fetch|XMLHttpRequest|WebSocket|sessionStorage|localStorage|setInterval|setTimeout)\s*[.(]/);
  assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>|\son\w+=|\sstyle=/i);
  assert.doesNotMatch(html,/homepage-demo\.js|homepage-opening\.js/);
  assert.equal((html.match(/<button type="button" data-graphic-stage=/g)??[]).length,3);
  assert.equal((html.match(/data-graphic-zone=/g)??[]).length,3);
  assert.equal((html.match(/class="graphic-hitbox"/g)??[]).length,3);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size);
  assert.match(html,/Şematik örnek · Canlı işlem değil/);
  assert.doesNotMatch(html,/opening-replay|Akışı tekrar izle|Çizimdeki şekillerin üzerine/);
  assert.doesNotMatch(source,/opening-replay/);
  assert.equal((html.match(/<article class="example-paper /g)??[]).length,2);
  assert.match(html,/Yeniden denetlenir/);assert.doesNotMatch(html,/Sınır içinde|%9,98/);
  assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/max-width:680px/);
});
