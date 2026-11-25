/* Madrid — Urban Nature Map. React 18 + htm, no build step.
   Data: data/{trees,osm,buildings}.json (scripts/trees.py, osm.py, buildings.py),
         data/cases.json and media/ (scripts/build_archive.py, from db/archivo_fotografias.xlsx + db/fotografias),
         data/places.json (scripts/places.py),
         tiles/1956 (scripts/ortho1956.py). The map frame constants match scripts/frame.py. */
'use strict';
const {useState,useEffect,useLayoutEffect,useRef,useCallback}=React;
const html=htm.bind(React.createElement);
const KM=1000, STEPS=[1000,500,250,100,50], PHOTO_PX=110;
const REDUCED=matchMedia('(prefers-reduced-motion: reduce)').matches;
// grid refines as you zoom: the coarsest step whose square is no bigger than ~2 photo footprints
const stepFor=s=>STEPS.find(st=>st*s<=PHOTO_PX*1.25)||STEPS[STEPS.length-1];
const fmtStep=st=>st>=1000?st/1000+' km':st+' m';
// the squares that hold cases: n x n grid steps, about one photo footprint on screen
const gridFor=s=>{const st=stepFor(s),n=Math.max(1,Math.round(PHOTO_PX/(st*s)));return {st,B:n*st}};

/* ---------- data ---------- */
const b64=(s,T)=>{const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return new T(u.buffer)};
async function loadData(){
  const get=u=>fetch(u).then(r=>{if(!r.ok)throw new Error(u+' '+r.status);return r.json()});
  const [t,o,bu,pl]=await Promise.all([get('data/trees.json'),get('data/osm.json'),get('data/buildings.json'),get('data/places.json').catch(()=>({places:[]}))]);
  const x=b64(t.x,Int16Array),y=b64(t.y,Int16Array),h=b64(t.h_quarter_m,Uint8Array);
  const r=new Float32Array(x.length);for(let i=0;i<r.length;i++)r[i]=1.2+h[i]/4*.28; // crown radius (m) from height
  const paths={};
  for(const k of ['water','green']){const p=new Path2D();for(const d of o.layers[k]||[]){let px=0,py=0;for(let i=0;i<d.length;i+=2){px+=d[i];py+=d[i+1];i?p.lineTo(px,py):p.moveTo(px,py)}p.closePath()}paths[k]=p}
  const bld=bu.rings.map(c=>{const L=b64(c.len,Uint16Array),d=b64(c.d,Int16Array),p=new Path2D();let j=0;
    for(let k=0;k<L.length;k++){let px=0,py=0;for(let i=0;i<L[k];i++,j+=2){px+=d[j];py+=d[j+1];i?p.lineTo(px,py):p.moveTo(px,py)}p.closePath()}return p});
  return {W:t.frame[0],H:t.frame[1],origin:t.origin,n:x.length,x,y,r,paths,bld,places:pl.places};
}
/* a square's name: the nearest place of a level that suits its size (districts for 2 km and up, barrios down to 500 m,
   then plazas and neighbourhoods), found within about the square's size of its centre; else the nearest barrio */
const PLACE_LEVELS=size=>size>=2000?['suburb']:size>=500?['quarter','suburb']:['square','neighbourhood','quarter'];
const nameCache=new Map();
function squareName(D,T){const k=T.x0+','+T.y0+','+T.size;if(nameCache.has(k))return nameCache.get(k);
  const cx=T.x0+T.size/2,cy=T.y0+T.size/2,d=p=>Math.hypot(p[2]-cx,p[3]-cy),near=ps=>ps.reduce((a,p)=>!a||d(p)<d(a)?p:a,null);
  let best=null;for(const t of PLACE_LEVELS(T.size)){const p=near(D.places.filter(p=>p[1]===t&&d(p)<=T.size*.9));if(p){best=p;break}}
  if(!best)best=near(D.places.filter(p=>p[1]==='quarter'));
  const name=best?best[0]:'';nameCache.set(k,name);return name}
const toLocal=(D,lon,lat)=>[(lon-D.origin[0])*111320*Math.cos(D.origin[1]*Math.PI/180),(lat-D.origin[1])*110574];
const kmCell=(D,x,y)=>String.fromCharCode(65+Math.floor((x+D.W)/KM))+(Math.floor((y+D.H)/KM)+1);

/* ---------- orthophotos ----------
   1956: Vuelo Americano Serie B, cut into our own tiles aligned to the map frame (scripts/ortho1956.py):
         level L = 0.5*2^L m/px, 512 px tiles, column from the west edge, row from the south edge.
   hoy:  PNOA, IGN's pre-rendered Web Mercator tiles (fast, cached at IGN), placed by their corner coordinates. */
const T56={res:.5,tile:512,top:4,pad:2048,url:(L,c,r)=>`tiles/1956/${L}/${c}_${r}.jpg`};
const PNOA=(z,x,y)=>`https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&layer=OI.OrthoimageCoverage&style=default&tilematrixset=GoogleMapsCompatible&tilematrix=${z}&tilerow=${y}&tilecol=${x}&format=image/jpeg`;
const toLL=(D,x,y)=>[D.origin[0]+x/(111320*Math.cos(D.origin[1]*Math.PI/180)),D.origin[1]+y/110574];
const imgs=new Map();
const getImg=u=>{let q=imgs.get(u);if(!q){q=new Promise(res=>{const im=new Image();im.onload=()=>res(im);im.onerror=()=>res(null);im.src=u});imgs.set(u,q);
  if(imgs.size>800)imgs.delete(imgs.keys().next().value)}return q};
// paint the map rectangle b = {x0,y0,w,h} (metres) into canvas c at pw x ph pixels; tiles land as they arrive
function paintOrtho(c,D,b,which,pw,ph){
  const tok=c._tok=(c._tok||0)+1;if(c.width!==pw)c.width=pw;if(c.height!==ph)c.height=ph;const g=c.getContext('2d');g.fillStyle=col('--b1');g.fillRect(0,0,pw,ph);
  const k=pw/b.w,X=x=>(x-b.x0)*k,Y=y=>(b.y0+b.h-y)*k,put=(u,x0,y0,x1,y1)=>getImg(u).then(im=>{if(im&&c._tok===tok)g.drawImage(im,X(x0),Y(y1),X(x1)-X(x0)+.6,Y(y0)-Y(y1)+.6)});
  const need=b.w/pw,xa=b.x0,xb=b.x0+b.w,ya=b.y0,yb=b.y0+b.h; // metres per pixel wanted
  if(which==='before'){
    const L=Math.max(0,Math.min(T56.top,Math.floor(Math.log2(need/T56.res)))),T=T56.tile*T56.res*2**L;
    const P=T56.pad;for(let cc=Math.floor((Math.max(xa,-D.W-P)+D.W)/T);cc*T-D.W<Math.min(xb,D.W+P);cc++)for(let rr=Math.floor((Math.max(ya,-D.H-P)+D.H)/T);rr*T-D.H<Math.min(yb,D.H+P);rr++)
      put(T56.url(L,cc,rr),cc*T-D.W,rr*T-D.H,(cc+1)*T-D.W,(rr+1)*T-D.H);
  }else{
    const lat0=D.origin[1]*Math.PI/180,z=Math.max(10,Math.min(19,Math.ceil(Math.log2(156543.034*Math.cos(lat0)/need)))),n=2**z;
    const tx=lon=>(lon+180)/360*n,ty=lat=>{const f=lat*Math.PI/180;return(1-Math.log(Math.tan(f)+1/Math.cos(f))/Math.PI)/2*n};
    const lon=t=>t/n*360-180,lat=t=>Math.atan(Math.sinh(Math.PI*(1-2*t/n)))*180/Math.PI,loc=(lo,la)=>[(lo-D.origin[0])*111320*Math.cos(lat0),(la-D.origin[1])*110574];
    const [lo0,la0]=toLL(D,xa,ya),[lo1,la1]=toLL(D,xb,yb);
    for(let i=Math.floor(tx(lo0));i<=Math.floor(tx(lo1));i++)for(let j=Math.floor(ty(la1));j<=Math.floor(ty(la0));j++){
      const [x0,y1]=loc(lon(i),lat(j)),[x1,y0]=loc(lon(i+1),lat(j+1));put(PNOA(z,i,j),x0,y0,x1,y1)}
  }
}
// a canvas showing one year of orthophoto for square b; resolution follows its on-screen size (rounded up to a power of two)
function Ortho({D,b,which,size,cls}){
  const cv=useRef(),px=Math.min(2048,2**Math.ceil(Math.log2(Math.max(64,size*(devicePixelRatio||1)))));
  useEffect(()=>{paintOrtho(cv.current,D,{x0:b.x0,y0:b.y0,w:b.size,h:b.size},which,px,px)},[b.x0,b.y0,b.size,which,px]);
  return html`<canvas ref=${cv} class=${cls} aria-hidden="true"></canvas>`}

