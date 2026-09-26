export const API='omd-intent/api';
export async function request(path,body,signal) {
  const response=await fetch(API+path,{headers:{'Content-Type':'application/json','x-omd-intent':'1'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),signal});
  const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error||'HTTP '+response.status),{code:value.code,value});return value;
}
export async function optimizeRequest(body,signal,progress) {
  const response=await fetch(API+'/optimize',{method:'POST',headers:{'Content-Type':'application/json','x-omd-intent':'1'},body:JSON.stringify(body),signal});
  if(!response.ok){const value=await response.json();throw Object.assign(Error(value.error||'HTTP '+response.status),{code:value.code});}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',result,total=0;
  try {
    for(;;){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>1000000)throw Error('优化响应过大');buffer+=decoder.decode(part.value,{stream:true});
      let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;const value=JSON.parse(line);
        if(value.type==='error')throw Object.assign(Error(value.error),{code:value.code});
        if(value.type==='progress')progress(value);if(value.type==='result')result=value;}}
    if(!result)throw Error('优化响应中断，草稿已保留');return result;
  }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createStore({api=request}={}) {
  let state={revision:0,config:{enabled:false},ready:false,error:'',saving:false},disposed=false;
  const listeners=new Set();let channel=null;
  const publish=patch=>{state={...state,...patch};listeners.forEach(fn=>fn());};
  const syncChannel=()=>{
    if(state.config.enabled&&!channel&&typeof BroadcastChannel==='function') {
      channel=new BroadcastChannel('omd-intent-settings');
      channel.onmessage=e=>{if(e.data?.type==='config'&&e.data.value?.revision>state.revision)apply(e.data.value);};
    } else if(!state.config.enabled&&channel){channel.close();channel=null;}
  };
  const apply=value=>{if(disposed)return;publish({...value,ready:true,error:value.startupError||'',saving:false});syncChannel();};
  return {
    getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
    async load(){try{const value=await api('/config');if(value.revision>=state.revision)apply(value);}catch(error){if(!disposed)publish({error:error.message,ready:true});}},
    async set(patch){
      if(state.saving)return;const previous=state;publish({saving:true,error:''});
      try{const value=await api('/config',{revision:previous.revision,patch});channel?.postMessage({type:'config',value});apply(value);}
      catch(error){if(error.code==='conflict'){apply(error.value);publish({error:error.message});}else publish({saving:false,error:error.message});}
    },
    dispose(){disposed=true;channel?.close();channel=null;listeners.clear();},
  };
}
const capture=shell=>{const s=shell.state.getSnapshot();return {text:s.draft,revision:s.draftRev,attachments:JSON.stringify(s.attachmentIds),occurrences:JSON.stringify(s.occurrences)};};
const unchanged=(shell,before)=>{const next=capture(shell);return shell.state.getSnapshot().phase==='plain'&&Object.keys(before).every(k=>before[k]===next[k]);};
export class IntentController {
  constructor({shell,sessionId,store,optimize=optimizeRequest,api=request}){
    Object.assign(this,{shell,sessionId,store,optimize,api});this.listeners=new Set();this.pending=null;this.disposed=false;
    this.state={phase:'idle',error:'',reasoning:'',result:null,startedAt:0};
    this.subscribe=fn=>{this.listeners.add(fn);return()=>this.listeners.delete(fn);};this.getSnapshot=()=>this.state;
  }
  publish(patch){this.state={...this.state,...patch};this.listeners.forEach(fn=>fn());}
  activate(){
    if(this.restore||this.disposed)return;const {shell}=this,owner=this,original=shell.submit,descriptor=Object.getOwnPropertyDescriptor(shell,'submit');
    if(typeof original!=='function')throw Error('当前 DSH 不支持需求理解输入入口');
    function submit(mode='queue'){
      const prefs=owner.store.getSnapshot(),input=shell.state.getSnapshot();
      if(!owner.restore||owner.disposed||!prefs.config.enabled||prefs.saving||input.phase!=='plain'||!input.draft.trim()||/^\s*\//.test(input.draft))return original.call(shell,mode);
      if(!owner.pending)void owner.run(mode);
    }
    shell.submit=submit;this.nativeSubmit=mode=>original.call(shell,mode);
    const unwatch=this.store.subscribe(()=>{const prefs=this.store.getSnapshot();if(!prefs.config.enabled||prefs.saving||this.pending&&prefs.revision!==this.pending.revision)this.cancel();});
    this.restore=()=>{this.cancel();unwatch();if(shell.submit===submit){if(descriptor)Object.defineProperty(shell,'submit',descriptor);else delete shell.submit;}this.restore=null;};
  }
  async run(mode='queue'){
    if(this.pending||this.disposed)return;const prefs=this.store.getSnapshot();if(!prefs.config.enabled||prefs.saving)return;
    const before=capture(this.shell),ticket={requestId:crypto.randomUUID(),controller:new AbortController(),before,mode,revision:prefs.revision};
    this.pending=ticket;this.publish({phase:'optimizing',error:'',reasoning:'',result:null,startedAt:Date.now()});
    try{
      const result=await this.optimize({sessionId:this.sessionId,requestId:ticket.requestId,text:before.text},ticket.controller.signal,value=>{
        if(this.pending===ticket&&!ticket.controller.signal.aborted)this.publish({reasoning:(this.state.reasoning+String(value.reasoning||'')).slice(-64000)});
      });
      if(!this.valid(ticket))return;ticket.token=result.token;
      this.publish({phase:'review',result});
      if(prefs.config.permission==='auto')await this.accept(result.packet);
    }catch(error){if(this.pending===ticket&&!ticket.controller.signal.aborted){this.publish({phase:'error',error:error.message});if(error.code==='disabled'){this.cancel();void this.store.load();}}}
  }
  valid(ticket){return this.pending===ticket&&!ticket.controller.signal.aborted&&!this.disposed&&this.store.getSnapshot().config.enabled&&this.store.getSnapshot().revision===ticket.revision;}
  async accept(text){
    const ticket=this.pending;if(!ticket?.token||!this.valid(ticket)||this.state.phase==='sending')return;
    if(!unchanged(this.shell,ticket.before)){this.publish({phase:'error',error:'草稿或附件已变化，请重新生成；没有自动发送。'});return;}
    this.publish({phase:'sending',error:''});
    try{
      await this.api('/stage',{sessionId:this.sessionId,token:ticket.token,text},ticket.controller.signal);
      if(!this.valid(ticket)||!unchanged(this.shell,ticket.before)){this.cancel();return;}
      this.pending=null;this.publish({phase:'idle',result:null,reasoning:'',error:''});
      await this.nativeSubmit(ticket.mode);
    }catch(error){
      void this.api('/discard',{sessionId:this.sessionId,token:ticket.token,requestId:ticket.requestId}).catch(()=>{});
      if(!ticket.controller.signal.aborted)this.publish({phase:'error',error:error.message});
    }
  }
  cancel(){
    const ticket=this.pending;this.pending=null;
    if(ticket){ticket.controller.abort();void this.api('/discard',{sessionId:this.sessionId,token:ticket.token,requestId:ticket.requestId}).catch(()=>{});}
    this.publish({phase:'idle',result:null,reasoning:'',error:''});
  }
  skip(){const ticket=this.pending;if(!ticket)return;const safe=unchanged(this.shell,ticket.before);this.cancel();if(safe)this.nativeSubmit(ticket.mode);else this.publish({phase:'error',error:'草稿或附件已变化，未发送。请直接点击宿主发送。'});}
  dispose(){this.restore?.();this.disposed=true;this.listeners.clear();}
}
