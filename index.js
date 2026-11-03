// Duang 果冻（duangduang）—— 悬浮球 + 选图 + 放大弹窗 + 果冻互动。
// 点悬浮球进入选图模式，点任意一张图（普通图 / canvas / 背景图 / 同源 iframe 里的图），会把它复制一份到自己的弹窗里玩，不改动原图，也不会被别的插件重绘冲掉。
import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';

const EXT='duangduang';
const defaults={ballOn:true,ballX:1,ballY:.62,jellyOn:true,jellyScope:'local',jellyTap:true,jellyDrag:true,jellyShake:false,jellyStrength:'mid',jellyBrush:.075};
function ddCfg(){
 if(!extension_settings[EXT])extension_settings[EXT]={};
 const c=extension_settings[EXT];
 for(const k of Object.keys(defaults))if(c[k]===undefined)c[k]=defaults[k];
 return c;
}
const ddSave=()=>{try{saveSettingsDebounced();}catch{}};

// ===== 放大图小互动（果冻）：范围（局部 / 抹开 / 全屏）× 选区（可选）× 交互（点击 / 拖动 / 摇晃） =====
// 弹簧动画只在触摸 / 拖动 / 摇晃时跑，松手停稳后自动结束；选区只在放大图打开期间保留。
const DD_JELLY_MW=48,DD_JELLY_MH=48;
function ddJellyCfg(){
 const c=ddCfg();
 if(typeof c.jellyOn!=='boolean'){
  const m=c.jellyMode;
  c.jellyOn=['squish','pull','both','wobble'].includes(m);
  c.jellyTap=m!=='pull';c.jellyDrag=m!=='squish';
 }
 if(typeof c.jellyTap!=='boolean')c.jellyTap=true;
 if(typeof c.jellyDrag!=='boolean')c.jellyDrag=true;
 if(typeof c.jellyShake!=='boolean')c.jellyShake=false;
 return {on:c.jellyOn,scope:['smudge','whole'].includes(c.jellyScope)?c.jellyScope:'local',tap:c.jellyTap,drag:c.jellyDrag,shake:c.jellyShake,amp:{soft:.6,mid:1,bouncy:1.5}[c.jellyStrength]||1};
}
function ddJellyBrush(){const b=Number(ddCfg().jellyBrush);return Number.isFinite(b)&&b>0?Math.max(.02,Math.min(.2,b)):.075;}
function ddJellyState(img){
 if(!img._ddJ)img._ddJ={mask:new Float32Array(DD_JELLY_MW*DD_JELLY_MH),has:false,selecting:false};
 return img._ddJ;
}
function ddJellyClearSelection(img){
 if(!img)return;const S=ddJellyState(img);S.mask.fill(0);S.has=false;S.selecting=false;
}
async function ddJellyEnableMotion(setMsg){
 const say=t=>{try{setMsg&&setMsg(t);}catch{}};
 if(typeof DeviceMotionEvent==='undefined'){say('此浏览器不支持摇晃感应');return false;}
 if(typeof DeviceMotionEvent.requestPermission==='function'){
  try{const r=await DeviceMotionEvent.requestPermission();if(r!=='granted'){say('没有拿到动作传感器权限');return false;}}
  catch{say('请求动作传感器权限失败');return false;}
 }
 let got=false;const h=()=>{got=true;};window.addEventListener('devicemotion',h);
 setTimeout(()=>{window.removeEventListener('devicemotion',h);say(got?'摇晃已就绪：晃一晃手机试试':'没收到传感器数据：请确认是用 http://127.0.0.1 或 https 打开的酒馆，并且系统没有关闭动作传感器');},1500);
 return true;
}
function ddAttachJelly(img){
 if(!img)return;
 const S=ddJellyState(img),conf=ddJellyCfg(),amp=conf.amp,scope=conf.scope;
 img._ddJellyAbort?.abort();img._ddJellyAbort=null;
 img.style.transform='';img.style.touchAction='';img.style.willChange='';
 if(!conf.on){S.selecting=false;return;}
 if(scope==='whole'&&!S.has&&!conf.shake&&!S.selecting)return ddAttachJellyWhole(img,conf);
 let probeOk=false;
 try{const pc=document.createElement('canvas');probeOk=!!(pc.getContext('webgl')||pc.getContext('experimental-webgl'));}catch{}
 if(!probeOk)return ddAttachJellyWhole(img,conf);
 const ac=new AbortController();img._ddJellyAbort=ac;const sig={signal:ac.signal};
 const wantPointer=conf.tap||conf.drag||S.selecting;
 if(wantPointer){img.draggable=false;img.style.touchAction='none';img.style.webkitUserDrag='none';}
 const MW=DD_JELLY_MW,MH=DD_JELLY_MH;
 let canvas=null,selCv=null,gl=null,prog=null,posBuf=null,idxCount=0,tex=null,texSrc='',cols=0,rows=0,pos=null,locPos=0,boxW=0,boxH=0,failed=false;
 let raf=0,press=null,cx=0,cy=0,lx=0,ly=0,ofx=null,ofy=null,ovx=null,ovy=null,mv=null,shw=null,shown=false;
 const dep={x:0,v:0,t:0,k:.3,d:.6},ox={x:0,v:0,t:0,k:.3,d:.7},oy={x:0,v:0,t:0,k:.3,d:.7};
 const aff={x:[0,0,1,1,0],v:[0,0,0,0,0],t:[0,0,1,1,0]};
 const shk={x:0,y:0,vx:0,vy:0};
 const destroy=()=>{cancelAnimationFrame(raf);raf=0;try{canvas?.remove();}catch{}try{selCv?.remove();}catch{}canvas=null;selCv=null;gl=null;};
 ac.signal.addEventListener('abort',destroy);
 const box=()=>{
  const r=img.getBoundingClientRect(),cs=getComputedStyle(img);
  const f=n=>parseFloat(cs[n])||0;
  const l=f('paddingLeft')+f('borderLeftWidth'),t=f('paddingTop')+f('borderTopWidth'),rr=f('paddingRight')+f('borderRightWidth'),b=f('paddingBottom')+f('borderBottomWidth');
  return {left:l,top:t,w:Math.max(10,r.width-l-rr),h:Math.max(10,r.height-t-b)};
 };
 const compile=(type,src)=>{const sh=gl.createShader(type);gl.shaderSource(sh,src);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw new Error('shader');return sh;};
 // 选区采样（双线性），返回 0~1
 const maskAt=(u,v)=>{
  const gx=Math.max(0,Math.min(MW-1,u*(MW-1))),gy=Math.max(0,Math.min(MH-1,v*(MH-1)));
  const x0=Math.floor(gx),y0=Math.floor(gy),x1=Math.min(MW-1,x0+1),y1=Math.min(MH-1,y0+1),fx=gx-x0,fy=gy-y0,m=S.mask;
  return (m[y0*MW+x0]*(1-fx)+m[y0*MW+x1]*fx)*(1-fy)+(m[y1*MW+x0]*(1-fx)+m[y1*MW+x1]*fx)*fy;
 };
 const rebuildWeights=()=>{
  if(!mv)return;
  for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
   const k=j*(cols+1)+i,u=i/cols,v=j/rows;
   mv[k]=S.has?maskAt(u,v):1;
   shw[k]=S.has?mv[k]:Math.pow(Math.sin(Math.PI*u),.6)*Math.pow(Math.sin(Math.PI*v),.6);
  }
 };
 // 选区显示层：低分辨率画布放大，边缘自带柔化
 let accent=null;
 const accentRgb=()=>{
  if(accent)return accent;
  let col='';try{col=getComputedStyle(document.documentElement).getPropertyValue('--dd-accent').trim();}catch{}
  try{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle='#e58aa8';if(col)x.fillStyle=col;x.fillRect(0,0,1,1);const d=x.getImageData(0,0,1,1).data;accent=[d[0],d[1],d[2]];}catch{accent=[229,138,168];}
  return accent;
 };
 const paintSel=()=>{
  if(!selCv)return;
  const x=selCv.getContext('2d'),id=x.createImageData(MW,MH),[r,g,b]=accentRgb();
  for(let k=0;k<MW*MH;k++){id.data[k*4]=r;id.data[k*4+1]=g;id.data[k*4+2]=b;id.data[k*4+3]=Math.round(Math.min(1,S.mask[k])*140);}
  x.putImageData(id,0,0);
 };
 const placeOverlays=bx=>{
  const l=(img.offsetLeft+bx.left)+'px',t=(img.offsetTop+bx.top)+'px',w=bx.w+'px',h=bx.h+'px';
  for(const c of [canvas,selCv]){if(!c)continue;c.style.left=l;c.style.top=t;c.style.width=w;c.style.height=h;}
 };
 const ensure=()=>{
  if(failed)return false;
  try{
   const bx=box();
   if(!canvas){
    const host=img.offsetParent||img.parentElement;if(!host)throw new Error('no host');
    canvas=document.createElement('canvas');canvas.className='dd-jelly-canvas';canvas.style.cssText='position:absolute;pointer-events:none;display:none;z-index:2;';
    host.appendChild(canvas);
    selCv=document.createElement('canvas');selCv.className='dd-jelly-sel';selCv.width=MW;selCv.height=MH;selCv.style.cssText='position:absolute;pointer-events:none;z-index:3;display:none;';
    host.appendChild(selCv);
    gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:true})||canvas.getContext('experimental-webgl');
    if(!gl)throw new Error('no gl');
    prog=gl.createProgram();
    gl.attachShader(prog,compile(gl.VERTEX_SHADER,'attribute vec2 aPos;attribute vec2 aUv;uniform vec2 uSize;varying vec2 vUv;void main(){vUv=aUv;gl_Position=vec4(aPos.x/uSize.x*2.0-1.0,1.0-aPos.y/uSize.y*2.0,0.0,1.0);}'));
    gl.attachShader(prog,compile(gl.FRAGMENT_SHADER,'precision mediump float;uniform sampler2D uTex;varying vec2 vUv;void main(){gl_FragColor=texture2D(uTex,vUv);}'));
    gl.linkProgram(prog);if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw new Error('link');
    gl.useProgram(prog);
    tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    posBuf=gl.createBuffer();
    locPos=gl.getAttribLocation(prog,'aPos');
   }
   const dpr=Math.min(2,window.devicePixelRatio||1);
   if(Math.abs(bx.w-boxW)>.5||Math.abs(bx.h-boxH)>.5||!pos){
    boxW=bx.w;boxH=bx.h;canvas.width=Math.round(bx.w*dpr);canvas.height=Math.round(bx.h*dpr);
    cols=32;rows=Math.max(16,Math.min(56,Math.round(cols*bx.h/bx.w)));
    const n=(cols+1)*(rows+1);pos=new Float32Array(n*2);const uvs=new Float32Array(n*2);
    ofx=new Float32Array(n);ofy=new Float32Array(n);ovx=new Float32Array(n);ovy=new Float32Array(n);mv=new Float32Array(n);shw=new Float32Array(n);
    const idx=[];
    for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){const k=j*(cols+1)+i;uvs[k*2]=i/cols;uvs[k*2+1]=j/rows;}
    for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){const a=j*(cols+1)+i,b=a+1,c=a+cols+1,d=c+1;idx.push(a,b,c,b,d,c);}
    idxCount=idx.length;
    const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(idx),gl.STATIC_DRAW);
    const ub=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,ub);gl.bufferData(gl.ARRAY_BUFFER,uvs,gl.STATIC_DRAW);
    const locUv=gl.getAttribLocation(prog,'aUv');gl.enableVertexAttribArray(locUv);gl.vertexAttribPointer(locUv,2,gl.FLOAT,false,0,0);
    gl.viewport(0,0,canvas.width,canvas.height);
    rebuildWeights();paintSel();
   }
   placeOverlays(bx);
   if(texSrc!==(img.currentSrc||img.src)){
    gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img);
    texSrc=img.currentSrc||img.src;
   }
   return true;
  }catch(e){failed=true;destroy();console.warn('[拾帧] 局部果冻不可用，改用整图弹动',e);return false;}
 };
 const draw=()=>{
  const m=Math.min(boxW,boxH),R=.17*m,R2=.22*m,RR=R*R,RR2=R2*R2,shAmp=.05*m*amp;
  const useLocal=scope!=='whole',useAff=scope==='whole';
  const [tx,ty,sx,sy,rot]=aff.x,cr=Math.cos(rot*Math.PI/180),sr=Math.sin(rot*Math.PI/180),mx0=boxW/2,my0=boxH/2;
  const shOn=Math.abs(shk.x)>.0005||Math.abs(shk.y)>.0005;
  for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
   const k=j*(cols+1)+i,px=i/cols*boxW,py=j/rows*boxH,m1=mv[k];
   let x=px,y=py;
   if(useLocal){
    const dx=px-cx,dy=py-cy,d2=dx*dx+dy*dy;
    const w=Math.exp(-d2/RR)*m1,w2=Math.exp(-d2/RR2)*m1;
    const f=1-dep.x*w;
    x=cx+dx*f+ox.x*w2+ofx[k];y=cy+dy*f+oy.x*w2+ofy[k];
   }
   if(useAff){
    const dxc=px-mx0,dyc=py-my0;
    const X=mx0+tx+(dxc*cr-dyc*sr)*sx,Y=my0+ty+(dxc*sr+dyc*cr)*sy;
    x=px+(X-px)*m1;y=py+(Y-py)*m1;
   }
   if(shOn){const w=shw[k];x+=shk.x*shAmp*w*(1+.6*(py/boxH-.5));y+=shk.y*shAmp*w*(1+.4*(px/boxW-.5));}
   pos[k*2]=Math.max(0,Math.min(boxW,x));pos[k*2+1]=Math.max(0,Math.min(boxH,y));
  }
  gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindBuffer(gl.ARRAY_BUFFER,posBuf);gl.bufferData(gl.ARRAY_BUFFER,pos,gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(locPos);gl.vertexAttribPointer(locPos,2,gl.FLOAT,false,0,0);
  gl.uniform2f(gl.getUniformLocation(prog,'uSize'),boxW,boxH);
  gl.drawElements(gl.TRIANGLES,idxCount,gl.UNSIGNED_SHORT,0);
 };
 const step=s=>{s.v+=(s.t-s.x)*s.k;s.v*=s.d;s.x+=s.v;return Math.abs(s.v)>.002||Math.abs(s.t-s.x)>.002;};
 const resetAll=()=>{
  dep.x=dep.v=ox.x=ox.v=oy.x=oy.v=0;aff.x=[0,0,1,1,0];aff.v=[0,0,0,0,0];aff.t=[0,0,1,1,0];shk.x=shk.y=shk.vx=shk.vy=0;
  if(ofx){ofx.fill(0);ofy.fill(0);ovx.fill(0);ovy.fill(0);}
 };
 const K=.16,D=.80;
 const tick=()=>{
  if(!canvas||!gl){raf=0;return;}
  let live=false;
  live=step(dep)||live;live=step(ox)||live;live=step(oy)||live;
  for(let i=0;i<5;i++){
   if(press&&!press.paint&&i<4&&scope==='whole'){aff.x[i]=aff.t[i];aff.v[i]=0;}
   else{aff.v[i]+=(aff.t[i]-aff.x[i])*K;aff.v[i]*=D;aff.x[i]+=aff.v[i];}
   if(Math.abs(aff.v[i])>.002||Math.abs(aff.t[i]-aff.x[i])>.002)live=true;
  }
  shk.vx+=-shk.x*.1;shk.vx*=.9;shk.x+=shk.vx;shk.vy+=-shk.y*.1;shk.vy*=.9;shk.y+=shk.vy;
  if(Math.abs(shk.x)>.002||Math.abs(shk.vx)>.002||Math.abs(shk.y)>.002||Math.abs(shk.vy)>.002)live=true;
  if(ofx){for(let k=0;k<ofx.length;k++){if(!press||!press.smudging){ovx[k]+=(0-ofx[k])*.12;ovy[k]+=(0-ofy[k])*.12;ovx[k]*=.8;ovy[k]*=.8;ofx[k]+=ovx[k];ofy[k]+=ovy[k];}if(Math.abs(ofx[k])>.02||Math.abs(ofy[k])>.02||Math.abs(ovx[k])>.01||Math.abs(ovy[k])>.01)live=true;}}
  draw();
  if(live||(press&&!press.paint))raf=requestAnimationFrame(tick);
  else{raf=0;canvas.style.display='none';shown=false;resetAll();}
 };
 const show=()=>{if(canvas&&!shown){canvas.style.display='block';shown=true;}};
 const kick=()=>{if(!raf)raf=requestAnimationFrame(tick);};
 const local=e=>{const r=img.getBoundingClientRect(),bx=box();return [Math.max(0,Math.min(boxW,e.clientX-r.left-bx.left)),Math.max(0,Math.min(boxH,e.clientY-r.top-bx.top))];};
 // 涂选区：自由手绘，高斯笔刷取最大值，边缘柔和
 const paintAt=(x,y)=>{
  const erase=S.tool==='erase',u=x/boxW,v=y/boxH,rad=ddJellyBrush()*Math.min(boxW,boxH),rr=rad*rad*1.3;
  for(let j=0;j<MH;j++){const dy=(j/(MH-1)-v)*boxH;if(Math.abs(dy)>rad*2.2)continue;
   for(let i=0;i<MW;i++){const dx=(i/(MW-1)-u)*boxW;if(Math.abs(dx)>rad*2.2)continue;
    const w=Math.exp(-(dx*dx+dy*dy)/rr);{const q=j*MW+i;if(erase)S.mask[q]=Math.max(0,S.mask[q]-w*1.3);else if(w>S.mask[q])S.mask[q]=Math.min(1,w*1.15);}}}
  if(erase){let any=false;for(let q=0;q<S.mask.length;q++){if(S.mask[q]<.04)S.mask[q]=0;else any=true;}S.has=any;}else S.has=true;
  paintSel();rebuildWeights();
 };
 img.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse'&&e.button!==0)return;
  if(!S.selecting&&!conf.tap&&!conf.drag)return;
  if(!ensure()){if(failed)ddAttachJellyWhole(img,conf);return;}
  const [px,py]=local(e);
  try{img.setPointerCapture(e.pointerId);}catch{}
  e.preventDefault();
  if(S.selecting){
   press={id:e.pointerId,paint:true};selCv.style.display='block';paintAt(px,py);return;
  }
  cx=px;cy=py;lx=px;ly=py;
  press={id:e.pointerId,x:e.clientX,y:e.clientY,t:Date.now(),moved:false,smudging:false};
  show();
  Object.assign(dep,{k:.3,d:.6});Object.assign(ox,{k:.3,d:.7});Object.assign(oy,{k:.3,d:.7});
  ox.t=ox.x=0;oy.t=oy.x=0;ox.v=oy.v=0;
  if(scope!=='whole'&&conf.tap)dep.t=Math.min(.5,.3*amp);
  kick();
 },sig);
 img.addEventListener('pointermove',e=>{
  if(!press||e.pointerId!==press.id||!canvas)return;
  if(press.paint){const [px,py]=local(e);paintAt(px,py);return;}
  const dx=e.clientX-press.x,dy=e.clientY-press.y;
  if(!press.moved&&Math.hypot(dx,dy)<6)return;
  press.moved=true;press.dx=dx;
  if(!conf.drag)return;
  if(scope==='whole'){
   const damp=v=>Math.sign(v)*Math.pow(Math.abs(v),.82)*.55;
   const w=boxW,h=boxH,ax=Math.abs(dx)/w,ay=Math.abs(dy)/h;
   const stX=Math.min(.38,ax*.9*amp),stY=Math.min(.38,ay*.9*amp);
   aff.t[0]=damp(dx);aff.t[1]=damp(dy);aff.t[2]=(1+stX)*(1-stY*.45);aff.t[3]=(1+stY)*(1-stX*.45);aff.t[4]=Math.max(-6,Math.min(6,dx/w*5*amp));
   kick();return;
  }
  dep.t=0;
  if(scope==='smudge'){
   // 抹开：手指划过的地方（笔刷半径内）的像素被带着走，松手后各点自己弹回原位。
   const [nx,ny]=local(e);
   const mx=nx-lx,my=ny-ly;lx=nx;ly=ny;cx=nx;cy=ny;press.smudging=true;
   const Rb=.12*Math.min(boxW,boxH),RRb=Rb*Rb,lim=.12*Math.min(boxW,boxH)*amp;
   for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
    const k=j*(cols+1)+i,ddx=i/cols*boxW-nx,ddy=j/rows*boxH-ny,w=Math.exp(-(ddx*ddx+ddy*ddy)/RRb)*mv[k];
    if(w<.02)continue;
    ofx[k]=Math.max(-lim,Math.min(lim,ofx[k]+mx*w*.9));ofy[k]=Math.max(-lim,Math.min(lim,ofy[k]+my*w*.9));ovx[k]=0;ovy[k]=0;
   }
   kick();return;
  }
  const damp=v=>Math.sign(v)*Math.pow(Math.abs(v),.8)*.7*amp;
  ox.t=damp(dx);oy.t=damp(dy);kick();
 },sig);
 const end=e=>{
  if(!press||(e&&e.pointerId!==press.id))return;
  const p=press;press=null;p.smudging=false;try{img.releasePointerCapture(p.id);}catch{}
  if(p.paint){return;}
  Object.assign(dep,{k:.15,d:.78});Object.assign(ox,{k:.13,d:.8});Object.assign(oy,{k:.13,d:.8});
  dep.t=0;ox.t=0;oy.t=0;
  if(scope==='whole'){
   const quick=Date.now()-p.t<450&&!p.moved;
   if(quick&&conf.tap){aff.x[2]=1+.11*amp;aff.x[3]=1-.14*amp;aff.v[2]=0;aff.v[3]=0;}
   else if(p.moved&&conf.drag){aff.v[2]-=(aff.x[2]-1)*.35;aff.v[3]-=(aff.x[3]-1)*.35;}
   aff.t=[0,0,1,1,0];
  }
  kick();
 };
 img.addEventListener('pointerup',end,sig);img.addEventListener('pointercancel',end,sig);
 img.addEventListener('contextmenu',e=>{if(press)e.preventDefault();},sig);
 if(S.selecting&&ensure()){selCv.style.display='block';paintSel();}
 // 摇晃手机：加速度推着选区（没选区时是整张图、边缘不动）晃，停了弹簧自己回来。
 if(conf.shake&&!S.selecting){
  let gx=0,gy=0,primed=false;
  window.addEventListener('devicemotion',e=>{
   if(press)return;
   let ax=0,ay=0;const a=e.acceleration;
   if(a&&(a.x!=null||a.y!=null)){ax=a.x||0;ay=a.y||0;}
   else{const g=e.accelerationIncludingGravity||{};const vx=g.x||0,vy=g.y||0;if(!primed){gx=vx;gy=vy;primed=true;}gx=gx*.9+vx*.1;gy=gy*.9+vy*.1;ax=vx-gx;ay=vy-gy;}
   if(Math.abs(ax)+Math.abs(ay)<1.2)return;
   if(!ensure())return;
   show();
   shk.vx+=Math.max(-1.2,Math.min(1.2,-ax*.025*amp));shk.vy+=Math.max(-1.2,Math.min(1.2,ay*.025*amp));
   shk.x=Math.max(-1.6,Math.min(1.6,shk.x));shk.y=Math.max(-1.6,Math.min(1.6,shk.y));
   kick();
  },sig);
 }
}
function ddAttachJellyWhole(img,conf){
 if(!img)return;
 conf=conf||ddJellyCfg();const amp=conf.amp;
 // 每次打开都按当前设置重新决定是否启用；上一次绑的监听用 AbortController 统一撤掉。
 img._ddJellyAbort?.abort();img._ddJellyAbort=null;
 img.style.transform='';img.style.touchAction='';img.style.transformOrigin='';
 if(!conf.on||(!conf.tap&&!conf.drag))return;
 const ac=new AbortController();img._ddJellyAbort=ac;const sig={signal:ac.signal};
 img.draggable=false;img.style.touchAction='none';img.style.willChange='transform';img.style.webkitUserDrag='none';
 // 状态：x=[tx,ty,sx,sy,rot]，v=速度，t=目标
 const st={x:[0,0,1,1,0],v:[0,0,0,0,0],t:[0,0,1,1,0]};
 let raf=0,drag=null;
 const K=.16,D=.80;
 const apply=()=>{img.style.transform='translate('+st.x[0].toFixed(2)+'px,'+st.x[1].toFixed(2)+'px) rotate('+st.x[4].toFixed(3)+'deg) scale('+st.x[2].toFixed(4)+','+st.x[3].toFixed(4)+')';};
 const tick=()=>{
  let moving=false;
  for(let i=0;i<5;i++){
   if(drag&&i<4){st.x[i]=st.t[i];st.v[i]=0;}
   else{st.v[i]+=(st.t[i]-st.x[i])*K;st.v[i]*=D;st.x[i]+=st.v[i];}
   if(Math.abs(st.v[i])>.0008||Math.abs(st.t[i]-st.x[i])>.0008)moving=true;
  }
  apply();
  if(moving||drag)raf=requestAnimationFrame(tick);
  else{raf=0;st.x=[0,0,1,1,0];st.v=[0,0,0,0,0];img.style.transform='';}
 };
 const kick=()=>{if(!raf)raf=requestAnimationFrame(tick);};
 const rest=()=>{st.t=[0,0,1,1,0];};
 const squish=()=>{st.x[2]=1+.11*amp;st.x[3]=1-.14*amp;st.v[2]=0;st.v[3]=0;rest();kick();};
 img.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse'&&e.button!==0)return;
  drag={id:e.pointerId,x:e.clientX,y:e.clientY,t:Date.now(),moved:false};
  try{img.setPointerCapture(e.pointerId);}catch{}
  e.preventDefault();
 },sig);
 img.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.id)return;
  const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
  if(!drag.moved&&Math.hypot(dx,dy)<6)return;
  drag.moved=true;
  if(!conf.drag)return;
  const w=img.clientWidth||300,h=img.clientHeight||300;
  // 沿拖动方向拉伸、垂直方向收窄，图片中心跟着手指走一小段（橡皮筋式阻尼）。
  const damp=v=>Math.sign(v)*Math.pow(Math.abs(v),.82)*.55;
  const ax=Math.abs(dx)/w,ay=Math.abs(dy)/h;
  const stretchX=Math.min(.38,ax*.9*amp),stretchY=Math.min(.38,ay*.9*amp);
  st.t[0]=damp(dx);st.t[1]=damp(dy);
  st.t[2]=(1+stretchX)*(1-stretchY*.45);st.t[3]=(1+stretchY)*(1-stretchX*.45);
  st.t[4]=Math.max(-6,Math.min(6,dx/w*5*amp));
  kick();
 },sig);
 const end=e=>{
  if(!drag||(e&&e.pointerId!==drag.id))return;
  const d=drag;drag=null;try{img.releasePointerCapture(d.id);}catch{}
  const quick=Date.now()-d.t<450&&!d.moved;
  if(quick&&conf.tap){squish();return;}
  if(d.moved&&conf.drag){
   // 松手：保留当前拉伸状态，并给一点反向速度，弹簧会带来 Q 弹的过冲。
   st.v[2]-=(st.x[2]-1)*.35;st.v[3]-=(st.x[3]-1)*.35;rest();kick();return;
  }
  rest();kick();
 };
 img.addEventListener('pointerup',end,sig);img.addEventListener('pointercancel',end,sig);
 img.addEventListener('contextmenu',e=>{if(drag)e.preventDefault();},sig);
}
function ddBuildBar(overlay){

   // 放大图下方的果冻面板：范围 / 选区 / 交互，不用回设置页。
   const bar=document.createElement('div');bar.className='dd-jelly-bar';bar.setAttribute('role','group');bar.setAttribute('aria-label','果冻互动');
   bar.innerHTML='<div class="dd-jb-head"><button type="button" data-jb="power"></button><button type="button" data-jb="more">设置 ▴</button><button type="button" data-jb-tool="add" aria-label="增加选区（画笔）" title="增加选区" hidden><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z"/><path d="M14 7l3 3"/></svg></button><button type="button" data-jb-tool="erase" aria-label="擦除选区（橡皮）" title="擦除选区" hidden><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 20h12"/><path d="M5 15l8-8a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3l-6 6H9z"/><path d="M9 11l6 6"/></svg></button><button type="button" data-jb="clr" aria-label="清除全部选区" title="清除全部选区" hidden><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg></button><button type="button" data-jb="done" aria-label="完成选区" title="完成" hidden><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg></button><label class="dd-jb-brush" hidden title="画笔粗细"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/></svg><input type="range" min="2" max="20" step="1" data-jb-brush aria-label="画笔粗细"></label></div>'
    +'<div class="dd-jb-panel" hidden><div class="dd-jb-row"><b>范围</b><button type="button" data-jb-scope="local">局部</button><button type="button" data-jb-scope="smudge">抹开</button><button type="button" data-jb-scope="whole">全屏</button></div>'
    +'<div class="dd-jb-row"><b>选区</b><button type="button" data-jb="sel">✎ 涂选区</button><button type="button" data-jb="clr2">清除</button><em class="dd-jb-hint"></em></div>'
    +'<div class="dd-jb-row"><b>交互</b><button type="button" data-jb-in="tap">点击</button><button type="button" data-jb-in="drag">拖动</button><button type="button" data-jb-in="shake">摇晃</button></div>'
    +'<div class="dd-jb-msg" role="status"></div></div>';
   const $b=sel=>bar.querySelector(sel);
   const setMsg=t=>{$b('.dd-jb-msg').textContent=t||'';};
   const paintBar=()=>{
    const c=ddJellyCfg(),img=overlay.querySelector('img'),S=img?ddJellyState(img):{has:false,selecting:false};
    $b('[data-jb=power]').textContent=c.on?'果冻：开':'果冻：关';$b('[data-jb=power]').classList.toggle('is-active',c.on);
    bar.classList.toggle('is-off',!c.on);bar.classList.toggle('is-selecting',!!S.selecting);
    bar.querySelectorAll('[data-jb-scope]').forEach(b=>b.classList.toggle('is-active',b.dataset.jbScope===c.scope));
    const ins={tap:c.tap,drag:c.drag,shake:c.shake};bar.querySelectorAll('[data-jb-in]').forEach(b=>b.classList.toggle('is-active',!!ins[b.dataset.jbIn]));
    $b('[data-jb=sel]').classList.toggle('is-active',!!S.selecting);
    $b('.dd-jb-hint').textContent=S.has?'已选区（只有选中的地方会动）':'未选区（整张图都会动）';
    $b('.dd-jb-brush').hidden=!S.selecting;bar.querySelectorAll('[data-jb-tool]').forEach(t=>{t.hidden=!S.selecting;t.classList.toggle('is-active',(S.tool||'add')===t.dataset.jbTool);});$b('[data-jb=power]').hidden=!!S.selecting;{const bi=$b('[data-jb-brush]');if(bi&&document.activeElement!==bi)bi.value=String(Math.round(ddJellyBrush()*100));}
    $b('[data-jb=done]').hidden=!S.selecting;$b('[data-jb=clr]').hidden=!S.selecting;$b('[data-jb=more]').hidden=!!S.selecting;
    if(S.selecting)$b('.dd-jb-panel').hidden=true;
    $b('[data-jb=more]').textContent=$b('.dd-jb-panel').hidden?'设置 ▴':'收起 ▾';
   };
   const syncSettings=()=>{};
   const rebind=()=>{ddAttachJelly(overlay.querySelector('img'));paintBar();syncSettings();};
   bar.addEventListener('input',e=>{
    const bi=e.target.closest('[data-jb-brush]');if(!bi)return;e.stopPropagation();
    ddCfg().jellyBrush=Number(bi.value)/100;ddSave();
    // 临时画一个圈让你看到当前粗细
    const img=overlay.querySelector('img'),host=img.offsetParent||img.parentElement;if(!host)return;
    let ring=host.querySelector('.dd-jb-ring');if(!ring){ring=document.createElement('div');ring.className='dd-jb-ring';host.appendChild(ring);}
    const d=2.2*ddJellyBrush()*Math.min(img.clientWidth,img.clientHeight);
    ring.style.cssText='position:absolute;pointer-events:none;z-index:4;border-radius:50%;border:2px solid var(--dd-accent,#e58aa8);background:color-mix(in srgb,var(--dd-accent,#e58aa8) 25%,transparent);width:'+d+'px;height:'+d+'px;left:'+(img.offsetLeft+img.clientWidth/2-d/2)+'px;top:'+(img.offsetTop+img.clientHeight/2-d/2)+'px';
    clearTimeout(ring._t);ring._t=setTimeout(()=>ring.remove(),800);
   });
   bar.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b)return;e.preventDefault();e.stopPropagation();
    const c=ddCfg(),img=overlay.querySelector('img'),S=ddJellyState(img),d=b.dataset;
    if(d.jb==='power'){ddJellyCfg();c.jellyOn=!c.jellyOn;if(!c.jellyOn)S.selecting=false;ddSave();rebind();return;}
    if(d.jb==='more'){const p=$b('.dd-jb-panel');p.hidden=!p.hidden;paintBar();return;}
    if(d.jb==='sel'){ddJellyCfg();if(!c.jellyOn){c.jellyOn=true;ddSave();}S.selecting=true;S.tool='add';rebind();return;}
    if(d.jbTool){S.tool=d.jbTool;paintBar();return;}
    if(d.jb==='done'){S.selecting=false;rebind();return;}
    if(d.jb==='clr'||d.jb==='clr2'){ddJellyClearSelection(img);if(d.jb==='clr')S.selecting=true;rebind();return;}
    if(d.jbScope){ddJellyCfg();c.jellyScope=d.jbScope;c.jellyOn=true;ddSave();rebind();return;}
    if(d.jbIn){
     ddJellyCfg();const key={tap:'jellyTap',drag:'jellyDrag',shake:'jellyShake'}[d.jbIn];c[key]=!c[key];if(c[key])c.jellyOn=true;ddSave();
     if(d.jbIn==='shake'&&c.jellyShake){setMsg('');await ddJellyEnableMotion(setMsg);}
     else if(d.jbIn==='shake')setMsg('');
     rebind();
    }
   });
   overlay._ddPaintBar=paintBar;overlay._ddMsg=setMsg;overlay.append(bar);
  
 return overlay.querySelector('.dd-jelly-bar');
}