/* ---------- the archive: cases ----------
   A case is one geolocated record: exact (a point) or approximate (a point and a radius r in metres), holding any number of items:
   versions {photos:[{src,label}...]} · photo {src,label} · text {body,label} · audio {src,label} · file {src,label}. Source: data/cases.json.
   Cases you add live in this browser (IndexedDB). */
const leadIndex=c=>{for(const t of ['versions','photo','audio','text','file']){const i=c.items.findIndex(it=>it.type===t);if(i>=0)return i}return 0};
const catNo=c=>'Nº '+String(c.n).padStart(3,'0');
const where=c=>c.loc==='estimate'?'estimated ±'+c.r+' m, to check':c.loc==='gps'?'from the photo\'s GPS':c.r?'approx. ±'+c.r+' m':'exact location';
const mapLink=c=>c.lat!=null&&`https://www.google.com/maps?q=${c.lat},${c.lon}`;
const itemName=it=>it.type==='versions'?'Versions '+it.photos.map(p=>p.v).join(' · '):it.label||(it.type==='text'?it.body.slice(0,40):it.type==='photo'?'Photo':it.src.split('/').pop());
const ext=s=>(s.split('.').pop()||'').toLowerCase();
// cases saved by an earlier version of this page were single photos {id,title,x,y,before?,after}
const fromLegacy=p=>p.items?p:{id:p.id,title:p.title,x:p.x,y:p.y,items:[p.before?{type:'versions',photos:[{...p.before,v:'a'},{...p.after,v:'b'}]}:{type:'photo',...p.after}]};
const firstSrc=it=>it.type==='versions'?it.photos[0].src:it.type==='photo'?it.src:null;

const idb=()=>new Promise((res,rej)=>{try{const q=indexedDB.open('lnu-photos-v2',1);q.onupgradeneeded=()=>q.result.createObjectStore('p');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)}catch(e){rej(e)}});
async function dbAll(){try{const d=await idb();return await new Promise(res=>{const out={},c=d.transaction('p').objectStore('p').openCursor();c.onsuccess=()=>{const k=c.result;if(k){out[k.key]=k.value;k.continue()}else res(out)};c.onerror=()=>res(out)})}catch(e){return{}}}
async function dbPut(k,v){try{const d=await idb(),st=d.transaction('p','readwrite').objectStore('p');v?st.put(v,k):st.delete(k)}catch(e){}}
const shrink=file=>new Promise((res,rej)=>{const u=URL.createObjectURL(file),im=new Image();im.onload=()=>{const k=Math.min(1,1000/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=im.width*k;c.height=im.height*k;c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);res(c.toDataURL('image/jpeg',.84))};im.onerror=rej;im.src=u});

/* matched black and white: neutral grey (removes sepia and yellowing), levels stretched to the 1st-99th percentile,
   then a gamma that puts the median at mid-grey, so a pair's two photos compare on equal terms. Cached per source. */
const eqCache=new Map();
function equalize(src){let q=eqCache.get(src);if(q)return q;
  q=new Promise(res=>{const im=new Image();im.onerror=()=>res(src);im.onload=()=>{try{
    const k=Math.min(1,1400/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=Math.round(im.width*k);c.height=Math.round(im.height*k);
    const g=c.getContext('2d');g.drawImage(im,0,0,c.width,c.height);const d=g.getImageData(0,0,c.width,c.height),a=d.data,n=a.length/4,L=new Uint8ClampedArray(n),h=new Uint32Array(256);
    for(let i=0;i<n;i++){L[i]=.2126*a[4*i]+.7152*a[4*i+1]+.0722*a[4*i+2];h[L[i]]++}
    let lo=0,hi=255,acc=0,med=0;for(;lo<254&&(acc+=h[lo])<n*.01;lo++);acc=0;for(;hi>lo+1&&(acc+=h[hi])<n*.01;hi--);
    acc=0;for(;med<255&&(acc+=h[med])<n/2;med++);
    const m=Math.min(.95,Math.max(.05,(med-lo)/(hi-lo))),gam=Math.min(1.6,Math.max(.6,Math.log(.5)/Math.log(m))),lut=new Uint8ClampedArray(256);
    for(let v=0;v<256;v++)lut[v]=255*Math.pow(Math.min(1,Math.max(0,(v-lo)/(hi-lo))),gam);
    for(let i=0;i<n;i++)a[4*i]=a[4*i+1]=a[4*i+2]=lut[L[i]];
    g.putImageData(d,0,0);res(c.toDataURL('image/jpeg',.88))}catch(e){res(src)}};im.src=src});
  eqCache.set(src,q);return q}
// a photo that switches to its matched black-and-white version when eq is on
function Pic({src,eq,cls,alt,style}){const [out,setOut]=useState(null);
  useEffect(()=>{let live=true;setOut(null);if(eq)equalize(src).then(u=>live&&setOut(u));return()=>{live=false}},[src,eq]);
  return html`<img src=${eq&&out?out:src} class=${cls} style=${style} alt=${alt||''} draggable="false"/>`}
// a card's versions: the first shows; while the card is lit they take turns, cross-fading
function Cycle({photos,eq,on}){const [k,setK]=useState(0);
  useEffect(()=>{if(!on){setK(0);return}setK(1%photos.length);const iv=setInterval(()=>setK(x=>(x+1)%photos.length),1300);return()=>clearInterval(iv)},[on,photos.length]);
  return photos.map((p,i)=>html`<${Pic} key=${p.src} cls=${'v'+(i===k?' on':'')} src=${p.src} eq=${eq}/>`)}

/* sound: one plays at a time; the waveform is the file's own, decoded once */
const peaksCache=new Map();let playing=null;
const peaksOf=(src,n)=>{const k=src+'|'+n;let q=peaksCache.get(k);if(!q){q=fetch(src).then(r=>r.arrayBuffer()).then(b=>new OfflineAudioContext(1,1,22050).decodeAudioData(b)).then(a=>{
  const d=a.getChannelData(0),w=Math.floor(d.length/n),o=[];for(let i=0;i<n;i++){let m=0;for(let j=i*w;j<(i+1)*w;j+=4)m=Math.max(m,Math.abs(d[j]));o.push(m)}
  const M=Math.max(...o)||1;return o.map(x=>x/M)}).catch(()=>null);peaksCache.set(k,q)}return q};
function Sound({src,label,variant}){ // variant: 'dot' (play button only), 'mini' (card), 'big' (stage)
  const a=useRef(),n=variant==='big'?96:variant==='mini'?22:48,[pk,setPk]=useState(null),[t,setT]=useState(0),[on,setOn]=useState(false);
  useEffect(()=>{let live=true;if(variant!=='dot')peaksOf(src,n).then(p=>live&&setPk(p));return()=>{live=false;a.current&&a.current.pause()}},[src,n]);
  const stop=e=>e.stopPropagation();
  const toggle=e=>{stop(e);const el=a.current;if(el.paused){if(playing&&playing!==el)playing.pause();playing=el;el.play()}else el.pause()};
  const seek=e=>{stop(e);const el=a.current,b=e.currentTarget.getBoundingClientRect();if(el.duration){el.currentTime=(e.clientX-b.left)/b.width*el.duration;if(el.paused)toggle(e)}};
  const btn=html`<button class=${variant==='dot'?'dot':'play'} aria-label=${(on?'Pause ':'Play ')+(label||'audio')} onClick=${toggle} onPointerDown=${stop} onPointerUp=${stop}>${on?'❚❚':'▶'}</button>`;
  const el=html`<audio ref=${a} src=${src} preload="metadata" onPlay=${()=>setOn(true)} onPause=${()=>setOn(false)} onEnded=${()=>{setOn(false);setT(0)}} onTimeUpdate=${e=>setT(e.target.currentTime/(e.target.duration||1))}/>`;
  if(variant==='dot')return html`${el}${btn}`;
  return html`<div class=${'sound '+(variant||'')+(on?' on':'')}>${el}${btn}
    <div class="wave" onClick=${seek} onPointerDown=${stop} onPointerUp=${stop}>${(pk||Array(n).fill(.12)).map((h,i)=>html`<i key=${i} class=${(i+.5)/n<=t?'done':''} style=${{height:Math.max(6,h*100)+'%'}}></i>`)}</div></div>`}

/* canvas can't read light-dark() variables: resolve them through a probe element */
const probe=document.createElement('i');probe.style.display='none';document.body.appendChild(probe);
const col=n=>{probe.style.color=`var(${n})`;return getComputedStyle(probe).color};

/* squares: every grid square (of the zoom's size) that holds at least one case. An approximate case is shown only while its
   uncertainty (2r) fits in a square: zoomed in further, the archive cannot say which square it belongs to, so it is left out. */
const tileOf=(D,B,x,y)=>[Math.floor((x+D.W)/B),Math.floor((y+D.H)/B)];
function tilesFor(D,cases,B){const t={};
  for(const c of Object.values(cases)){if(2*c.r>B)continue;const [i,j]=tileOf(D,B,c.x,c.y),k=i+','+j;
    (t[k]||(t[k]={key:k,x0:-D.W+i*B,y0:-D.H+j*B,size:B,ids:[]})).ids.push(c.id)}
  for(const q of Object.values(t))q.ids.sort((a,b)=>cases[a].n-cases[b].n);return t}
const hash=s=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return (h>>>0)/4294967296};
/* ---------- laying out cards ----------
   A card takes w x h grid squares chosen from its content, inset by a small gutter. Each is packed near its anchor square,
   outside a blocked zone, nearest first and spread round the compass (a card in a crowded direction costs more). */
