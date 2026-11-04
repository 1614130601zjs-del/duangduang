// Duang 果冻（duangduang）—— 悬浮球 + 选图 + 放大弹窗 + 果冻互动。
// 点悬浮球进入选图模式，点任意一张图（普通图 / canvas / 背景图 / 同源 iframe 里的图），会把它复制一份到自己的弹窗里玩，不改动原图，也不会被别的插件重绘冲掉。
import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '/script.js';

const EXT='duangduang';
const defaults={ballOn:true,ballX:1,ballY:.62,ballShake:true,ballIcon:'default',ballIconPicked:false,ballFixed:26,ballCustoms:[],ballSize:56,jellyOn:true,jellyScope:'local',jellyTap:false,jellyDrag:true,jellyShake:false,jellyStrength:'mid',jellyBrush:.075};
function ddCfg(){
 if(!extension_settings[EXT])extension_settings[EXT]={};
 const c=extension_settings[EXT];
 for(const k of Object.keys(defaults))if(c[k]===undefined)c[k]=defaults[k];
 // 旧版只存一张上传图 ballCustom，迁移成列表
 if(c.ballCustom){if(!Array.isArray(c.ballCustoms))c.ballCustoms=[];if(!c.ballCustoms.length)c.ballCustoms.push({id:'u1',url:c.ballCustom});if(c.ballIcon==='custom')c.ballIcon='custom:'+c.ballCustoms[0].id;delete c.ballCustom;}
 if(!Array.isArray(c.ballCustoms))c.ballCustoms=[];
 // 没手动挑过图标的人，自动换成内置的果冻图标
 if(c.ballIcon==='default'&&!c.ballIconPicked&&typeof DD_BUILTIN_ICONS!=='undefined'&&DD_BUILTIN_ICONS.includes('jelly.png'))c.ballIcon='jelly.png';
 return c;
}
const ddSave=()=>{try{saveSettingsDebounced();}catch{}};

