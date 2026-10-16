const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture() {
  let now = 0, serial = 0;
  const timers = new Map(), messages = [], native = [];
  let appearance = { selectedId:'system-glass-blurred', revision:0 };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.bounds = options; this.visible = false; this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {setWindowOpenHandler(){}, isDestroyed:()=>this.destroyed,
        send:(channel,data)=>messages.push({channel,data,at:now})});
    }
    isDestroyed(){return this.destroyed;} isVisible(){return this.visible;}
    loadFile(){return Promise.resolve();} setAlwaysOnTop(){} setVisibleOnAllWorkspaces(){}
    setFocusable(){} setBounds(bounds){this.bounds=bounds;} getContentBounds(){return this.bounds;}
    showInactive(){this.visible=true;} show(){this.visible=true;} focus(){}
    hide(){this.visible=false;this.emit('hide');}
    destroy(){this.destroyed=true;this.emit('closed');}
  }
  const module = {exports:{}};
  const filename=path.join(__dirname,'../island-status-window.js');
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{
    module,__dirname:path.dirname(filename),require:createRequire(filename),
    setTimeout:(callback,delay)=>{const id=++serial;timers.set(id,{callback,at:now+delay});return id;},
    clearTimeout:id=>timers.delete(id),setInterval:()=>({unref(){}}),clearInterval(){},
  });
  const controller=module.exports.createIslandStatusWindow({BrowserWindow:Window,
    getBounds:compact=>({x:0,y:0,width:compact?360:348,height:compact?34:120}),isAllowed:()=>true,
    getAppearance:()=>appearance,appearanceNative:{clear:()=>native.push('clear'),applyPair:()=>{native.push('pair');return true;}}});
  async function advance(ms){
    const end=now+ms;
    for (;;) {
      const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].callback();
      await Promise.resolve(); await Promise.resolve();
    }
    now=end;
  }
  return {controller,timers,messages,native,advance,setAppearance:value=>{appearance=value;controller.syncAppearance(value);}};
}

test('系统胶囊切主题和重复同步不重置三秒停留，收起完成后才隐藏', async()=>{
  const f=fixture(), c=f.controller;
  await c.showFeedback({kind:'headphones',title:'声音输出已切换',detail:'测试耳机'});
  assert.equal(c.getWindow().isVisible(),true);
  const deadline=[...f.timers.values()][0].at;
  assert.equal(deadline,3420);
  await f.advance(1000);
  f.setAppearance({selectedId:'classic',revision:1});
  await c.sync();
  assert.equal([...f.timers.values()][0].at,deadline);
  await f.advance(2419);assert.equal(c.getCurrent().kind,'headphones');
  await f.advance(1);assert.equal(c.getCurrent(),null);
  assert.equal(c.getWindow().isVisible(),true,'留下完整收起动画时间');
  await f.advance(320);assert.equal(c.getWindow().isVisible(),false);
  assert.ok(f.native.includes('clear'));
  c.destroy();
});

test('旧几何不能恢复或清除新提醒；紧凑录音不创建双玻璃区', async()=>{
  const f=fixture(),c=f.controller;
  await c.showFeedback({kind:'headphones',title:'耳机'});
  const first=f.messages.findLast(item=>item.channel==='island:status-show').data.eventId;
  await c.showFeedback({kind:'battery',title:'正在充电',value:'65%'});
  const second=f.messages.findLast(item=>item.channel==='island:status-show').data.eventId;
  assert.notEqual(first,second);
  const surface={x:16,y:50,width:254,height:54,radii:[27,27,27,27],opacity:1};
  const payload={eventId:second,viewport:{width:348,height:120},surfaces:[surface,{...surface,x:278,width:54}]};
  c.updateSurface(payload);assert.equal(f.native.at(-1),'pair');
  const count=f.native.length;
  c.updateSurface({...payload,eventId:first,surfaces:null});assert.equal(f.native.length,count);
  await c.setPersistent({kind:'recording',compact:true,title:'正在录音',value:'00:10'});
  const dismissed=c.dismiss();
  await f.advance(100); await c.sync();
  assert.equal(c.getCurrent(),null,'每秒同步不能提前恢复紧凑状态');
  assert.equal(c.getWindow().getContentBounds().height,120);
  await f.advance(220); await dismissed;
  c.updateSurface(payload);assert.notEqual(f.native.at(-1),'pair');
  assert.equal(c.getCurrent().kind,'recording');
  c.destroy();
});