const aspects=new Map(); // photo src -> width/height, filled as images load
const preloadAspects=(cases,done)=>{for(const c of Object.values(cases))for(const it of c.items){const src=firstSrc(it);
  if(src&&!aspects.has(src)){aspects.set(src,null);getImg(src).then(im=>{aspects.set(src,im?im.naturalWidth/im.naturalHeight:1.33);done()})}}};
function shapes(it,big){
  if(firstSrc(it)){const r=aspects.get(firstSrc(it))||1.33;
    if(r>=1.2)return big?[[3,2],[2,1],[1,1]]:[[2,1],[1,1]];
    if(r<=.83)return big?[[2,3],[1,2],[1,1]]:[[1,2],[1,1]];
    return big?[[2,2],[1,1]]:[[1,1]]}
  if(it.type==='text')return big?[[2,2],[2,1],[1,1]]:[[2,1],[1,1]];
  if(it.type==='audio')return [[2,1],[1,1]];
  return [[1,1]]}
const GUT=5;
// ctx: {U (square side, m), ox,oy (grid origin, m), v, bw,bh, avoid, blocked(i,j), reach, occ:Set, dirs:Map}
function packOne(L,ctx){const {U,ox,oy,v,bw,bh,avoid,blocked,reach,occ,dirs}=ctx;
  for(const [w,h] of L.shapes){let best=null;
    for(let i=L.ai-reach-w+1;i<=L.ai+reach;i++)for(let j=L.aj-reach-h+1;j<=L.aj+reach;j++){
      let ok=true;for(let a=0;a<w&&ok;a++)for(let b=0;b<h&&ok;b++)if(occ.has((i+a)+','+(j+b))||blocked(i+a,j+b))ok=false;if(!ok)continue;
      const left=v.tx+(ox+i*U)*v.s+GUT,top=v.ty-(oy+(j+h)*U)*v.s+GUT,W=w*U*v.s-2*GUT,H=h*U*v.s-2*GUT;
      if(left<10||top<10||left+W>bw-10||top+H>bh-10)continue;
      if(avoid.some(r=>left<r.right+6&&left+W>r.left-6&&top<r.bottom+6&&top+H>r.top-6))continue;
      const cx=i+w/2-(L.ai+.5),cy=j+h/2-(L.aj+.5),oct=(Math.round(Math.atan2(cy,cx)/(Math.PI/4))+8)%8;
      const sc=Math.hypot(cx,cy)+1.1*(dirs.get(L.anchorKey+oct)||0)+.6*hash(L.key+'|'+i+','+j);
      if(!best||sc<best.sc)best={sc,i,j,w,h,left,top,W,H,oct}}
    if(best){for(let a=0;a<best.w;a++)for(let b=0;b<best.h;b++)occ.add((best.i+a)+','+(best.j+b));
      dirs.set(L.anchorKey+best.oct,(dirs.get(L.anchorKey+best.oct)||0)+1);return {...L,...best}}}
  return null}
// the hairline from a card to a point (screen px): it leaves the card at the edge point nearest to it
const leaderTo=(r,px,py)=>[Math.min(r.left+r.W,Math.max(r.left,px)),Math.min(r.top+r.H,Math.max(r.top,py)),px,py];

