/* Graphic motion only. No timer, network call, execution action or simulated result. */
(() => {
  'use strict';
  const mounts=[...document.querySelectorAll('[data-graphic-motion]')];
  if (!mounts.length) return;
  const descriptions=[
    'Sınırlar kullanıcı tarafından onaylanır; grafik bu onayın yerine geçmez.',
    'Öneri, onaylı görevin sınırları içinde değerlendirilmek üzere hazırlanır.',
    'Bağımsız kontrol, öneriyi kabul edebilir veya reddedebilir.',
    'Karar kaydı tutulur; bir kayıt, borsa gerçekleşmesinin kanıtı değildir.'
  ];
  const labels=['Sınır','Öneri','Kontrol','Kayıt'];
  document.querySelectorAll('.event[data-step]').forEach(row=>{row.dataset.motionStage=String([1,2,1,3][Number(row.dataset.step)]??0);});
  const create=(tag,className,text)=>{
    const el=document.createElement(tag);el.className=className;
    if(text!==undefined)el.textContent=text;return el;
  };
  const svgEl=(tag,attrs)=>{
    const el=document.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [key,value] of Object.entries(attrs))el.setAttribute(key,String(value));return el;
  };
  const views=mounts.map((mount,index)=>{
    mount.classList.add('motion-map');mount.dataset.active='0';mount.dataset.visible='true';
    const heading=create('div','motion-heading');
    heading.append(create('span','motion-title','Kararın izlediği yol'),create('span','motion-note','Şematik görünüm'));
    const svg=svgEl('svg',{viewBox:'0 0 640 76','aria-hidden':'true',focusable:'false',class:'motion-circuit'});
    for(let stage=0;stage<3;stage++){
      const path=`M${80+160*stage} 38H${240+160*stage}`;
      svg.append(svgEl('path',{d:path,class:'motion-rail'}),
        svgEl('path',{d:path,pathLength:160,class:'motion-trace trace-'+stage}));
    }
    labels.forEach((_,stage)=>{
      const g=svgEl('g',{class:'motion-junction junction-'+stage});
      g.append(svgEl('circle',{cx:80+160*stage,cy:38,r:13,class:'motion-halo'}),
        svgEl('circle',{cx:80+160*stage,cy:38,r:4,class:'motion-point'}));svg.append(g);
    });
    const controls=create('div','motion-stages');controls.setAttribute('role','group');controls.setAttribute('aria-label','Karar yolunun adımlarını incele');
    const caption=create('p','motion-caption',descriptions[0]);caption.id='motion-caption-'+index;
    const buttons=labels.map((label,stage)=>{
      const button=create('button','motion-stage');button.type='button';button.dataset.stage=String(stage);
      button.setAttribute('aria-pressed',String(stage===0));button.setAttribute('aria-describedby',caption.id);
      button.append(create('span','motion-index','0'+(stage+1)),create('span','',label));controls.append(button);return button;
    });
    mount.replaceChildren(heading,svg,controls,caption);
    let selected=0;
    const paint=stage=>{mount.dataset.active=String(stage);caption.textContent=descriptions[stage];};
    controls.addEventListener('click',event=>{
      const button=event.target.closest('button[data-stage]');if(!button)return;
      selected=Number(button.dataset.stage);buttons.forEach((el,i)=>el.setAttribute('aria-pressed',String(i===selected)));paint(selected);
    });
    for(const [enter,leave] of [['pointerover','pointerout'],['focusin','focusout']]){
      controls.addEventListener(enter,event=>{const button=event.target.closest('[data-stage]');if(button)paint(Number(button.dataset.stage));});
      controls.addEventListener(leave,event=>{if(!controls.contains(event.relatedTarget))paint(selected);});
    }
    return {mount,paint,reset:()=>paint(selected)};
  });
  // Event exploration changes only a schematic highlight, never task state.
  for(const [enter,leave] of [['pointerover','pointerout'],['focusin','focusout']]){
    document.addEventListener(enter,event=>{
      const row=event.target.closest('[data-motion-stage]');if(!row)return;
      const stage=Number(row.dataset.motionStage);if(Number.isInteger(stage)&&stage>=0&&stage<=3)views.forEach(view=>view.paint(stage));
    });
    document.addEventListener(leave,event=>{
      const row=event.target.closest('[data-motion-stage]');if(row&&!row.contains(event.relatedTarget))views.forEach(view=>view.reset());
    });
  }
  const pause=()=>document.documentElement.classList.toggle('motion-paused',document.hidden);
  document.addEventListener('visibilitychange',pause);pause();
  if('IntersectionObserver' in window){
    const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{entry.target.dataset.visible=String(entry.isIntersecting);}));
    views.forEach(view=>observer.observe(view.mount));
  }
})();

/* Restored opening illustration. Strictly decorative: no requests, storage,
 * task mutation, synthetic clicks or approval callbacks. Static SVG is the fallback. */
