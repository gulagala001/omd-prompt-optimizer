import test from 'node:test';
import assert from 'node:assert/strict';
import {IntentService,DEFAULTS,normalizeConfig} from '../src/service.mjs';
import {interpret,cancellable,readHistory} from '../src/engine.mjs';
function fixture(config=DEFAULTS,run) {
  const hooks=new Map(),events=[],session={id:'s-one',header:{cwd:'/tmp'},snapshotEvents:()=>events,requestHeader:()=>({config:{provider:'mock',model:'mock'}})};
  const register=(name,value)=>{assert.ok(!hooks.has(name));hooks.set(name,value);return()=>hooks.delete(name);};
  const ctx={systemPrompt:{variable:register,context:value=>register(value.name,value)},sessionProjections:{stateOf:()=>null},get:()=>null,llm:{},on:(name,fn)=>register(name,fn)};
  const service=new IntentService({ctx,config,run:run||(async()=>({packet:'本轮需求：只改颜色',items:[],usage:{},calls:1}))});
  const append=(text,id)=>events.push({seq:id,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text}]}});
  return {hooks,session,service,append};
}
test('disabled installation has no prompt hooks, tools, timers or model calls',async()=>{
  let calls=0;const f=fixture(DEFAULTS,async()=>calls++);
  assert.deepEqual(f.service.stats(),{hooks:0,requests:0,prepared:0,staged:0});
  await assert.rejects(f.service.optimize(f.session,{text:'hello',requestId:'r-one'}),/已关闭/);
  assert.equal(calls,0);assert.equal(f.hooks.size,0);f.service.close();
});
test('native pre-step appends one separate packet and keeps original messages intact',async()=>{
  const f=fixture();f.append('earlier',1);f.service.update({...DEFAULTS,enabled:true});assert.equal(f.hooks.size,1);
  const result=await f.service.optimize(f.session,{text:'只改颜色',requestId:'r-one'});
  f.service.stage(f.session,result.token,'原样 {{literal}}');
  const raw={id:'native-message',source:{kind:'user'},content:[{type:'text',text:'只改颜色'},{type:'image',url:'unchanged'}]};
  const decision={kind:'enter',messages:[raw]};
  const output=await f.hooks.get('agent/pre-step')({agent:{session:f.session},signal:new AbortController().signal},async()=>decision);
  assert.equal(output.messages[0],raw);assert.equal(output.messages.length,2);assert.match(output.messages[1].content[0].text,/原样 \{\{literal\}\}/);
  assert.equal(f.service.staged.size,0);assert.equal(f.service.accompany(f.session,[raw]).length,1,'never repeat a packet');
  f.service.update(DEFAULTS);assert.equal(f.hooks.size,0);assert.deepEqual(f.service.stats(),{hooks:0,requests:0,prepared:0,staged:0});
});
test('disable cancels work and rejects results from providers ignoring cancellation',async()=>{
  let resolve,signal;const f=fixture({...DEFAULTS,enabled:true},args=>{signal=args.signal;return new Promise(r=>resolve=r);});
  const pending=f.service.optimize(f.session,{text:'hello',requestId:'r-one'});
  assert.equal(f.service.requests.size,1);f.service.update(DEFAULTS);assert.equal(signal.aborted,true);assert.equal(f.hooks.size,0);
  resolve({packet:'stale'});await assert.rejects(pending);assert.equal(f.service.prepared.size,0);
});
test('tokens cannot cross sessions, survive disable, or target a changed conversation',async()=>{
  const f=fixture({...DEFAULTS,enabled:true});const result=await f.service.optimize(f.session,{text:'hi',requestId:'r-one'});
  assert.throws(()=>f.service.stage({...f.session,id:'other'},result.token,'text'),/过期/);
  f.service.update(DEFAULTS);f.service.update({...DEFAULTS,enabled:true});assert.throws(()=>f.service.stage(f.session,result.token,'text'),/过期/);
  const fresh=await f.service.optimize(f.session,{text:'hi',requestId:'r-two'});f.append('different',2);
  assert.throws(()=>f.service.stage(f.session,fresh.token,'text'),/变化/);f.service.close();
});
test('configuration is validated without silently enabling on malformed values',()=>{
  assert.equal(normalizeConfig().enabled,false);assert.equal(normalizeConfig({enabled:true}).readTools,false);
  assert.throws(()=>normalizeConfig({enabled:'false'}));assert.throws(()=>normalizeConfig({turns:99}));assert.throws(()=>normalizeConfig({tier:'constructor'}));
  assert.equal(Object.hasOwn(normalizeConfig({bash:true}),'bash'),false);
});
test('original upstream interpretation, quotes, reducer and compiler run end to end',async()=>{
  const f=fixture(),requests=[];const llm={async *stream(options){requests.push(options);yield {type:'reasoning-delta',text:'理解原意'};yield {type:'text-delta',text:JSON.stringify({ops:[{op:'add_item',item:{id:'req-one',kind:'user_requirement',scope:'turn',text:'只改颜色',quote:'只改颜色',sourceRefs:[{kind:'human',sessionId:'s-one',messageId:'r-one'}]}}]})};yield {type:'usage',usage:{inputTokens:120,outputTokens:30,cacheReadTokens:80}};yield {type:'finish',finish:{kind:'stop'}};}};
  const progress=[];const result=await interpret({llm,route:{provider:'mock',model:'mock'},session:f.session,text:'只改颜色',requestId:'r-one',config:DEFAULTS,signal:new AbortController().signal,onProgress:value=>progress.push(value)});
  assert.match(result.packet,/只改颜色/);assert.equal(result.items.length,1);assert.equal(result.calls,1);assert.deepEqual(result.usage,{inputTokens:120,outputTokens:30,cacheReadTokens:80});assert.equal(progress.length,1);assert.deepEqual(requests[0].tools,[]);
});
test('history excludes plugin messages and zero turns does not read events',()=>{
  assert.equal(readHistory({snapshotEvents:()=>{throw Error('must not read');}},{...DEFAULTS,turns:0}).text,'');
  const f=fixture();f.append('用户要求',1);f.session.snapshotEvents().push({type:'user/message',data:{source:{kind:'plugin:other'},content:[{type:'text',text:'DO NOT REPLAY'}]}});
  const history=readHistory(f.session,DEFAULTS);assert.match(history.text,/用户要求/);assert.doesNotMatch(history.text,/DO NOT REPLAY/);
});
test('uncooperative provider iteration is promptly abortable',async()=>{
  const signal=new AbortController();const iterator=cancellable({[Symbol.asyncIterator](){return {next:()=>new Promise(()=>{}),return:()=>Promise.resolve({done:true})};}},signal.signal);
  const next=iterator.next();signal.abort(Error('test cancellation'));await assert.rejects(next,/test cancellation/);
});

test('queued inputs and other sessions cannot consume each other packets',async()=>{
  const f=fixture({...DEFAULTS,enabled:true});
  for(const raw of ['first','second']){const result=await f.service.optimize(f.session,{text:raw,requestId:'r-'+raw});f.service.stage(f.session,result.token,'packet '+raw);}
  const messages=['first','second'].map((text,i)=>({id:'m-'+i,source:{kind:'user'},content:[{type:'text',text}]}));
  assert.equal(f.service.accompany({id:'other'},messages),messages);
  const output=f.service.accompany(f.session,messages);assert.equal(output.length,4);assert.equal(output[0],messages[0]);assert.equal(output[2],messages[1]);assert.equal(f.service.staged.size,0);f.service.close();
});