/* ---------- map ---------- */
function MapView({D,layers,cases,placing,onPlace,onOpen,paused,children}){
  const box=useRef(),cv=useRef(),under=useRef(),over=useRef(),view=useRef(null),[tick,setTick]=useState(0),[hover,setHover]=useState(null),[wipe,setWipe]=useState(.5),[intro,setIntro]=useState(false),drag=useRef(null),[ptr,setPtr]=useState(null);
  const [pin,setPin]=useState(null),[page,setPage]=useState(0),entering=useRef(false),lastW=useRef(.5),anim=useRef();
  const [lit,setLit]=useState(null),avoid=useRef({s:'',a:[]});
  /* The base map is expensive to draw (every building), so it is drawn only once the view settles: while panning or zooming,
     the last drawing is moved and scaled with a CSS transform. Moves are batched to one per frame. */
  const [drawTick,setDrawTick]=useState(0),[moving,setMoving]=useState(false),drawn=useRef(null),raf=useRef(0),settle=useRef();
  const kick=()=>{if(!raf.current)raf.current=requestAnimationFrame(()=>{raf.current=0;setTick(t=>t+1)});
    setMoving(true);clearTimeout(settle.current);settle.current=setTimeout(()=>setMoving(false),650)};
  useEffect(()=>{const t=setTimeout(()=>setDrawTick(x=>x+1),120);return()=>clearTimeout(t)},[tick]);
  useLayoutEffect(()=>{const d=drawn.current,v=view.current;if(!d||!v)return;const k=v.s/d.s;
    cv.current.style.transform=k===1&&v.tx===d.tx&&v.ty===d.ty?'':`translate(${v.tx-d.tx*k}px,${v.ty-d.ty*k}px) scale(${k})`});
  const fit=useCallback(()=>{const b=box.current.getBoundingClientRect(),m=46,s=Math.min((b.width-2*m)/(2*D.W),(b.height-2*m)/(2*D.H));view.current={s,tx:b.width/2,ty:b.height/2,min:s*.7,max:s*60};setTick(t=>t+1)},[D]);
  useEffect(()=>{fit();const ro=new ResizeObserver(()=>fit());ro.observe(box.current);const mo=new MutationObserver(()=>setTick(t=>t+1));mo.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    const mq=matchMedia('(prefers-color-scheme: dark)'),f=()=>setTick(t=>t+1);mq.addEventListener('change',f);return()=>{ro.disconnect();mo.disconnect();mq.removeEventListener('change',f)}},[fit]);

  useEffect(()=>{ // draw
    const v=view.current;if(!v)return;const c=cv.current,b=box.current.getBoundingClientRect(),dpr=devicePixelRatio||1;drawn.current={s:v.s,tx:v.tx,ty:v.ty};c.style.transform='';
    c.width=b.width*dpr;c.height=b.height*dpr;const g=c.getContext('2d');
    const {s,tx,ty}=v,W=D.W,H=D.H,sx=x=>tx+x*s,sy=y=>ty-y*s,st=stepFor(s);
    g.setTransform(dpr,0,0,dpr,0,0);g.save();g.beginPath();g.rect(sx(-W),sy(H),2*W*s,2*H*s);g.clip();g.fillStyle=col('--bg');g.fill();
    g.setTransform(dpr*s,0,0,-dpr*s,dpr*tx,dpr*ty);
    if(layers.green){g.fillStyle=col('--green');g.fill(D.paths.green)}
    if(layers.buildings){D.bld.forEach((p,i)=>{g.fillStyle=col('--b'+i);g.fill(p,'evenodd')})}
    // water courses lead: drawn above buildings, with a 2 px outline so the river stays a continuous ribbon
    if(layers.water){g.fillStyle=g.strokeStyle=col('--water');g.fill(D.paths.water);g.lineJoin='round';g.lineWidth=2/s;g.stroke(D.paths.water)}
    g.setTransform(dpr,0,0,dpr,0,0);
    if(layers.trees){ // trees in screen space, culled to the view
      const x0=-tx/s,x1=(b.width-tx)/s,y1=ty/s,y0=(ty-b.height)/s,big=s>.35,zf=Math.min(2.2,1+s*1.5);
      g.fillStyle=col('--tree');g.globalAlpha=big?.7:.32+Math.min(.35,s*.8);if(big)g.beginPath();
      for(let i=0;i<D.n;i++){const x=D.x[i],y=D.y[i];if(x<x0-20||x>x1+20||y<y0-20||y>y1+20)continue;const X=tx+x*s,Y=ty-y*s;
        if(big){const r=Math.max(1.6,D.r[i]*s);g.moveTo(X+r,Y);g.arc(X,Y,r,0,6.2832)}else{const z=.85*zf;g.fillRect(X-z/2,Y-z/2,z,z)}}
      if(big)g.fill();g.globalAlpha=1;
    }
    g.restore();
  },[drawTick,D,layers.green,layers.water,layers.buildings,layers.trees]);
  /* Cheap layers redrawn on every move, so the grid is always there while the base map catches up:
     under it, the frame's ground (the paper texture shows outside); over it, the grid, the frame and its labels. */
  useLayoutEffect(()=>{const v=view.current;if(!v)return;const b=box.current.getBoundingClientRect(),dpr=devicePixelRatio||1,{s,tx,ty}=v,W=D.W,H=D.H,sx=x=>tx+x*s,sy=y=>ty-y*s;
    const prep=c=>{const w=Math.round(b.width*dpr),h=Math.round(b.height*dpr);if(c.width!==w)c.width=w;if(c.height!==h)c.height=h;const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,b.width,b.height);return g};
    box.current.style.backgroundPosition=`${tx}px ${ty}px`; // the paper outside the frame moves with the map
    let g=prep(under.current);g.fillStyle=col('--bg');g.fillRect(sx(-W),sy(H),2*W*s,2*H*s);
    g=prep(over.current);g.save();g.beginPath();g.rect(sx(-W),sy(H),2*W*s,2*H*s);g.clip();
    const line=(stp,css)=>{g.strokeStyle=col(css);g.lineWidth=1;g.beginPath();   // grid: fine steps light, kilometres stronger
      const xa=Math.max(-W,-tx/s),xb=Math.min(W,(b.width-tx)/s),ya=Math.max(-H,(ty-b.height)/s),yb=Math.min(H,ty/s);
      for(let x=Math.ceil((xa+W)/stp)*stp-W;x<=xb;x+=stp){const X=Math.round(sx(x))+.5;g.moveTo(X,sy(H));g.lineTo(X,sy(-H))}
      for(let y=Math.ceil((ya+H)/stp)*stp-H;y<=yb;y+=stp){const Y=Math.round(sy(y))+.5;g.moveTo(sx(-W),Y);g.lineTo(sx(W),Y)}g.stroke()};
    const st=stepFor(s);if(st<KM)line(st,'--grid');line(KM,'--gridk');g.restore();
    g.strokeStyle=col('--frame');g.lineWidth=1;g.strokeRect(sx(-W)+.5,sy(H)+.5,2*W*s,2*H*s);
    g.fillStyle=col('--mute');g.font='11px "Instrument Sans",system-ui,sans-serif';g.textBaseline='middle';
    const L=Math.max(4,sx(-W)-6);g.textAlign='right';
    for(let k=1;k<=2*H/KM;k++){const Y=sy(-H+k*KM);if(Y<8||Y>b.height-8)continue;g.fillText(k+' km',L-6,Y)}
    g.textAlign='center';const B=Math.min(b.height-12,sy(-H)+16);
    for(let c=0;c<2*W/KM;c++){const X=sx(-W+(c+.5)*KM);if(X>12&&X<b.width-12)g.fillText(String.fromCharCode(65+c),X,B)}
    g.fillStyle=col('--ink');g.font='600 18px "Instrument Sans",system-ui,sans-serif';const T=sy(H)-18;if(T>14)g.fillText('N',sx(0),T)});

  const v=view.current,G=v&&gridFor(v.s),tiles=v?tilesFor(D,cases,G.B):{};
  const toM=e=>{const b=box.current.getBoundingClientRect(),v=view.current;return [(e.clientX-b.left-v.tx)/v.s,(v.ty-(e.clientY-b.top))/v.s]};
  const inFrame=([x,y])=>Math.abs(x)<=D.W&&Math.abs(y)<=D.H;
  const inside=(T,[x,y])=>x>=T.x0&&x<T.x0+T.size&&y>=T.y0&&y<T.y0+T.size;
  const hit=e=>{if(!layers.cases)return null;const m=toM(e);return Object.values(tiles).find(k=>inside(k,m))||null};
  const rect=k=>({left:v.tx+k.x0*v.s,top:v.ty-(k.y0+k.size)*v.s,width:k.size*v.s,height:k.size*v.s});
  const zoomAt=(px,py,f)=>{const v=view.current,ns=Math.min(v.max,Math.max(v.min,v.s*f)),k=ns/v.s;v.tx=px-(px-v.tx)*k;v.ty=py-(py-v.ty)*k;v.s=ns;kick()};
  useEffect(()=>{const el=box.current,h=e=>{if(e.target.closest('.legend'))return;e.preventDefault();cancelAnimationFrame(anim.current);const b=el.getBoundingClientRect();zoomAt(e.clientX-b.left,e.clientY-b.top,Math.exp(-e.deltaY*.0015))};el.addEventListener('wheel',h,{passive:false});return()=>el.removeEventListener('wheel',h)},[]);
  const glide=to=>{cancelAnimationFrame(anim.current);const v=view.current,a={tx:v.tx,ty:v.ty},t0=performance.now(),T=REDUCED?1:650;
    const f=t=>{const k=Math.min(1,(t-t0)/T),e=1-Math.pow(1-k,3);v.tx=a.tx+(to.tx-a.tx)*e;v.ty=a.ty+(to.ty-a.ty)*e;kick();if(k<1)anim.current=requestAnimationFrame(f)};anim.current=requestAnimationFrame(f)};

  /* ---- hover and pin ---- */
  const F=pin||(!placing&&hover&&tiles[hover])||null,focus=!!F;
  const enter=g=>{setHover(g?g.key:null);if(!g)return;setIntro(true);setWipe(1);entering.current=true; // the old photo sweeps open from the right to the pointer
    requestAnimationFrame(()=>requestAnimationFrame(()=>{entering.current=false;setWipe(lastW.current)}));clearTimeout(enter.t);enter.t=setTimeout(()=>setIntro(false),600)};
  const doPin=g=>{const P={key:'pin',x0:g.x0,y0:g.y0,size:g.size,ids:g.ids};setPin(P);setPage(0);setHover(null);setLit(null);setIntro(false);
    const b=box.current.getBoundingClientRect(),v=view.current;glide({tx:b.width/2-(g.x0+g.size/2)*v.s,ty:b.height/2+(g.y0+g.size/2)*v.s})};
  const openTile=(T,id,item,from)=>onOpen({tile:{x0:T.x0,y0:T.y0,size:T.size,ids:T.ids},id:id||(T.ids.length===1?T.ids[0]:null),item:item==null?null:item,from:from||rect(T)});
  const openItem=(id,item,el)=>{const c=cases[id];if(!c)return;let T=pin&&pin.ids.includes(id)?pin:null;
    if(!T){const [i,j]=tileOf(D,G.B,c.x,c.y);T=tiles[i+','+j]}if(!T)return;
    const bb=box.current.getBoundingClientRect(),r=el.getBoundingClientRect();setLit(null);
    openTile(T,id,item==null?leadIndex(c):item,{left:r.left-bb.left,top:r.top-bb.top,width:r.width,height:r.height})};

  // the controls: cards keep clear of them (re-measured after each render, re-laid out if they moved)
  useLayoutEffect(()=>{const bb=box.current.getBoundingClientRect();
    const a=[...box.current.querySelectorAll('.legend,.tools,.title')].map(el=>{const r=el.getBoundingClientRect();return {left:r.left-bb.left,top:r.top-bb.top,right:r.right-bb.left,bottom:r.bottom-bb.top}});
    const s=JSON.stringify(a.map(o=>[o.left,o.top,o.right,o.bottom].map(Math.round)));if(s!==avoid.current.s){avoid.current={s,a};setTick(t=>t+1)}});
  // keys while a square is pinned: ← → pages, Enter opens, Esc lets go
  useEffect(()=>{if(!pin||paused)return;const h=e=>{if(e.target.closest('input'))return;
      if(e.key==='Escape')setPin(null);else if(e.key==='ArrowRight')setPage(p=>p+1);else if(e.key==='ArrowLeft')setPage(p=>p-1);else if(e.key==='Enter'&&!e.target.closest('.card,button'))openTile(pin)};
    addEventListener('keydown',h);return()=>removeEventListener('keydown',h)});

  /* ---- layout ---- */
  const bsz=v&&box.current.getBoundingClientRect(),base=v&&{v,bw:bsz.width,bh:bsz.height,avoid:avoid.current.a};
  // a pinned square lays out all its files around it, a page at a time, a square of air around it and never outside the frame
  let plot=[],pages=1,pg=0;
  if(v&&pin){const F=pin,all=[];const cs=F.ids.map(id=>cases[id]).filter(Boolean),li=cs.map(leadIndex);
    cs.forEach((c,k)=>all.push([c.id,li[k]]));cs.forEach((c,k)=>c.items.forEach((_,i)=>{if(i!==li[k])all.push([c.id,i])}));
    const U=F.size,outside=(i,j)=>F.x0+i*U< -D.W||F.x0+(i+1)*U>D.W||F.y0+j*U< -D.H||F.y0+(j+1)*U>D.H;
    const run=(st,max,big)=>{const ctx={...base,U,ox:F.x0,oy:F.y0,occ:new Set(),dirs:new Map(),reach:4,blocked:(i,j)=>Math.abs(i)<=1&&Math.abs(j)<=1||outside(i,j)},out=[];
      for(let k=st;k<all.length&&out.length<max;k++){const [id,ii]=all[k],key='f'+id+'.'+ii;
        const r=packOne({key,ai:0,aj:0,anchorKey:'',shapes:shapes(cases[id].items[ii],big&&(!out.length||hash(key)<.3)),id,item:ii},ctx);if(!r)break;out.push(r)}return out};
    const P=[];for(let st=0;st<all.length&&P.length<40;){const o=run(st,99,true);P.push(o);st+=Math.max(1,o.length)}
    pages=Math.max(1,P.length);pg=((page%pages)+pages)%pages;plot=P[pg]||[]}

  /* ---- pointer ---- */
  const down=e=>{if(e.target.closest&&e.target.closest('.pager'))return;const cd=e.target.closest&&e.target.closest('.card');box.current.setPointerCapture(e.pointerId);cancelAnimationFrame(anim.current);
    drag.current={x:e.clientX,y:e.clientY,moved:0,card:cd&&{id:cd.dataset.id,item:cd.dataset.item!=null?+cd.dataset.item:null,el:cd}}};
  const move=e=>{const d=drag.current;if(d){const v=view.current;v.tx+=e.clientX-d.x;v.ty+=e.clientY-d.y;d.moved+=Math.abs(e.clientX-d.x)+Math.abs(e.clientY-d.y);d.x=e.clientX;d.y=e.clientY;kick();return}
    if(placing){const m=toM(e);setPtr(inFrame(m)?m:null);return}
    const m=toM(e);
    if(pin){if(inside(pin,m)){lastW.current=(m[0]-pin.x0)/pin.size;setWipe(lastW.current)}return}
    if(e.target.closest&&e.target.closest('.card'))return;
    const g=hit(e);if(g)lastW.current=(m[0]-g.x0)/g.size;
    if((g&&g.key)!==hover)enter(g);else if(g&&!entering.current)setWipe(lastW.current)};
  const up=e=>{const d=drag.current;drag.current=null;if(!d)return;if(d.moved>=4){setTick(t=>t+1);return}const m=toM(e);
    if(placing){if(inFrame(m))onPlace({x:m[0],y:m[1]});return}
    if(d.card){openItem(d.card.id,d.card.item,d.card.el);return}
    if(pin&&inside(pin,m)){openTile(pin);return}
    const g=hit(e);if(g)doPin(g);else if(pin)setPin(null)};
  const drop=e=>{e.preventDefault();const f=[...e.dataTransfer.files].find(f=>f.type.startsWith('image/')),m=toM(e);if(!f||!inFrame(m))return;
    const cd=e.target.closest('.card'),c=cd&&cases[cd.dataset.id];onPlace(c&&c.own?{id:c.id}:{x:m[0],y:m[1]},f)};

  /* ---- render ---- */
  const tileEl=(g,on,isPin)=>{const z=g.size*v.s,b={x0:g.x0,y0:g.y0,size:g.size},n=g.ids.length;
    return html`<div key=${isPin?'pin':g.key} class=${'blk'+(g.ids.every(id=>cases[id]&&cases[id].r>0)?' approx':'')+(on?' on':'')+(isPin?' pin':'')+(on&&intro&&!isPin?' intro':'')} style=${{...rect(g),'--w':(on?wipe:.5)*100+'%'}}>
      <i class="lift"></i>
      ${(on||layers.ortho)&&html`<div class="orth"><${Ortho} D=${D} b=${b} which="after" size=${z} cls="now"/><${Ortho} D=${D} b=${b} which="before" size=${z} cls="bf"/><i class="seam"></i>
        ${on&&z>90&&html`<span class="tg" style=${{left:4}}>1956</span><span class="tg" style=${{right:4}}>hoy</span>`}</div>`}
      <div class="mark"></div><span class="count" style=${{fontSize:Math.max(15,Math.min(40,z*.24))}} aria-label=${n+(n>1?' cases':' case')}>${n}</span>
      ${isPin&&html`<span class="corners" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`}
      ${z>=90&&!on&&html`<span class="nm">${squareName(D,g)}</span>`}
      ${on&&html`<div class="tab">${squareName(D,g)} <i>${kmCell(D,g.x0+g.size/2,g.y0+g.size/2)} · ${fmtStep(g.size)}</i> · ${n} ${n>1?'cases':'case'} <i>· ${isPin?'click to open':'click to pin'}</i></div>`}</div>`};
  const media=(c,it,on)=>{const snd=it.type!=='audio'&&c.items.find(x=>x.type==='audio');
    return firstSrc(it)?html`<div class="media">${it.type==='versions'?html`<${Cycle} photos=${it.photos} eq=${layers.bw} on=${on}/>`:html`<${Pic} src=${it.src} eq=${layers.bw}/>`}${snd&&html`<${Sound} src=${snd.src} label=${snd.label} variant="dot"/>`}</div>`
      :it.type==='audio'?html`<div class="media snd"><${Sound} src=${it.src} label=${it.label} variant="mini"/></div>`
      :it.type==='text'?html`<div class="media txt"><p>${it.body}</p></div>`
      :html`<div class="media file"><b>▤</b>${ext(it.src)}</div>`};
  const cardEl=(r,cls,d,label,item)=>{const c=cases[r.id],it=c.items[r.item];
    return html`<div key=${r.key} data-id=${c.id} data-item=${item} class=${'card '+cls+(lit===r.key?' lit':'')} style=${{left:r.left,top:r.top,width:r.W,height:r.H,'--d':d+'s'}}
        role="button" tabIndex="0" aria-label=${catNo(c)+', '+c.title+', '+label} onPointerEnter=${()=>setLit(r.key)} onPointerLeave=${()=>setLit(null)}
        onFocus=${()=>setLit(r.key)} onBlur=${()=>setLit(null)} onKeyDown=${e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();openItem(c.id,item,e.currentTarget)}}}>
      <div class="sheet">${media(c,it,lit===r.key)}</div><span class="lab"><i>${catNo(c)}</i>${c.title}</span></div>`};
  const FR=F&&rect(F);
  return html`<div ref=${box} class=${'map'+(drag.current?' drag':'')+(placing?' placing':hover||pin?' over':'')+(layers.ortho?' orthomap':'')+(focus?' focus':'')} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up}
      onPointerLeave=${()=>{setHover(null);setPtr(null)}} onDragOver=${e=>e.preventDefault()} onDrop=${drop}>
    <canvas ref=${under} class="under"></canvas><canvas ref=${cv}></canvas><canvas ref=${over} class="over"></canvas>
    <div class="title"><b>Madrid</b> · arbolado 2026</div>
    ${v&&layers.cases&&Object.values(tiles).filter(g=>!(pin&&g.x0<pin.x0+pin.size&&g.x0+g.size>pin.x0&&g.y0<pin.y0+pin.size&&g.y0+g.size>pin.y0)).map(g=>tileEl(g,!pin&&hover===g.key,false))}
    ${v&&pin&&tileEl(pin,true,true)}
    ${v&&html`<svg class="leads" aria-hidden="true">
      ${plot.map((r,k)=>{const c=cases[r.id],[x1,y1,x2,y2]=leaderTo(r,v.tx+c.x*v.s,v.ty-c.y*v.s);return html`<g key=${'p'+r.key} class=${lit==='p'+r.key?'lit':''} style=${{'--d':.25+k*.07+'s'}}><line pathLength="1" x1=${x1} y1=${y1} x2=${x2} y2=${y2}/></g>`})}
      ${pin&&pin.ids.map(id=>{const c=cases[id];if(!c)return null;const on=lit&&lit.slice(1).startsWith('f'+id+'.'),X=v.tx+c.x*v.s,Y=v.ty-c.y*v.s;
        return html`<g key=${'d'+id}>${c.r>0&&html`<circle class="unc" cx=${X} cy=${Y} r=${c.r*v.s}/>`}<circle class=${'dot'+(on?' lit':'')} cx=${X} cy=${Y} r="3.5"/></g>`})}</svg>`}
    ${plot.map((r,k)=>cardEl({...r,key:'p'+r.key},'',.25+k*.07,itemName(cases[r.id].items[r.item]),r.item))}
    ${pin&&pages>1&&html`<div class="pager" style=${{left:FR.left+FR.width/2,top:FR.top+FR.height+12}} onPointerDown=${e=>e.stopPropagation()} onPointerUp=${e=>e.stopPropagation()}>
      <button aria-label="Previous files" onClick=${()=>setPage(p=>p-1)}>‹</button><span>${pg+1} / ${pages}</span><button aria-label="Next files" onClick=${()=>setPage(p=>p+1)}>›</button></div>`}
    ${v&&placing&&ptr&&(()=>{const [i,j]=tileOf(D,G.B,ptr[0],ptr[1]);return html`<div class="hint" style=${rect({x0:-D.W+i*G.B,y0:-D.H+j*G.B,size:G.B})}></div>`})()}
    <div class="tools" onPointerDown=${e=>e.stopPropagation()}>
      <button aria-label="Zoom in" onClick=${()=>{const b=box.current.getBoundingClientRect();zoomAt(b.width/2,b.height/2,1.6)}}>+</button>
      <button aria-label="Zoom out" onClick=${()=>{const b=box.current.getBoundingClientRect();zoomAt(b.width/2,b.height/2,1/1.6)}}>−</button>
      <button aria-label="Fit map" onClick=${fit}>⤢</button>
    </div>${typeof children==='function'?children(G&&G.st):children}</div>`;
}


