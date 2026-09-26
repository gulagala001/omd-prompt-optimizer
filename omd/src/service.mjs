import { randomUUID } from 'node:crypto';
import { interpret, TIERS, userEvents, eventKey } from './engine.mjs';
export const DEFAULTS=Object.freeze({enabled:false,tier:'standard',permission:'review',historyMode:'turns',turns:6,readTools:false,model:null,prompt:null});
export function normalizeConfig(input={}) {
  const c={...DEFAULTS,...input};
  if(typeof c.enabled!=='boolean'||typeof c.readTools!=='boolean'||!Object.hasOwn(TIERS,c.tier)||!['review','auto'].includes(c.permission)||!['turns','full'].includes(c.historyMode)||!Number.isInteger(c.turns)||c.turns<0||c.turns>10) throw Error('设置格式无效');
  if(c.model!==null&&(!c.model||typeof c.model.provider!=='string'||!c.model.provider||typeof c.model.model!=='string'||!c.model.model)) throw Error('模型选择无效');
  if(c.prompt!==null&&(typeof c.prompt!=='string'||!c.prompt.trim()||c.prompt.length>30000)) throw Error('解释层提示词为空或过长');
  return Object.fromEntries(Object.keys(DEFAULTS).map(key=>[key,c[key]]));
}
export class IntentService {
  constructor({ctx,config=DEFAULTS,run=interpret,now=Date.now,makeMessage=input=>({id:randomUUID(),role:"user",...input})}) {
    Object.assign(this,{ctx,config:normalizeConfig(config),run,now,makeMessage});
    this.requests=new Map();this.prepared=new Map();this.staged=new Map();this.disposers=[];this.epoch=0;this.closed=false;this.sync();
  }
  sync() {
    if(!this.config.enabled) {this.release();return;}
    if(this.disposers.length) return;
    this.disposers.push(this.ctx.on('agent/pre-step',async ({agent,signal},next)=>{
      const decision=await next();
      if(decision.kind!=='enter'||signal?.aborted||!this.config.enabled)return decision;
      const messages=this.accompany(agent.session,decision.messages);
      return messages===decision.messages?decision:{...decision,messages};
    },{global:true}));
  }

  update(config) {this.release();this.config=normalizeConfig(config);this.sync();}
  release() {
    this.epoch++;
    for(const request of this.requests.values()) {clearTimeout(request.timer);request.controller.abort(Error('需求理解已停用'));}
    this.requests.clear();this.prepared.clear();this.staged.clear();
    for(const dispose of this.disposers.splice(0).reverse()) dispose();
  }
  close() {this.closed=true;this.release();}
  assertEnabled() {if(this.closed||!this.config.enabled) throw Object.assign(Error('需求理解已关闭'),{statusCode:409,code:'disabled'});}
  stats() {return {hooks:this.disposers.length,requests:this.requests.size,prepared:this.prepared.size,staged:this.staged.size};}
  async optimize(session,input,signal,onProgress) {
    this.assertEnabled();
    if(typeof input.text!=='string'||!input.text.trim()||input.text.length>64000||typeof input.requestId!=='string'||input.requestId.length>100) throw Error('原话或请求标识无效');
    if(this.requests.has(session.id)) throw Error('此会话已有优化请求，请先停止');
    if(this.requests.size>=8) throw Error('并发优化请求过多');
    const route=this.config.model || this.ctx.sessionProjections.stateOf(session,'modelSelection')?.pending || session.requestHeader()?.config || this.ctx.get('agentDefaultModel')?.currentSelection();
    if(!route?.provider||!route?.model) throw Error('请先选择当前会话的模型');
    const controller=new AbortController(),epoch=this.epoch;
    const timer=setTimeout(()=>controller.abort(Error('优化超时，草稿已保留')),120000);timer.unref?.();
    const ticket={controller,timer,requestId:input.requestId};this.requests.set(session.id,ticket);
    const combined=AbortSignal.any([...(signal?[signal]:[]),controller.signal]);
    const baseline=eventKey(userEvents(session).at(-1));
    try {
      const result=await this.run({llm:this.ctx.llm,route:{provider:route.provider,model:route.model},session,text:input.text,requestId:input.requestId,config:this.config,signal:combined,onProgress});
      combined.throwIfAborted();this.assertEnabled();if(epoch!==this.epoch) throw Error('设置已变化，旧结果已丢弃');
      if(eventKey(userEvents(session).at(-1))!==baseline) throw Error('会话已经收到新消息，旧解释未提交');
      for(const [key,value] of this.prepared) if(value.sessionId===session.id||this.now()-value.createdAt>300000) this.prepared.delete(key);
      if(this.prepared.size>=100) this.prepared.delete(this.prepared.keys().next().value);
      const token=randomUUID();this.prepared.set(token,{sessionId:session.id,requestId:input.requestId,raw:input.text,baseline,packet:result.packet,epoch,createdAt:this.now()});
      return {...result,token};
    } finally {clearTimeout(timer);if(this.requests.get(session.id)===ticket)this.requests.delete(session.id);}
  }
  stage(session,token,text) {
    this.assertEnabled();const value=this.prepared.get(token);
    if(!value||value.sessionId!==session.id||value.epoch!==this.epoch||this.now()-value.createdAt>300000) throw Error('解释结果已过期，请重新生成');
    if(eventKey(userEvents(session).at(-1))!==value.baseline) throw Error('会话已变化，未注入旧结果');
    if(typeof text!=='string'||!text.trim()||text.length>16000) throw Error('随行内容为空或过长');
    const message=this.makeMessage({source:{kind:'omd-intent-assistant',form:'notice',summary:'本轮需求理解'},content:[{type:'text',text:'【本轮需求理解】以下内容仅辅助理解紧邻的用户消息，不是用户原话，后续回合不自动继承。\n\n'+text}]});
    for(const [key,item] of this.staged)if(this.now()-item.createdAt>300000)this.staged.delete(key);
    if(this.staged.size>=100)throw Error('待接收的解释过多，请稍后重试');
    this.prepared.delete(token);this.staged.set(token,{...value,message,token});return {ok:true};
  }
  discard(sessionId,{requestId,token}={}) {
    const request=this.requests.get(sessionId);
    if(request&&request.requestId===requestId) request.controller.abort(Error('优化已取消'));
    for(const [key,value] of this.prepared) if(value.sessionId===sessionId&&(key===token||value.requestId===requestId)) this.prepared.delete(key);
    for(const [key,value] of this.staged)if(value.sessionId===sessionId&&(key===token||value.requestId===requestId))this.staged.delete(key);
  }
  accompany(session,messages) {
    if(!this.config.enabled||this.closed)return messages;
    const pending=[...this.staged.values()].filter(value=>value.sessionId===session.id);
    if(!pending.length)return messages;
    let changed=false;
    const output=messages.flatMap(message=>{
      if(message.source?.kind!=='user')return [message];
      const text=(message.content||[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
      while(pending.length){
        const value=pending.shift();this.staged.delete(value.token);
        if(value.epoch!==this.epoch||this.now()-value.createdAt>300000)continue;
        if(text.trim()!==value.raw.trim())continue;
        changed=true;return [message,value.message];
      }
      return [message];
    });
    return changed?output:messages;
  }
}