// ===== 放大弹窗 =====
let ddPicking=false,ddPickUi=null;
function ddToast(text){
 let t=document.querySelector('.dd-toast');if(!t){t=document.createElement('div');t.className='dd-toast';t.setAttribute('role','status');document.body.append(t);}
 t.textContent=text;t.classList.add('is-on');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('is-on'),2600);
}
function ddOpenViewer(url){
 let dlg=document.querySelector('dialog.dd-viewer');
 if(!dlg){
  dlg=document.createElement('dialog');dlg.className='dd-viewer';dlg.setAttribute('aria-label','果冻放大图');
  dlg.innerHTML='<button type="button" class="dd-close" aria-label="关闭" title="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button><div class="dd-stage"><img alt="放大查看的图片" draggable="false"></div>';
  const bar=ddBuildBar(dlg);dlg.append(bar);
  dlg.addEventListener('click',e=>{
   // 手指抬起后系统会补发一个 click，落在刚打开的弹窗上，会被当成点了背景而立刻关掉；打开后短时间内忽略点背景。
   if(e.target===dlg&&Date.now()-(dlg._ddOpenedAt||0)<600)return;
   if(e.target===dlg||e.target.closest('.dd-close')){if(dlg.open)dlg.close();else dlg.removeAttribute('open');}});
  dlg.addEventListener('close',()=>{dlg.querySelector('img')?.removeAttribute('src');dlg.querySelector('img')?._ddJellyAbort?.abort();ddOnViewerClosed();});
  document.body.append(dlg);
 }
 const img=dlg.querySelector('img');
 img.src=url;
 ddJellyClearSelection(img);{const p=dlg.querySelector('.dd-jb-panel');if(p)p.hidden=true;}dlg._ddMsg?.('');
 ddAttachJelly(img);dlg._ddPaintBar?.();
 dlg._ddOpenedAt=Date.now();
 if(!dlg.open){if(typeof dlg.showModal==='function')dlg.showModal();else{dlg.setAttribute('open','');dlg.style.position='fixed';}}
}
function ddOnViewerClosed(){if(ddPicking)ddShowPickUi(true);}