/* ---------- explorer: a square opened to the whole screen ---------- */
// today's orthophoto, pannable and zoomable, with 1956 inside a lens of radius rad (metres) around the pointer, or the chosen case when the pointer is away
function LensMap({D,cases,tile,sel,aside}){
  const el=useRef(),now=useRef(),old=useRef(),[size,setSize]=useState(null),[vw,setVw]=useState(null),[ptr,setPtr]=useState(null),[glide,setGlide]=useState(false),drag=useRef(null);
  const c0=sel&&cases[sel],[rad,setRad]=useState(()=>Math.round(c0&&c0.r?c0.r:Math.max(60,Math.min(400,tile.size*.18))));
  useEffect(()=>{const ro=new ResizeObserver(([e])=>setSize({w:e.contentRect.width,h:e.contentRect.height}));ro.observe(el.current);return()=>ro.disconnect()},[]);
  useEffect(()=>{if(size&&!vw){const c=c0||{x:tile.x0+tile.size/2,y:tile.y0+tile.size/2};setVw({cx:c.x,cy:c.y,mpp:tile.size/(Math.min(size.w,size.h)*.62)})}},[size]);
  // choosing a case glides the view and the lens to it; an approximate case sets the lens to its radius
  // with a file open the case sits at a quarter of the width, leaving the rest to the floating file
  useEffect(()=>{if(!vw||!sel)return;const c=cases[sel];if(c.r)setRad(c.r);glideOn();const a={...vw},t0=performance.now(),tx=c.x+(aside?.27*size.w*vw.mpp:0);let raf;
    const f=t=>{const k=Math.min(1,(t-t0)/550),e=1-Math.pow(1-k,3);setVw(v=>({...v,cx:a.cx+(tx-a.cx)*e,cy:a.cy+(c.y-a.cy)*e}));if(k<1)raf=requestAnimationFrame(f)};raf=requestAnimationFrame(f);return()=>cancelAnimationFrame(raf)},[sel,aside]);
  const glideOn=()=>{setGlide(true);clearTimeout(glideOn.t);glideOn.t=setTimeout(()=>setGlide(false),520)};
  const box=size&&vw&&{x0:vw.cx-size.w*vw.mpp/2,y0:vw.cy-size.h*vw.mpp/2,w:size.w*vw.mpp,h:size.h*vw.mpp};
  useEffect(()=>{if(!box)return;const dpr=Math.min(2,devicePixelRatio||1),pw=Math.round(size.w*dpr),ph=Math.round(size.h*dpr);
    paintOrtho(now.current,D,box,'after',pw,ph);paintOrtho(old.current,D,box,'before',pw,ph)},[vw,size]);
  useEffect(()=>{const h=e=>{e.preventDefault();if(!vw)return;const b=el.current.getBoundingClientRect(),px=e.clientX-b.left,py=e.clientY-b.top,f=Math.exp(e.deltaY*.0015);
      setVw(v=>{const m=Math.min(20,Math.max(.12,v.mpp*f)),k=m/v.mpp;return {mpp:m,cx:v.cx+(px-size.w/2)*v.mpp*(1-k),cy:v.cy-(py-size.h/2)*v.mpp*(1-k)}})};
    const n=el.current;n.addEventListener('wheel',h,{passive:false});return()=>n.removeEventListener('wheel',h)},[vw&&1,size]);
  if(!box)return html`<div class="lensmap" ref=${el}><canvas ref=${now}/><canvas ref=${old}/></div>`;
  const S=(x,y)=>[(x-box.x0)/vw.mpp,(box.y0+box.h-y)/vw.mpp],toM=e=>{const b=el.current.getBoundingClientRect();return [box.x0+(e.clientX-b.left)*vw.mpp,box.y0+box.h-(e.clientY-b.top)*vw.mpp]};
  const at=ptr||(c0?[c0.x,c0.y]:[tile.x0+tile.size/2,tile.y0+tile.size/2]),[lx,ly]=S(at[0],at[1]),lr=rad/vw.mpp;
  return html`<div class=${'lensmap'+(drag.current&&drag.current.moved>3?' drag':'')+(glide?' glide':'')} ref=${el} style=${{'--x':lx+'px','--y':ly+'px','--r':lr+'px'}}
      onPointerDown=${e=>{el.current.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,moved:0}}}
      onPointerMove=${e=>{const d=drag.current;if(d){const dx=e.clientX-d.x,dy=e.clientY-d.y;d.moved+=Math.abs(dx)+Math.abs(dy);d.x=e.clientX;d.y=e.clientY;setVw(v=>({...v,cx:v.cx-dx*v.mpp,cy:v.cy+dy*v.mpp}))}setPtr(toM(e))}}
      onPointerUp=${()=>{drag.current=null}}
      onPointerLeave=${()=>{setPtr(null);glideOn()}}>
    <canvas ref=${now} class="now" aria-hidden="true"/><canvas ref=${old} class="old" aria-hidden="true"/>
    <svg aria-hidden="true">
      ${c0&&(()=>{const [X,Y]=S(c0.x,c0.y);return html`${c0.r>0&&html`<circle class="unc" cx=${X} cy=${Y} r=${c0.r/vw.mpp}/>`}<circle class="cs" cx=${X} cy=${Y} r="4.5"/>`})()}
      <circle class="lring" cx=${lx} cy=${ly} r=${lr}/></svg>
    <span class="ltag" style=${{left:lx,top:ly-lr}}>1956–57</span>
    ${c0&&(()=>{const [X,Y]=S(c0.x,c0.y);return html`<span class="cname" style=${{left:X+10,top:Y}}>${c0.title}</span>`})()}
    <div class="bar"><span class="chip">Hoy · PNOA</span>
      <label class="chip">Lens ${rad>=1000?(rad/1000).toFixed(1)+' km':rad+' m'}<input type="range" min="40" max="1200" step="10" value=${rad} onInput=${e=>setRad(+e.target.value)} onPointerDown=${e=>e.stopPropagation()}/></label>
      <span class="chip src">Vuelo Americano Serie B 1956–57 and PNOA · © IGN, CC BY 4.0</span></div></div>`}

