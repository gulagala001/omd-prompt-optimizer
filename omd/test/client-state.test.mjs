import test from 'node:test';import assert from 'node:assert/strict';
import {IntentController} from '../src/client-state.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({auto=false,optimize}={}){
  let state={draft:'原话 {{path}}',draftRev:1,attachmentIds:['image'],occurrences:[],phase:'plain'},prefs={revision:1,config:{enabled:true,permission:auto?'auto':'review'}},calls=0;
  const sent=[],apiCalls=[],listeners=new Set(),shell={state:{getSnapshot:()=>state},submit(mode){sent.push({mode,...structuredClone(state)});state={...state,draft:'',draftRev:state.draftRev+1};}};
  const original=shell.submit,store={getSnapshot:()=>prefs,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},load:async()=>{}};
  const controller=new IntentController({shell,sessionId:'s-one',store,optimize:async(...args)=>{calls++;return optimize?optimize(...args):{token:'one',packet:'理解',items:[],usage:{},warnings:[]};},api:async(path,body)=>{apiCalls.push({path,body});return {ok:true};}});
  return {shell,controller,sent,apiCalls,original,calls:()=>calls,set:patch=>{prefs={...prefs,...patch};listeners.forEach(fn=>fn());},edit:patch=>state={...state,...patch}};
}
test('review intercepts once, never edits draft/attachments, native mode is preserved',async()=>{
  const f=fixture();f.controller.activate();f.shell.submit('steer');f.shell.submit('steer');await flush();assert.equal(f.calls(),1);assert.equal(f.sent.length,0);
  assert.equal(f.controller.state.phase,'review');await f.controller.accept('edited interpretation');assert.equal(f.sent.length,1);assert.equal(f.sent[0].draft,'原话 {{path}}');assert.deepEqual(f.sent[0].attachmentIds,['image']);assert.equal(f.sent[0].mode,'steer');f.controller.dispose();assert.equal(f.shell.submit,f.original);
});
test('automatic delivery, slash bypass and skip use exactly the native send',async()=>{
  const a=fixture({auto:true});a.controller.activate();a.shell.submit();await flush();assert.equal(a.sent.length,1);a.controller.dispose();
  const f=fixture();f.controller.activate();f.edit({draft:'/compact-p'});f.shell.submit();assert.equal(f.calls(),0);assert.equal(f.sent.length,1);
  f.edit({draft:'hello'});f.shell.submit('steer');await flush();f.controller.skip();assert.equal(f.sent.length,2);assert.equal(f.sent[1].draft,'hello');assert.equal(f.sent[1].mode,'steer');f.controller.dispose();
});
test('disable and unload abort in-flight work; late return does not send',async()=>{
  let resolve,signal;const f=fixture({auto:true,optimize:(_body,s)=>{signal=s;return new Promise(r=>resolve=r);}});
  f.controller.activate();f.shell.submit();f.set({config:{enabled:false}});f.controller.dispose();assert.equal(signal.aborted,true);assert.equal(f.shell.submit,f.original);
  resolve({token:'late',packet:'late'});await flush();assert.equal(f.sent.length,0);assert.equal(f.apiCalls.some(c=>c.path==='/stage'),false);
});
test('changed attachments or text prevent a stale interpretation from sending',async()=>{
  const f=fixture();f.controller.activate();f.shell.submit();await flush();f.edit({attachmentIds:['new-image']});await f.controller.accept('test');assert.equal(f.sent.length,0);assert.match(f.controller.state.error,/变化/);f.controller.dispose();
});
test('other plugin wrappers are not overwritten during disposal',async()=>{
  const f=fixture();f.controller.activate();const ours=f.shell.submit;let other=0;const wrapper=mode=>{other++;return ours(mode);};f.shell.submit=wrapper;f.controller.dispose();assert.equal(f.shell.submit,wrapper);f.shell.submit('queue');assert.equal(other,1);assert.equal(f.sent.length,1);assert.equal(f.calls(),0);
});