// ===== 取图：从页面上点中的元素里拿到可以显示的地址 =====
function ddBgUrl(el){
 const tag=el.tagName;if(tag==='BODY'||tag==='HTML'||el.id==='bg1'||el.id==='bg_custom')return '';
 const win=el.ownerDocument.defaultView;if(!win)return '';
 let bi='';try{bi=win.getComputedStyle(el).backgroundImage;}catch{return '';}
 const m=/url\((['"]?)(.*?)\1\)/.exec(bi||'');if(!m||!m[2])return '';
 const r=el.getBoundingClientRect();if(r.width*r.height>.9*win.innerWidth*win.innerHeight)return '';
 try{return new URL(m[2],el.ownerDocument.baseURI).href;}catch{return m[2];}
}
function ddFlatList(root,x,y,depth=0){
 // elementsFromPoint 不会钻进 shadow DOM，这里把开着的 shadowRoot 里的元素也展开出来（上层在前）
 let list=[];try{list=root.elementsFromPoint(x,y);}catch{}
 const out=[];
 for(const el of list){
  if(el.shadowRoot&&depth<4){try{out.push(...ddFlatList(el.shadowRoot,x,y,depth+1));}catch{}}
  out.push(el);
 }
 return out;
}
function ddFindAt(x,y,doc=document,ox=0,oy=0,depth=0){
 const list=ddFlatList(doc,x,y);
 for(const el of list){
  if(el.closest?.('.dd-pick,.dd-ball,.dd-viewer,.dd-hl,.dd-toast'))continue;
  const tag=el.tagName;
  if(tag==='IFRAME'){
   if(depth>=4)continue;
   try{const d=el.contentDocument;if(d){const r=el.getBoundingClientRect();const hit=ddFindAt(x-r.left,y-r.top,d,ox+r.left,oy+r.top,depth+1);if(hit)return hit;}}catch{}
   continue;
  }
  if(tag==='IMG'&&(el.currentSrc||el.src))return {kind:'img',el,ox,oy};
  if(tag==='CANVAS')return {kind:'canvas',el,ox,oy};
  if(tag==='image'&&el.closest('svg')){const href=el.getAttribute('href')||el.getAttribute('xlink:href');if(href)return {kind:'svgimg',el,href,ox,oy};}
  const bg=ddBgUrl(el);if(bg)return {kind:'bg',el,url:bg,ox,oy};
 }
 return null;
}
// 非同源的图先试着抓成 blob（对方允许跨域才行）；抓不到就直接用原地址，引擎会自动退回整图弹动版本。
async function ddMaterialize(url){
 if(!url)return '';
 if(/^(data|blob):/i.test(url))return url;
 try{if(new URL(url,location.href).origin===location.origin)return url;}catch{return url;}
 try{
  const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),3000);
  const r=await fetch(url,{mode:'cors',signal:ctl.signal});clearTimeout(t);
  if(!r.ok)throw new Error('bad');return URL.createObjectURL(await r.blob());
 }catch{return url;}
}
async function ddSourceOf(hit){
 if(hit.kind==='img')return ddMaterialize(hit.el.currentSrc||hit.el.src);
 if(hit.kind==='bg')return ddMaterialize(hit.url);
 if(hit.kind==='svgimg')return ddMaterialize(hit.href);
 if(hit.kind==='canvas'){
  try{return await new Promise((res,rej)=>hit.el.toBlob(b=>b?res(URL.createObjectURL(b)):rej(new Error('empty')),'image/png'));}
  catch{try{return hit.el.toDataURL('image/png');}catch{return '';}}
 }
 return '';
}

// ===== 选图模式 =====
function ddShowPickUi(on){
 if(!ddPickUi)return;
 ddPickUi.root.style.display=on?'block':'none';
 if(!on)ddPickUi.hl.style.display='none';
}
function ddHighlight(hit){
 const hl=ddPickUi?.hl;if(!hl)return;
 if(!hit){hl.style.display='none';return;}
 const r=hit.el.getBoundingClientRect();
 hl.style.cssText='display:block;left:'+(r.left+hit.ox)+'px;top:'+(r.top+hit.oy)+'px;width:'+r.width+'px;height:'+r.height+'px';
}
function ddDescribe(x,y){
 try{
  const names=[];
  for(const el of ddFlatList(document,x,y)){
   if(el.closest?.('.dd-pick,.dd-ball,.dd-hl'))continue;
   names.push(el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(typeof el.className==='string'&&el.className?'.'+el.className.trim().split(/\s+/)[0]:''));
   if(names.length>=3)break;
  }
  return names.join(' > ')||'空白';
 }catch{return '?';}
}
async function ddHandleTap(x,y){
 try{
  const hit=ddFindAt(x,y);
  if(!hit){ddToast('这里没有找到图片（点到的是：'+ddDescribe(x,y)+'）');return;}
  ddToast('识别到图片，正在打开…');
  const url=await ddSourceOf(hit);
  if(!url){ddToast('这张图抓不到（可能被浏览器保护了）');return;}
  ddShowPickUi(false);ddOpenViewer(url);
 }catch(err){
  console.warn('[duangduang] 选图失败',err);
  ddToast('选图出错：'+((err&&err.message)||err));
 }
}
function ddEnterPick(){
 if(ddPicking)return;
 ddPicking=true;document.querySelector('.dd-ball')?.classList.add('is-active');
 const root=document.createElement('div');root.className='dd-pick';
 root.innerHTML='<div class="dd-pick-hint"><span>点一张图片，把它放大来玩</span><button type="button" class="dd-pick-exit" aria-label="退出选图">✕</button></div><div class="dd-hl"></div>';
 const hl=root.querySelector('.dd-hl');
 let raf=0,last=null,down=null;
 const inRoot=e=>!!ddPickUi&&ddPickUi.root.contains(e.target);
 const probe=e=>{last=e;if(raf)return;raf=requestAnimationFrame(()=>{raf=0;ddHighlight(ddFindAt(last.clientX,last.clientY));});};
 // 挂在 window 的捕获阶段：比页面上别的插件先收到事件，避免被它们拦掉
 const onMove=e=>{if(inRoot(e))probe(e);};
 const onDown=e=>{if(!inRoot(e))return;down={x:e.clientX,y:e.clientY,exit:!!e.target.closest('.dd-pick-exit')};if(!down.exit)probe(e);e.preventDefault();e.stopPropagation();};
 const onUp=e=>{
  if(!down||!inRoot(e))return;
  const d=down;down=null;e.preventDefault();e.stopPropagation();
  if(Math.hypot(e.clientX-d.x,e.clientY-d.y)>14)return;
  if(d.exit&&e.target.closest('.dd-pick-exit')){ddExitPick();return;}
  if(d.exit)return;
  ddHandleTap(e.clientX,e.clientY);
 };
 const onClick=e=>{if(inRoot(e)){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();}};
 const onCtx=e=>{if(inRoot(e))e.preventDefault();};
 const evs=[['pointermove',onMove],['pointerdown',onDown],['pointerup',onUp],['click',onClick],['contextmenu',onCtx]];
 for(const [n,f] of evs)window.addEventListener(n,f,true);
 ddPickUi={root,hl,cleanup:()=>{for(const [n,f] of evs)window.removeEventListener(n,f,true);cancelAnimationFrame(raf);}};
 document.body.append(root);
 document.addEventListener('keydown',ddPickKey,true);
}
function ddPickKey(e){if(e.key==='Escape'&&ddPicking&&!document.querySelector('dialog.dd-viewer[open]')){e.stopPropagation();ddExitPick();}}
function ddExitPick(){
 ddPicking=false;document.querySelector('.dd-ball')?.classList.remove('is-active');
 ddPickUi?.cleanup?.();ddPickUi?.root.remove();ddPickUi=null;document.removeEventListener('keydown',ddPickKey,true);
}

// ===== 悬浮球 =====
const DD_BALL_SVG='<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 5c10 0 19 7 19 18 0 11-8 20-19 20S5 34 5 23C5 12 14 5 24 5z" fill="currentColor"/><circle cx="17" cy="22" r="2.6" fill="#fff"/><circle cx="31" cy="22" r="2.6" fill="#fff"/><path d="M18 30q6 5 12 0" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>';
function ddPlaceBall(ball){
 const c=ddCfg(),w=ball.offsetWidth||46,h=ball.offsetHeight||46;
 const x=Math.max(0,Math.min(window.innerWidth-w,c.ballX*(window.innerWidth-w))),y=Math.max(0,Math.min(window.innerHeight-h,c.ballY*(window.innerHeight-h)));
 ball.style.left=x+'px';ball.style.top=y+'px';
}
function ddMountBall(){
 let ball=document.querySelector('.dd-ball');
 if(!ddCfg().ballOn){ball?.remove();return;}
 if(ball)return;
 ball=document.createElement('button');ball.type='button';ball.className='dd-ball';ball.setAttribute('aria-label','Duang 果冻：选一张图来玩');ball.title='Duang 果冻（点一下选图，拖动可挪位置）';ball.innerHTML=DD_BALL_SVG;
 document.body.append(ball);ddPlaceBall(ball);
 let drag=null;
 ball.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse'&&e.button!==0)return;
  const r=ball.getBoundingClientRect();drag={id:e.pointerId,dx:e.clientX-r.left,dy:e.clientY-r.top,sx:e.clientX,sy:e.clientY,moved:false};
  try{ball.setPointerCapture(e.pointerId);}catch{}
 });
 ball.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.id)return;
  if(!drag.moved&&Math.hypot(e.clientX-drag.sx,e.clientY-drag.sy)<6)return;
  drag.moved=true;ball.classList.add('is-dragging');
  const w=ball.offsetWidth,h=ball.offsetHeight;
  ball.style.left=Math.max(0,Math.min(window.innerWidth-w,e.clientX-drag.dx))+'px';ball.style.top=Math.max(0,Math.min(window.innerHeight-h,e.clientY-drag.dy))+'px';
 });
 const end=e=>{
  if(!drag||e.pointerId!==drag.id)return;
  const d=drag;drag=null;ball.classList.remove('is-dragging');try{ball.releasePointerCapture(d.id);}catch{}
  if(d.moved){
   // 松手后吸附到左右边缘，位置按比例记住
   const w=ball.offsetWidth,h=ball.offsetHeight,r=ball.getBoundingClientRect();
   const toRight=r.left+w/2>window.innerWidth/2;
   const c=ddCfg();c.ballX=toRight?1:0;c.ballY=Math.max(0,Math.min(1,r.top/Math.max(1,window.innerHeight-h)));ddSave();ddPlaceBall(ball);
  }else{ddPicking?ddExitPick():ddEnterPick();}
 };
 ball.addEventListener('pointerup',end);ball.addEventListener('pointercancel',end);
 window.addEventListener('resize',()=>ddPlaceBall(ball));
}