// one item on the stage, floating over the map: a photo, its versions (side by side, a divider between each), a text, a sound or a file
const photoCap=p=>html`<span>${p.v&&html`<b>${p.v}</b> `}${p.label}${p.credit&&html` <i>· ${p.credit}</i>`}${p.link&&html` <a href=${p.link} target="_blank" rel="noopener">original ↗</a>`}</span>`;
function Versions({c,P,eq}){
  const n=P.length,[ws,setWs]=useState(()=>P.slice(1).map((_,i)=>100*(i+1)/n)),fr=useRef(),grab=useRef(0);
  useEffect(()=>setWs(P.slice(1).map((_,i)=>100*(i+1)/n)),[P]);
  const pos=e=>{const b=fr.current.getBoundingClientRect();return (e.clientX-b.left)/b.width*100};
  const move=(i,x)=>setWs(w=>{const o=[...w];o[i]=Math.max(i?o[i-1]+2:0,Math.min(i<o.length-1?o[i+1]-2:100,x));return o});
  const bands=[0,...ws,100];
  return html`<div class="pic pair" ref=${fr} style=${{touchAction:'none'}}
      onPointerDown=${e=>{if(e.target.closest('a'))return;e.currentTarget.setPointerCapture(e.pointerId);const x=pos(e);grab.current=ws.reduce((b,w,i)=>Math.abs(w-x)<Math.abs(ws[b]-x)?i:b,0);move(grab.current,x)}}
      onPointerMove=${e=>{if(e.buttons)move(grab.current,pos(e))}}>
    <${Pic} src=${P[n-1].src} eq=${eq} alt=${c.title+', '+P[n-1].label}/>
    ${P.slice(0,-1).map((p,i)=>html`<${Pic} key=${p.src} cls="bf" src=${p.src} eq=${eq} alt=${c.title+', '+p.label} style=${{'--w':ws[i]+'%'}}/>`).reverse()}
    ${ws.map((w,i)=>html`<i key=${'s'+i} class="seam" style=${{left:w+'%'}}></i><span key=${'k'+i} class="knob" style=${{left:w+'%'}} role="slider" tabIndex="0"
      aria-label=${'Divider between versions '+P[i].v+' and '+P[i+1].v} aria-valuenow=${Math.round(w)} aria-valuemin="0" aria-valuemax="100"
      onKeyDown=${e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.stopPropagation();e.preventDefault();move(i,w+(e.key==='ArrowLeft'?-5:5))}}}>↔</span>`)}
    ${P.map((p,i)=>bands[i+1]-bands[i]>8&&html`<span key=${'t'+i} class="tag vt" style=${{left:(bands[i]+bands[i+1])/2+'%'}}>${p.v}${p.credit?' · '+p.credit.split(' · ')[0]:''}</span>`)}</div>`}