// ===== 放大图小互动（果冻）：范围（局部 / 抹开 / 全屏）× 选区（可选）× 交互（点击 / 拖动 / 摇晃） =====
// 弹簧动画只在触摸 / 拖动 / 摇晃时跑，松手停稳后自动结束；选区只在放大图打开期间保留。
const DD_JELLY_MW=48,DD_JELLY_MH=48;
function ddJellyReach(){const r=Number(ddCfg().jellyReach);return Number.isFinite(r)&&r>0?Math.max(.4,Math.min(2.2,r)):1;}
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
 return {on:c.jellyOn,scope:['smudge','whole'].includes(c.jellyScope)?c.jellyScope:'local',tap:false,drag:c.jellyDrag,shake:c.jellyShake,amp:{soft:.35,mid:.5,bouncy:.65}[c.jellyStrength]||.5,reach:ddJellyReach()};
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
 const accentRgb=()=>[255,64,129]; // 选区固定用醒目的玫红，不随主题变化，放在各种图上都看得清
 const paintSel=()=>{
  if(!selCv)return;
  const x=selCv.getContext('2d'),id=x.createImageData(MW,MH),[r,g,b]=accentRgb();
  for(let k=0;k<MW*MH;k++){id.data[k*4]=r;id.data[k*4+1]=g;id.data[k*4+2]=b;id.data[k*4+3]=Math.round(Math.min(1,S.mask[k])*175);}
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
  const m=Math.min(boxW,boxH),R=.17*m*ddJellyReach(),R2=.22*m*ddJellyReach(),RR=R*R,RR2=R2*R2,shAmp=.05*m*amp;
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
    +'<div class="dd-jb-row"><b>交互</b><button type="button" data-jb-in="drag">拖动</button><button type="button" data-jb-in="shake">摇晃</button>'
    +'<span class="dd-jb-dd"><button type="button" class="dd-jb-dd-btn" data-jb-dd aria-haspopup="listbox" aria-expanded="false"><span data-jb-dd-label>Q弹</span> ▾</button><span class="dd-jb-dd-list" role="listbox" hidden><button type="button" role="option" data-jb-strength="soft">软糯</button><button type="button" role="option" data-jb-strength="mid">Q弹</button><button type="button" role="option" data-jb-strength="bouncy">DUANG</button></span></span></div>'
    +'<div class="dd-jb-row"><b>反馈</b><span class="dd-jb-brush dd-jb-reach"><small>小</small><input type="range" min="40" max="220" step="5" data-jb-reach aria-label="反馈范围"><small>大</small></span><em class="dd-jb-hint">手指按下去影响多大一块</em></div>'
    +'<div class="dd-jb-msg" role="status"></div></div>';
   const $b=sel=>bar.querySelector(sel);
   const setMsg=t=>{$b('.dd-jb-msg').textContent=t||'';};
   const paintBar=()=>{
    const c=ddJellyCfg(),img=overlay.querySelector('img'),S=img?ddJellyState(img):{has:false,selecting:false};
    $b('[data-jb=power]').textContent=c.on?'果冻：开':'果冻：关';$b('[data-jb=power]').classList.toggle('is-active',c.on);
    bar.classList.toggle('is-off',!c.on);bar.classList.toggle('is-selecting',!!S.selecting);
    bar.querySelectorAll('[data-jb-scope]').forEach(b=>b.classList.toggle('is-active',b.dataset.jbScope===c.scope));
    const ins={tap:c.tap,drag:c.drag,shake:c.shake};const stv=['soft','bouncy'].includes(ddCfg().jellyStrength)?ddCfg().jellyStrength:'mid';bar.querySelectorAll('[data-jb-strength]').forEach(b=>b.classList.toggle('is-active',b.dataset.jbStrength===stv));{const lab=$b('[data-jb-dd-label]');if(lab)lab.textContent={soft:'软糯',mid:'Q弹',bouncy:'DUANG'}[stv];}bar.querySelectorAll('[data-jb-in]').forEach(b=>b.classList.toggle('is-active',!!ins[b.dataset.jbIn]));
    {const ri=$b('[data-jb-reach]');if(ri&&document.activeElement!==ri)ri.value=Math.round(ddJellyReach()*100);}
    $b('[data-jb=sel]').classList.toggle('is-active',!!S.selecting);
    $b('.dd-jb-hint').textContent=S.has?'已选区（只有选中的地方会动）':'未选区（整张图都会动）';
    $b('.dd-jb-brush').hidden=!S.selecting;bar.querySelectorAll('[data-jb-tool]').forEach(t=>{t.hidden=!S.selecting;t.classList.toggle('is-active',(S.tool||'add')===t.dataset.jbTool);});$b('[data-jb=power]').hidden=!!S.selecting;{const bi=$b('[data-jb-brush]');if(bi&&document.activeElement!==bi)bi.value=String(Math.round(ddJellyBrush()*100));}
    $b('[data-jb=done]').hidden=!S.selecting;$b('[data-jb=clr]').hidden=!S.selecting;$b('[data-jb=more]').hidden=!!S.selecting;
    if(S.selecting)$b('.dd-jb-panel').hidden=true;
    $b('[data-jb=more]').textContent=$b('.dd-jb-panel').hidden?'设置 ▴':'收起 ▾';
   };
   const syncSettings=()=>{const sel=document.querySelector('#dd-strength');if(sel)sel.value=['soft','bouncy'].includes(ddCfg().jellyStrength)?ddCfg().jellyStrength:'mid';};
   const rebind=()=>{ddAttachJelly(overlay.querySelector('img'));paintBar();syncSettings();};
   bar.addEventListener('input',e=>{
    const rr=e.target.closest('[data-jb-reach]');
    if(rr){e.stopPropagation();ddCfg().jellyReach=Number(rr.value)/100;ddSave();
     const img=overlay.querySelector('img'),host=img&&(img.offsetParent||img.parentElement);if(!host)return;
     let ring=host.querySelector('.dd-jb-ring');if(!ring){ring=document.createElement('div');ring.className='dd-jb-ring';host.appendChild(ring);}
     const d=2*.19*ddJellyReach()*Math.min(img.clientWidth,img.clientHeight);
     ring.style.cssText='position:absolute;pointer-events:none;z-index:4;border-radius:50%;border:2px dashed #ff4081;background:rgba(255,64,129,.18);width:'+d+'px;height:'+d+'px;left:'+(img.offsetLeft+img.clientWidth/2-d/2)+'px;top:'+(img.offsetTop+img.clientHeight/2-d/2)+'px';
     clearTimeout(ring._t);ring._t=setTimeout(()=>ring.remove(),800);return;}
    const bi=e.target.closest('[data-jb-brush]');if(!bi)return;e.stopPropagation();
    ddCfg().jellyBrush=Number(bi.value)/100;ddSave();
    // 临时画一个圈让你看到当前粗细
    const img=overlay.querySelector('img'),host=img.offsetParent||img.parentElement;if(!host)return;
    let ring=host.querySelector('.dd-jb-ring');if(!ring){ring=document.createElement('div');ring.className='dd-jb-ring';host.appendChild(ring);}
    const d=2.2*ddJellyBrush()*Math.min(img.clientWidth,img.clientHeight);
    ring.style.cssText='position:absolute;pointer-events:none;z-index:4;border-radius:50%;border:2px solid #ff4081;background:rgba(255,64,129,.25);width:'+d+'px;height:'+d+'px;left:'+(img.offsetLeft+img.clientWidth/2-d/2)+'px;top:'+(img.offsetTop+img.clientHeight/2-d/2)+'px';
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
    if(d.jbDd!==undefined){const l=$b('.dd-jb-dd-list'),p=$b('.dd-jb-panel');l.hidden=!l.hidden;p.classList.toggle('is-dd-open',!l.hidden);b.setAttribute('aria-expanded',String(!l.hidden));return;}
    if(d.jbStrength){c.jellyStrength=d.jbStrength;ddSave();{const l=$b('.dd-jb-dd-list'),p=$b('.dd-jb-panel');l.hidden=true;p.classList.remove('is-dd-open');$b('[data-jb-dd]').setAttribute('aria-expanded','false');}rebind();return;}
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
  dlg.addEventListener('close',()=>{ddBallBack();dlg.querySelector('img')?.removeAttribute('src');dlg.querySelector('img')?._ddJellyAbort?.abort();ddOnViewerClosed();});
  document.body.append(dlg);
 }
 const img=dlg.querySelector('img');
 img.src=url;
 ddJellyClearSelection(img);{const p=dlg.querySelector('.dd-jb-panel');if(p)p.hidden=true;}dlg._ddMsg?.('');
 ddAttachJelly(img);dlg._ddPaintBar?.();
 dlg._ddOpenedAt=Date.now();
 ddBallInto(dlg);
 if(!dlg.open){if(typeof dlg.showModal==='function')dlg.showModal();else{dlg.setAttribute('open','');dlg.style.position='fixed';}}
}
// 模态弹窗会把页面其他内容压在下面，悬浮球就看不见了；弹窗打开期间把球临时搬进弹窗里，关闭后搬回 body。
function ddBallInto(dlg){const b=document.querySelector('.dd-ball');if(b&&b.parentElement!==dlg)dlg.append(b);}
function ddBallBack(){const b=document.querySelector('.dd-ball');if(b&&b.parentElement!==document.body)document.body.append(b);}
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
 const ours=e=>!!(e.target&&e.target.closest&&e.target.closest('.dd-ball,.dd-viewer,.dd-toast'));
 const probe=e=>{last=e;if(raf)return;raf=requestAnimationFrame(()=>{raf=0;ddHighlight(ddFindAt(last.clientX,last.clientY));});};
 // 选图模式下，在 window 的捕获阶段把所有不属于拾取层、悬浮球和弹窗的点击 / 触摸全部拦下，
 // 这样即使别的元素盖在上面，酒馆原本的点击行为（比如点头像放大）也不会被触发。
 const block=e=>{if(ours(e))return false;e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();return true;};
 const onMove=e=>{if(!ours(e))probe(e);};
 const onDown=e=>{
  if(ours(e))return;
  down={x:e.clientX,y:e.clientY,exit:!!(e.target.closest&&e.target.closest('.dd-pick-exit'))};
  if(!down.exit)probe(e);
  block(e);
 };
 const onUp=e=>{
  if(ours(e))return;
  const d=down;down=null;block(e);
  if(!d)return;
  if(Math.hypot(e.clientX-d.x,e.clientY-d.y)>14)return;
  if(d.exit){ddExitPick();return;}
  ddHandleTap(e.clientX,e.clientY);
 };
 const onOther=e=>{block(e);};
 const evs=[['pointermove',onMove,{capture:true}],['pointerdown',onDown,{capture:true}],['pointerup',onUp,{capture:true}]];
 for(const n of ['mousedown','mouseup','click','dblclick','auxclick','contextmenu','touchstart','touchend'])evs.push([n,onOther,{capture:true,passive:false}]);
 for(const [n,f,o] of evs)window.addEventListener(n,f,o);
 ddPickUi={root,hl,cleanup:()=>{for(const [n,f,o] of evs)window.removeEventListener(n,f,o);cancelAnimationFrame(raf);}};
 document.body.append(root);
 document.addEventListener('keydown',ddPickKey,true);
 ddToast('选图模式已开：点一张图片');
}
function ddPickKey(e){if(e.key==='Escape'&&ddPicking&&!document.querySelector('dialog.dd-viewer[open]')){e.stopPropagation();ddExitPick();}}
function ddExitPick(){
 ddPicking=false;document.querySelector('.dd-ball')?.classList.remove('is-active');
 ddPickUi?.cleanup?.();ddPickUi?.root.remove();ddPickUi=null;document.removeEventListener('keydown',ddPickKey,true);
}