// ===== 扩展设置面板 =====
function ddMountSettings(){
 const host=document.querySelector('#extensions_settings2')||document.querySelector('#extensions_settings');
 if(!host||host.querySelector('#dd-settings'))return !!host&&!!host.querySelector('#dd-settings');
 const c=ddCfg();
 const box=document.createElement('div');box.id='dd-settings';box.className='extension_container';
 box.innerHTML='<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Duang 果冻</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">'
  +'<label class="checkbox_label"><input id="dd-ball-on" type="checkbox"><span>显示悬浮球</span></label>'
  +'<div class="dd-set-row"><label for="dd-strength">弹性</label><select id="dd-strength" class="text_pole"><option value="soft">软糯（幅度小）</option><option value="mid">适中</option><option value="bouncy">超Q（幅度大）</option></select></div>'
  +'<div class="dd-set-row"><input id="dd-ball-reset" type="button" class="menu_button" value="重置悬浮球位置"></div>'
  +'<small>点悬浮球进入选图模式，再点任意一张图，就会放大到弹窗里玩果冻。范围、选区、交互（点击 / 拖动 / 摇晃）都在弹窗下方的小面板里。</small></div></div>';
 host.append(box);
 const on=box.querySelector('#dd-ball-on'),st=box.querySelector('#dd-strength');
 on.checked=!!c.ballOn;on.onchange=()=>{ddCfg().ballOn=on.checked;ddSave();ddMountBall();};
 st.value=['soft','bouncy'].includes(c.jellyStrength)?c.jellyStrength:'mid';st.onchange=()=>{ddCfg().jellyStrength=st.value;ddSave();};
 box.querySelector('#dd-ball-reset').onclick=()=>{const k=ddCfg();k.ballX=1;k.ballY=.62;ddSave();const b=document.querySelector('.dd-ball');if(b)ddPlaceBall(b);};
 return true;
}

function ddInit(){
 if(window.__duangduangReady)return;window.__duangduangReady=true;
 ddMountBall();
 let tries=0;const t=setInterval(()=>{if(ddMountSettings()||++tries>40)clearInterval(t);},500);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ddInit);else ddInit();