function Viewer({c,it,eq,onClose}){
  const head=html`<figcaption>${catNo(c)} · ${c.title}<button class="x" aria-label="Close file" onClick=${onClose}>×</button></figcaption>`;
  let body;
  if(it.type==='versions')body=html`${head}<${Versions} c=${c} P=${it.photos} eq=${eq}/><div class="cap">${it.photos.map(p=>html`<p key=${p.src}>${photoCap(p)}</p>`)}</div>`;
  else if(it.type==='photo')body=html`${head}<div class="pic"><${Pic} src=${it.src} eq=${eq} alt=${c.title+(it.label?', '+it.label:'')}/></div><div class="cap"><p>${photoCap(it)}</p></div>`;
  else if(it.type==='text')body=html`${head}<blockquote class="text"><small>${it.label||'Text'}</small>${it.body}</blockquote>`;
  else if(it.type==='audio')body=html`${head}<div class="aud"><${Sound} src=${it.src} label=${it.label} variant="big"/><p>${it.label}</p></div>`;
  else body=html`${head}<div class="doc">${['txt','pdf','html','md'].includes(ext(it.src))&&html`<iframe src=${it.src} title=${it.label||'Document'}></iframe>`}
    <a href=${it.src} target="_blank" rel="noopener">Open ${it.label||it.src.split('/').pop()} ↗</a></div>`;
  return html`<div class="viewer"><figure class="float" key=${firstSrc(it)||it.src||it.body}>${body}</figure></div>`}