// ===== 悬浮球 =====
const DD_BALL_SVG='<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 5c10 0 19 7 19 18 0 11-8 20-19 20S5 34 5 23C5 12 14 5 24 5z" fill="currentColor"/><circle cx="17" cy="22" r="2.6" fill="#fff"/><circle cx="31" cy="22" r="2.6" fill="#fff"/><path d="M18 30q6 5 12 0" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>';
// 内置悬浮球图标：把 png 放进 icons/ 文件夹，再把文件名加进这个列表就会出现在设置里
const DD_BUILTIN_ICONS=['jelly.png'];
function ddIconUrl(name){try{return new URL('./icons/'+name,import.meta.url).href;}catch{return 'icons/'+name;}}
function ddCustomUrl(id){if(typeof id!=='string'||!id.startsWith('custom:'))return '';const it=ddCfg().ballCustoms.find(x=>'custom:'+x.id===id);return it?it.url:'';}
function ddBallOneHtml(){
 const c=ddCfg();
 {const u=ddCustomUrl(c.ballIcon);if(u)return '<img alt="" draggable="false" src="'+u+'">';}
 if(DD_BUILTIN_ICONS.includes(c.ballIcon))return '<img alt="" draggable="false" src="'+ddIconUrl(c.ballIcon)+'">';
 return DD_BALL_SVG;
}
function ddIconSrc(){const c=ddCfg();{const u=ddCustomUrl(c.ballIcon);if(u)return u;}if(DD_BUILTIN_ICONS.includes(c.ballIcon))return ddIconUrl(c.ballIcon);return '';}
// 悬浮球用一张画布画：把图标切成很多细条，越靠上的条被摇得越远，固定线上就是连着的，像一整块果冻被拉扯，而不是上下两块分开
function ddBallHtml(){return '<canvas class="dd-bl dd-cv"></canvas>';}
let ddCv=null;
function ddSvgSrc(){return 'data:image/svg+xml;utf8,'+encodeURIComponent(DD_BALL_SVG.replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" '));}
function ddIsGif(u){return /^data:image\/gif/i.test(u||'')||/\.gif(\?|#|$)/i.test(u||'');}
function ddSetupCanvas(ball){
 const cv=ball.querySelector('canvas.dd-cv');if(!cv)return;
 const src0=ddIconSrc();
 // 动图（gif）画布只能画第一帧，所以改用原图直接显示，摇晃时整张以底边为轴歪
 if(src0&&ddIsGif(src0)){
  const im=document.createElement('img');im.className='dd-bl dd-gif';im.alt='';im.draggable=false;im.src=src0;
  cv.replaceWith(im);ddCv={gif:im};return;
 }
 const bw=ball.offsetWidth||56,bh=ball.offsetHeight||56,dpr=Math.min(2,window.devicePixelRatio||1);
 const padX=bw*.4,padT=bh*.4,padB=bh*.05;
 cv.width=Math.round((bw+padX*2)*dpr);cv.height=Math.round((bh+padT+padB)*dpr);
 cv.style.cssText='left:'+(-padX)+'px;top:'+(-padT)+'px;width:'+(bw+padX*2)+'px;height:'+(bh+padT+padB)+'px';
 const st={cv,bw,bh,dpr,padX,padT,img:null};ddCv=st;
 const im=new Image();im.onload=()=>{if(ddCv===st){st.img=im;ddDraw(0,0);}};im.src=ddIconSrc()||ddSvgSrc();
}
function ddDraw(r,s){
 const st=ddCv;
 if(st&&st.gif){st.gif.style.transformOrigin='50% 100%';st.gif.style.transform=(r||s)?'skewX('+(-r).toFixed(2)+'deg) scale('+(1-s*.5).toFixed(3)+','+(1+s).toFixed(3)+')':'';return;}
 if(!st||!st.img||!document.body.contains(st.cv))return;
 const {cv,bw,bh,dpr,padX,padT,img}=st,ctx=cv.getContext('2d');
 ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,cv.width,cv.height);
 ctx.setTransform(dpr,0,0,dpr,padX*dpr,padT*dpr);
 const fixed=Math.max(0,Math.min(70,Number(ddCfg().ballFixed)||0)),pinY=bh*(1-fixed/100);
 if(!r&&!s){ctx.drawImage(img,0,0,bw,bh);return;}
 const N=40,ih=img.naturalHeight||1,iw=img.naturalWidth||1,tr=Math.tan(r*Math.PI/180),sxTop=1-s*.5,cx=bw/2;
 // 固定线以下原样画
 const bot=Math.max(0,Math.min(1,pinY/bh));
 if(bot<1)ctx.drawImage(img,0,bot*ih,iw,ih*(1-bot),0,pinY,bw,bh-pinY);
 for(let i=0;i<N;i++){
  const y0=pinY*i/N,y1=pinY*(i+1)/N;               // 盒子里这一条的上下边（未变形）
  const d0=pinY-y0,d1=pinY-y1;                    // 离固定线的距离
  const Y0=pinY-d0*(1+s),Y1=pinY-d1*(1+s);        // 变形后的位置：越靠上拉得越开
  const xo0=tr*d0,xo1=tr*d1;                      // 越靠上，横向偏得越多
  const um=((d0+d1)/2)/pinY,a=1+(sxTop-1)*um;
  const hs=y1-y0,hd=Y1-Y0;if(Math.abs(hd)<1e-3)continue;
  const sy=(y0/bh)*ih,sh=Math.min(ih-sy,(hs/bh)*ih+1);
  ctx.save();
  ctx.transform(a,0,(xo1-xo0)/hs,hd/hs,cx*(1-a)+xo0,Y0);
  ctx.drawImage(img,0,sy,iw,sh,0,0,bw,sh/ih*bh);
  ctx.restore();
 }
}
const ddDimCache={};
function ddMeasure(src){
 return new Promise(res=>{
  if(!src){res([1,1]);return;}
  if(ddDimCache[src]){res(ddDimCache[src]);return;}
  const im=new Image();im.onload=()=>{ddDimCache[src]=[im.naturalWidth||1,im.naturalHeight||1];res(ddDimCache[src]);};im.onerror=()=>res([1,1]);im.src=src;
 });
}
let ddRefreshTick=0;
async function ddRefreshBall(){
 const ball=document.querySelector('.dd-ball');if(!ball)return;
 const my=++ddRefreshTick;
 const size=Math.max(28,Math.min(200,Number(ddCfg().ballSize)||56));
 const [w,h]=await ddMeasure(ddIconSrc());
 if(my!==ddRefreshTick||!document.body.contains(ball))return;
 const k=size/Math.max(w,h);
 ball.style.setProperty('--dd-ball-w',Math.round(w*k)+'px');ball.style.setProperty('--dd-ball-h',Math.round(h*k)+'px');
 ball.innerHTML=ddBallHtml();ddPlaceBall(ball);ddSetupCanvas(ball);
}
// 上传：优先把原图原样传到酒馆的用户文件目录（不压缩、不撑大设置文件，动图也保留）；传不上去时才退回存进设置里。
function ddFileToDataUrl(file){
 return new Promise((res,rej)=>{const fr=new FileReader();fr.onerror=()=>rej(new Error('读取失败'));fr.onload=()=>res(String(fr.result));fr.readAsDataURL(file);});
}
async function ddUploadIcon(file){
 const dataUrl=await ddFileToDataUrl(file);
 const m=/^data:([^;,]+)[^,]*;base64,(.*)$/s.exec(dataUrl);
 if(!m||!/^image\//.test(m[1]))throw new Error('这不是图片文件');
 const ext=({'image/png':'png','image/gif':'gif','image/webp':'webp','image/jpeg':'jpg','image/svg+xml':'svg','image/apng':'png','image/avif':'avif'})[m[1]]||'png';
 const name='duang_icon_'+Date.now().toString(36)+'.'+ext;
 try{
  const r=await fetch('/api/files/upload',{method:'POST',headers:getRequestHeaders(),body:JSON.stringify({name,data:m[2]})});
  if(!r.ok)throw new Error('HTTP '+r.status);
  const j=await r.json();const path=String(j.path||'').replace(/^\/+/,'');
  if(!path)throw new Error('没有返回路径');
  return {url:'/'+path.split('/').map(encodeURIComponent).join('/'),path,server:true,fallback:false};
 }catch(err){
  console.warn('[duangduang] 上传到酒馆文件目录失败，改存进设置',err);
  if(file.size<=1.5*1024*1024)return {url:dataUrl,server:false,fallback:'orig'};
  return {url:await ddReadIcon(file,512),server:false,fallback:'small'};
 }
}
async function ddDeleteIconFile(it){
 if(!it||!it.server||!it.path)return;
 try{await fetch('/api/files/delete',{method:'POST',headers:getRequestHeaders(),body:JSON.stringify({path:it.path})});}catch{}
}
// 退路：缩小后存进设置

function ddReadIcon(file,max=128){
 return new Promise((res,rej)=>{
  const fr=new FileReader();
  fr.onerror=()=>rej(new Error('读取失败'));
  fr.onload=()=>{
   const im=new Image();
   im.onerror=()=>rej(new Error('这不是能显示的图片'));
   im.onload=()=>{
    const k=Math.min(1,max/Math.max(im.naturalWidth,im.naturalHeight,1)),w=Math.max(1,Math.round(im.naturalWidth*k)),h=Math.max(1,Math.round(im.naturalHeight*k));
    const cv=document.createElement('canvas');cv.width=w;cv.height=h;cv.getContext('2d').drawImage(im,0,0,w,h);
    res(cv.toDataURL('image/png'));
   };
   im.src=String(fr.result);
  };
  fr.readAsDataURL(file);
 });
}
function ddPlaceBall(ball){
 const c=ddCfg(),w=ball.offsetWidth||46,h=ball.offsetHeight||46;
 const x=Math.max(0,Math.min(window.innerWidth-w,c.ballX*(window.innerWidth-w))),y=Math.max(0,Math.min(window.innerHeight-h,c.ballY*(window.innerHeight-h)));
 ball.style.left=x+'px';ball.style.top=y+'px';
}
// ===== 手机摇晃时，悬浮球（不管用哪张图标）也整体 duang 地晃一晃 =====
let ddBallMotion=false;
function ddStartBallShake(){
 if(ddBallMotion)return;ddBallMotion=true;
 // 底部固定在原位：只以图标底边中点为轴左右摇摆、上下压扁拉长，像不倒翁 / 果冻
 const st={r:0,vr:0,s:0,vs:0};let raf=0,gx=0,gy=0,primed=false;
 const tick=()=>{
  st.vr+=-st.r*.1;st.vr*=.9;st.r+=st.vr;
  st.vs+=-st.s*.14;st.vs*=.86;st.s+=st.vs;
  const live=Math.abs(st.r)+Math.abs(st.vr)+Math.abs(st.s*30)+Math.abs(st.vs*30)>.08;
  if(live)ddDraw(st.r,st.s);else{ddDraw(0,0);st.r=st.vr=st.s=st.vs=0;}
  raf=live?requestAnimationFrame(tick):0;
 };
 window.addEventListener('devicemotion',e=>{
  if(!ddCfg().ballShake||!document.querySelector('.dd-ball'))return;
  let ax=0,ay=0;const a=e.acceleration;
  if(a&&(a.x!=null||a.y!=null)){ax=a.x||0;ay=a.y||0;}
  else{const g=e.accelerationIncludingGravity||{};const vx=g.x||0,vy=g.y||0;if(!primed){gx=vx;gy=vy;primed=true;}gx=gx*.9+vx*.1;gy=gy*.9+vy*.1;ax=vx-gx;ay=vy-gy;}
  if(Math.abs(ax)+Math.abs(ay)<1.2)return;
  const k=ddJellyCfg().amp/.5,cl=(v,m)=>Math.max(-m,Math.min(m,v));
  st.vr+=cl(-ax*.16*k,1.8*k);st.vs+=cl(ay*.005*k,.02*k);
  st.r=cl(st.r,7);st.s=cl(st.s,.08);
  if(!raf)raf=requestAnimationFrame(tick);
 });
}
function ddMountBall(){
 let ball=document.querySelector('.dd-ball');
 if(!ddCfg().ballOn){ball?.remove();return;}
 if(ball)return;
 ball=document.createElement('button');ball.type='button';ball.className='dd-ball';ball.setAttribute('aria-label','Duang 果冻：选一张图来玩');ball.title='Duang 果冻（点一下选图，拖动可挪位置）';ball.innerHTML=ddBallHtml();
 document.body.append(ball);ddPlaceBall(ball);ddRefreshBall();ddStartBallShake();
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
  }else{
   const dlg=document.querySelector('dialog.dd-viewer[open]');
   if(dlg){dlg.close();return;}   // 弹窗开着时点悬浮球：关掉弹窗，回到选图
   ddPicking?ddExitPick():ddEnterPick();
  }
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
  +'<label class="checkbox_label"><input id="dd-ball-shake" type="checkbox"><span>手机摇晃时悬浮球也跟着晃</span></label>'
  +'<div class="dd-set-row"><label for="dd-strength">弹性</label><select id="dd-strength" class="text_pole"><option value="soft">软糯</option><option value="mid">Q弹</option><option value="bouncy">DUANG</option></select></div>'
  +'<div class="dd-set-row"><label>悬浮球图标</label></div><div id="dd-icons" class="dd-icons"></div>'
  +'<small class="dd-note">换图标建议用<b>透明底的 PNG</b>，不然悬浮球会带着一块底色。上传的是<b>原图，不压缩</b>（保存在酒馆的用户文件里），GIF / 动图 WebP 也能动。</small>'
  +'<div class="dd-set-row"><input id="dd-icon-upload" type="button" class="menu_button" value="上传图片"><input id="dd-icon-reset" type="button" class="menu_button" value="恢复默认图标"><input id="dd-icon-file" type="file" accept="image/*" hidden></div>'
  +'<div class="dd-set-row"><label for="dd-size">大小</label><input id="dd-size" type="range" min="28" max="200" step="2"><span id="dd-size-v"></span></div><div class="dd-set-row"><label for="dd-fixed">底部固定</label><input id="dd-fixed" type="range" min="0" max="70" step="2"><span id="dd-fixed-v"></span></div><small class="dd-note">摇晃手机时，图标下面这一段不动，只有上面摇，更像果冻。0 = 只固定最底边。</small><small id="dd-icon-msg"></small>'
  +'<div class="dd-set-row"><input id="dd-ball-reset" type="button" class="menu_button" value="重置悬浮球位置"></div>'
  +'<small>点悬浮球进入选图模式，再点任意一张图，就会放大到弹窗里玩果冻。范围、选区、交互（点击 / 拖动 / 摇晃）都在弹窗下方的小面板里。</small></div></div>';
 host.append(box);
 const on=box.querySelector('#dd-ball-on'),st=box.querySelector('#dd-strength');
 on.checked=!!c.ballOn;on.onchange=()=>{ddCfg().ballOn=on.checked;ddSave();ddMountBall();};
 st.value=['soft','bouncy'].includes(c.jellyStrength)?c.jellyStrength:'mid';st.onchange=()=>{ddCfg().jellyStrength=st.value;ddSave();};

 {const bs=box.querySelector('#dd-ball-shake'),m0=box.querySelector('#dd-icon-msg');bs.checked=c.ballShake!==false;bs.onchange=async()=>{ddCfg().ballShake=bs.checked;ddSave();if(bs.checked)await ddJellyEnableMotion(t=>{m0.textContent=t;});else m0.textContent='';};}
 const icons=box.querySelector('#dd-icons'),msg=box.querySelector('#dd-icon-msg');
 const paintIcons=()=>{
  const cur=ddCfg();
  const items=[{id:'default',html:DD_BALL_SVG,title:'默认'}];
  for(const n of DD_BUILTIN_ICONS)items.push({id:n,html:'<img alt="" draggable="false" src="'+ddIconUrl(n)+'">',title:n});
  for(const it of cur.ballCustoms)items.push({id:'custom:'+it.id,custom:it.id,html:'<img alt="" draggable="false" src="'+it.url+'">',title:'我上传的'});
  icons.innerHTML=items.map(it=>{
   const btn='<button type="button" class="dd-icon-opt'+(cur.ballIcon===it.id?' is-on':'')+'" data-id="'+it.id+'" title="'+it.title+'" aria-label="'+it.title+'">'+it.html+'</button>';
   return it.custom?'<span class="dd-icon-wrap">'+btn+'<button type="button" class="dd-icon-del" data-del="'+it.custom+'" title="删除这张" aria-label="删除这张">×</button></span>':btn;
  }).join('');
 };
 paintIcons();
 icons.onclick=e=>{
  const del=e.target.closest('.dd-icon-del');
  if(del){
   // 两次点击才删：第一次变红提示，第二次真的删掉
   if(del.dataset.armed!=='1'){del.dataset.armed='1';del.classList.add('is-armed');del.textContent='删?';setTimeout(()=>{if(del.isConnected){del.dataset.armed='';del.classList.remove('is-armed');del.textContent='×';}},2600);return;}
   const k=ddCfg();ddDeleteIconFile(k.ballCustoms.find(x=>x.id===del.dataset.del));k.ballCustoms=k.ballCustoms.filter(x=>x.id!==del.dataset.del);
   if(k.ballIcon==='custom:'+del.dataset.del){k.ballIcon=DD_BUILTIN_ICONS[0]||'default';k.ballIconPicked=true;}
   ddSave();paintIcons();ddRefreshBall();msg.textContent='已删除';return;
  }
  const b=e.target.closest('.dd-icon-opt');if(!b)return;{const k=ddCfg();k.ballIcon=b.dataset.id;k.ballIconPicked=true;}ddSave();paintIcons();ddRefreshBall();msg.textContent='已选择这个图标（关掉窗口就能在悬浮球上看到）';};
 const file=box.querySelector('#dd-icon-file');
 box.querySelector('#dd-icon-upload').onclick=()=>file.click();
 file.onchange=async()=>{
  const f=file.files&&file.files[0];file.value='';if(!f)return;
  try{
   const k=ddCfg();
   if(k.ballCustoms.length>=8){msg.textContent='最多存 8 张，请先删掉不用的（图标右上角的 ×）';return;}
   if(f.size>10*1024*1024){msg.textContent='图片太大了（超过 10MB），请换一张小一点的';return;}
   msg.textContent='上传中…';
   const up=await ddUploadIcon(f);const id='u'+Date.now().toString(36);
   k.ballCustoms.push({id,url:up.url,path:up.path||'',server:!!up.server});k.ballIcon='custom:'+id;k.ballIconPicked=true;ddSave();paintIcons();ddRefreshBall();msg.textContent=up.server?'已换成你上传的图片（原图，未压缩）':(up.fallback==='orig'?'酒馆文件目录用不了，已把原图存进设置里':'酒馆文件目录用不了，图片较大，已缩小到 512px 存进设置里');
  }
  catch(err){msg.textContent='上传失败：'+((err&&err.message)||err);}
 };
 box.querySelector('#dd-icon-reset').onclick=()=>{const k=ddCfg();k.ballIcon='default';k.ballIconPicked=true;ddSave();paintIcons();ddRefreshBall();msg.textContent='';};
 const sz=box.querySelector('#dd-size'),szv=box.querySelector('#dd-size-v');
 sz.value=String(Math.max(28,Math.min(200,Number(c.ballSize)||56)));szv.textContent=sz.value+'px';
 {const fx=box.querySelector('#dd-fixed'),fv=box.querySelector('#dd-fixed-v');fx.value=String(Math.max(0,Math.min(70,Number(c.ballFixed)||0)));fv.textContent=fx.value+'%';fx.oninput=()=>{fv.textContent=fx.value+'%';ddCfg().ballFixed=Number(fx.value);ddSave();ddRefreshBall();};}
 sz.oninput=()=>{szv.textContent=sz.value+'px';ddCfg().ballSize=Number(sz.value);ddSave();ddRefreshBall();};
 box.querySelector('#dd-ball-reset').onclick=()=>{const k=ddCfg();k.ballX=1;k.ballY=.62;ddSave();const b=document.querySelector('.dd-ball');if(b)ddPlaceBall(b);};
 return true;
}

// ===== 对外接口：别的插件可以直接把图片交给果冻弹窗打开 =====
// 用法：window.DuangDuang?.openImage('/backgrounds/xxx.png')，返回 Promise<boolean>（true=已打开）。
// 同源路径、data:、blob:、http(s) 地址都可以；同源图片可以用局部 / 选区 / 摇晃的全部效果。
window.DuangDuang={
 version:'0.5.0',
 ready:true,
 async openImage(src){
  try{
   const url=await ddMaterialize(String(src||'').trim());
   if(!url)return false;
   ddOpenViewer(url);return true;
  }catch(err){console.warn('[duangduang] openImage 失败',err);return false;}
 },
 close(){const d=document.querySelector('dialog.dd-viewer[open]');if(d){d.close();return true;}return false;},
 isOpen(){return !!document.querySelector('dialog.dd-viewer[open]');}
};
try{document.dispatchEvent(new CustomEvent('duangduang:ready',{detail:{version:window.DuangDuang.version}}));}catch{}

function ddInit(){
 if(window.__duangduangReady)return;window.__duangduangReady=true;
 ddMountBall();
 let tries=0;const t=setInterval(()=>{if(ddMountSettings()||++tries>40)clearInterval(t);},500);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ddInit);else ddInit();