(() => {
  'use strict';
  const figure=document.getElementById('opening-graphic');
  const scene=document.getElementById('opening-scene');
  const hint=document.getElementById('opening-hint');
  if(!figure || !scene || !hint)return;
  const buttons=[...figure.querySelectorAll('[data-graphic-stage]')];
  const zones=[...scene.querySelectorAll('[data-graphic-zone]')];
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const descriptions={
    proposal:'Öneri değişebilir. Onayladığın bütçe, fiyat ve pay sınırları değişmez.',
    guard:'Her öneri bağımsız kontrolden geçer. Sınır dışındaki öneri reddedilebilir.',
    record:'Kararın izi saklanır. Karar kaydı, emrin gerçekleştiği veya zincire yayımlandığı anlamına gelmez.'
  };
  let visible=false,shown=false;
  const running=new Set();
  const allowed=()=>visible && !document.hidden && !reduced.matches
    && ['idle','active'].includes(document.documentElement.dataset.motionState)
    && typeof scene.animate==='function';
  function stop(){for(const animation of running)animation.cancel();running.clear();}
  function motion(element,frames,options){
    if(!element || !allowed())return;
    const animation=element.animate(frames,{fill:'backwards',easing:'cubic-bezier(.2,.75,.2,1)',...options});
    running.add(animation);
    animation.finished.then(()=>running.delete(animation),()=>running.delete(animation));
  }
  function trace(line,delay=0){
    const length=line.getTotalLength();
    motion(line,[{strokeDasharray:`${length} ${length}`,strokeDashoffset:String(length),opacity:.2},
      {strokeDasharray:`${length} ${length}`,strokeDashoffset:'0',opacity:1}],{duration:700,delay});
  }
  function play(){
    stop();if(!allowed())return false;
    delete scene.dataset.active;
    buttons.forEach(button=>button.setAttribute('aria-pressed','false'));
    hint.textContent='Öneri, sınır kontrolü ve karar kaydını incele.';
    scene.querySelectorAll('.proposal-piece').forEach((piece,i)=>motion(piece,
      [{transform:`translate(${-30+i*12}px,${i%2?22:-22}px) scale(.5)`,opacity:0},{transform:'translate(0,0) scale(1)',opacity:1}],{duration:520,delay:i*80}));
    scene.querySelectorAll('.guard-plane').forEach((plane,i)=>motion(plane,
      [{transform:'translateX(20px)',opacity:0},{transform:'translateX(0)',opacity:1}],{duration:500,delay:260+i*110}));
    scene.querySelectorAll('.route-light').forEach((line,i)=>trace(line,450+i*400));
    motion(scene.querySelector('.guard-scan'),[{transform:'translateY(-65px)',opacity:0},
      {transform:'translateY(25px)',opacity:1,offset:.7},{transform:'translateY(0)',opacity:1}],{duration:850,delay:500});
    scene.querySelectorAll('.record-piece').forEach((piece,i)=>motion(piece,
      [{transform:`translate(${22-i*6}px,${24+i*6}px)`,opacity:0},{transform:'translate(0,0)',opacity:1}],{duration:550,delay:1000+i*100}));
    figure.querySelectorAll('.example-paper').forEach((paper,i)=>motion(paper,
      [{transform:`translateY(16px) rotate(${i?6:-6}deg)`,opacity:0},
        {transform:`translateY(0) rotate(${i?6:-6}deg)`,opacity:1}],{duration:480,delay:300+i*180}));
    return true;
  }
  function explore(stage){
    if(!Object.hasOwn(descriptions,stage))return;
    stop();scene.dataset.active=stage;hint.textContent=descriptions[stage];
    buttons.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.graphicStage===stage)));
    if(!allowed())return;
    if(stage==='proposal'){
      scene.querySelectorAll('.proposal-piece').forEach((piece,i)=>motion(piece,
        [{transform:'translateX(0)'},{transform:`translateX(${14-i*2}px)`,offset:.5},{transform:'translateX(0)'}],{duration:650,delay:i*70}));
      trace(scene.querySelector('.route-light:not(.red)'));
    }else if(stage==='guard'){
      scene.querySelectorAll('.guard-plane').forEach((plane,i)=>motion(plane,
        [{transform:'translate(0,0)'},{transform:`translate(${8-i*3}px,-6px)`,offset:.5},{transform:'translate(0,0)'}],{duration:700,delay:i*90}));
      motion(scene.querySelector('.guard-scan'),[{transform:'translateY(-65px)'},{transform:'translateY(25px)',offset:.7},{transform:'translateY(0)'}],{duration:850});
    }else{
      scene.querySelectorAll('.record-piece').forEach((piece,i)=>motion(piece,
        [{transform:'translateY(0)'},{transform:`translateY(${-8-i*5}px)`,offset:.5},{transform:'translateY(0)'}],{duration:700,delay:i*80}));
      trace(scene.querySelector('.route-light.red'));trace(scene.querySelector('.record-lines'),200);
    }
  }
  buttons.forEach(button=>{
    // Labels remain native keyboard/touch alternatives; hovering text does not animate.
    for(const event of ['focus','click'])button.addEventListener(event,()=>explore(button.dataset.graphicStage));
  });
  zones.forEach(zone=>{
    zone.addEventListener('pointerenter',()=>explore(zone.dataset.graphicZone));
    zone.addEventListener('pointerleave',stop);
    zone.addEventListener('click',()=>explore(zone.dataset.graphicZone));
  });
  function sync(){
    if(!allowed())stop();else if(!shown)shown=play();
  }
  reduced.addEventListener('change',sync);
  document.addEventListener('visibilitychange',sync);
  new MutationObserver(sync).observe(document.documentElement,{attributes:true,attributeFilter:['data-motion-state']});
  if('IntersectionObserver' in window){
    new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;sync();},{threshold:.2}).observe(figure);
  }else{visible=true;}
  sync();
})();