function Explore({D,cases,open,eq,onClose,onAdd,onRemove}){
  const {tile}=open,[sel,setSel]=useState({id:open.id,item:open.item}),[shown,setShown]=useState(false),[closing,setClosing]=useState(false),root=useRef();
  useLayoutEffect(()=>{requestAnimationFrame(()=>requestAnimationFrame(()=>setShown(true)))},[]);
  const close=()=>{if(closing)return;setClosing(true);setShown(false);setTimeout(onClose,REDUCED?0:560)};
  const cs=tile.ids.map(id=>cases[id]).filter(Boolean),flat=[];for(const c of cs)c.items.forEach((_,i)=>flat.push([c.id,i]));
  const c=sel.id&&cases[sel.id],it=c&&sel.item!=null?c.items[sel.item]:null;
  useEffect(()=>{const h=e=>{if(e.key==='Escape'){if(it)setSel(s=>({...s,item:null}));else close()}
      if((e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='ArrowRight'||e.key==='ArrowLeft')&&!e.target.closest('input,[role=slider]')&&flat.length){e.preventDefault();
        const k=flat.findIndex(([id,i])=>id===sel.id&&i===sel.item),d=e.key==='ArrowDown'||e.key==='ArrowRight'?1:-1,n=flat[k<0?(d>0?0:flat.length-1):(k+d+flat.length)%flat.length];setSel({id:n[0],item:n[1]})}};
    addEventListener('keydown',h);return()=>removeEventListener('keydown',h)});
  useEffect(()=>{const r=root.current&&root.current.querySelector('.row.sel');r&&r.scrollIntoView({block:'nearest'})},[sel]);
  const b=document.querySelector('.app').getBoundingClientRect(),f=open.from;
  const thumb=it=>firstSrc(it)?html`<span class="th"><${Pic} src=${firstSrc(it)} eq=${eq}/></span>`:html`<span class="th">${{text:'¶',audio:'♪',file:'▤'}[it.type]}</span>`;
  const nf=cs.reduce((a,c)=>a+c.items.length,0);
  return html`<div ref=${root} class=${'explore'+(shown?' open':'')} role="dialog" aria-modal="true" aria-label=${squareName(D,tile)+', square '+kmCell(D,tile.x0+tile.size/2,tile.y0+tile.size/2)}
      style=${{'--from':`inset(${f.top}px ${b.width-f.left-f.width}px ${b.height-f.top-f.height}px ${f.left}px)`}}>
    <div class="stage">
      <${LensMap} D=${D} cases=${cases} tile=${tile} sel=${sel.id} aside=${!!it}/>
      ${it&&html`<${Viewer} c=${c} it=${it} eq=${eq} onClose=${()=>setSel(s=>({...s,item:null}))}/>`}
    </div>
    <aside class="files">
      <header><div><small>${squareName(D,tile)} · square ${kmCell(D,tile.x0+tile.size/2,tile.y0+tile.size/2)} · ${fmtStep(tile.size)}</small><h2>${cs.length} ${cs.length>1?'cases':'case'} · ${nf} ${nf>1?'files':'file'}</h2></div>
        <button class="close" aria-label="Close" onClick=${close}>×</button></header>
      <button class=${'row'+(!it?' sel':'')} onClick=${()=>setSel(s=>({...s,item:null}))}><span class="th">◐</span><span>Orthophoto<br/><em>hoy, 1956 in the lens</em></span></button>
      ${cs.map(c=>html`<section key=${c.id} class=${c.id===sel.id?'cur':''}>
        <button class="ch" onClick=${()=>setSel({id:c.id,item:null})}><span class="no">${catNo(c)}</span><b>${c.title}</b><small>${[c.sample&&'sample',c.date,where(c)].filter(Boolean).join(' · ')}</small></button>
        ${mapLink(c)&&html`<a class="gm" href=${mapLink(c)} target="_blank" rel="noopener">See the location in Google Maps ↗</a>`}
        ${c.items.map((x,i)=>html`<button key=${i} class=${'row'+(c.id===sel.id&&i===sel.item?' sel':'')} onClick=${()=>setSel({id:c.id,item:i})}>${thumb(x)}<span>${itemName(x)}<br/><em>${x.type==='versions'?x.photos.length+' versions':x.type}</em></span></button>`)}
        ${c.own&&html`<div class="own"><button onClick=${()=>onAdd(c.id)}>Add photo</button><button onClick=${()=>{onRemove(c.id);if(cs.length<2)close()}}>Remove case</button></div>`}
      </section>`)}
      <p class="src">Drag to move, scroll to zoom, ↑ ↓ to step through the files, Esc to go back.</p>
    </aside></div>`}

function App(){
  const [D,setD]=useState(null),[err,setErr]=useState(null),[layers,setLayers]=useState(()=>({buildings:true,trees:false,water:true,green:true,cases:true,ortho:false,bw:localStorage.getItem('lnu-bw')==='1'}));
  const [cases,setCases]=useState({}),[placing,setPlacing]=useState(false),[open,setOpen]=useState(null),[legendOpen,setLegendOpen]=useState(false);
  const file=useRef(),target=useRef(null),[,setAsp]=useState(0);
  useEffect(()=>preloadAspects(cases,()=>setAsp(x=>x+1)),[cases]); // photo shapes decide card shapes
  useEffect(()=>{Promise.all([loadData(),fetch('data/cases.json').then(r=>r.ok?r.json():{cases:[]}).catch(()=>({cases:[]})),dbAll()]).then(([d,cj,mine])=>{
    const all={};let n=0;for(const c of cj.cases){const [x,y]=toLocal(d,c.lon,c.lat);n=Math.max(n,c.n||0);all[c.id]={...c,x,y,r:c.r||0}}
    for(const c of Object.values(all))if(!c.n)c.n=++n;
    for(const v of Object.values(mine)){const c=fromLegacy(v);all[c.id]={...c,r:c.r||0,n:c.n||++n,own:true}}
    setCases(all);setD(d)}).catch(e=>setErr(String(e)))},[]);
  const save=c=>{setCases(o=>({...o,[c.id]:c}));dbPut(c.id,c)};
  // where = {x,y} for a new case, or {id} to add a photo to one of your own
  const place=async(where,f)=>{if(!f){target.current=where;file.current.click();return}
    try{const src=await shrink(f),name=f.name.replace(/\.[^.]+$/,'');
      if(where.id){const c=cases[where.id];save({...c,items:[...c.items,{type:'photo',src,label:name}]})}
      else{const id='p'+Date.now(),n=Math.max(0,...Object.values(cases).map(c=>c.n))+1;save({id,n,title:name,x:where.x,y:where.y,r:0,own:true,date:'',items:[{type:'photo',src,label:name}]});setPlacing(false)}}catch(e){}};
  const remove=id=>{setCases(o=>{const n={...o};delete n[id];return n});dbPut(id,null)};
  if(err)return html`<div class="load">Could not load the map data: ${err}</div>`;
  if(!D)return html`<div class="load">Loading Catastro buildings, the 2026 tree inventory and the archive…</div>`;
  const tog=k=>setLayers(l=>{const n={...l,[k]:!l[k]};if(k==='bw')localStorage.setItem('lnu-bw',n.bw?'1':'0');return n});
  const LAYERS=[['trees','Trees','radial-gradient(circle,var(--tree) 1.7px,transparent 2.2px) 0 0/6px 6px'],['buildings','Buildings','var(--b2)'],['water','Water','var(--water)'],['green','Parks','var(--green)'],['cases','Archive squares','transparent']];
  const legend=st=>html`<div class="legend" onPointerDown=${e=>e.stopPropagation()} onPointerUp=${e=>e.stopPropagation()}>
    <div class="head"><button class="toggle" aria-expanded=${legendOpen} onClick=${()=>setLegendOpen(o=>!o)}>Layers<span>Grid ${fmtStep(st||KM)} ${legendOpen?'▾':'▸'}</span></button>
      <button class="bwt" aria-pressed=${layers.bw} title="Everything in black and white, tone-matched: the map, today's orthophoto (to 1956) and the photos" onClick=${()=>tog('bw')}>◐ B/W</button></div>
    ${legendOpen&&html`<div class="body">
      ${LAYERS.map(([k,l,sw])=>html`<label key=${k}><input type="checkbox" checked=${layers[k]} onChange=${()=>tog(k)}/>${l}<i class="sw" style=${{background:sw,border:k==='cases'?'1.25px solid var(--ink)':0}}></i></label>`)}
      <label><input type="checkbox" checked=${layers.ortho} onChange=${()=>tog('ortho')}/>Orthophotos in every square<i class="sw" style=${{background:'linear-gradient(90deg,#7f9a6e 50%,#9a9a96 50%)'}}></i></label>
      <hr/>
      <button class="add" aria-pressed=${placing} onClick=${()=>setPlacing(p=>!p)}>${placing?'Cancel':'Add a case'}</button>
      ${placing&&html`<p>Click where the photo was taken, or drop an image there.</p>`}
      <p>${D.n.toLocaleString('es-ES')} trees: Ayuntamiento de Madrid, 2026. Buildings: Catastro, 2026. Water and place names: © OpenStreetMap. Orthophotos: © IGN (Vuelo Americano 1956–57, PNOA). Cases you add stay in this browser.</p>
    </div>`}</div>`;
  return html`<div class=${"app"+(layers.bw?" bw":"")}>
    <${MapView} D=${D} layers=${layers} cases=${cases} placing=${placing} onPlace=${place} onOpen=${setOpen} paused=${!!open}>${legend}<//>
    ${open&&html`<${Explore} key=${open.tile.x0+','+open.tile.y0} D=${D} cases=${cases} open=${open} eq=${layers.bw} onClose=${()=>setOpen(null)}
      onAdd=${id=>place({id},null)} onRemove=${remove}/>`}
    <input type="file" accept="image/*" ref=${file} onChange=${e=>{const f=e.target.files[0],t=target.current;if(f&&t)place(t,f);e.target.value=''}}/>
  </div>`;
}
ReactDOM.createRoot(document.getElementById('root')).render(html`<${App}/>`);
