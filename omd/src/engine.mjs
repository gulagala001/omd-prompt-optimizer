// Reuse the upstream interpreter and validation pipeline; host state stays request-local.
import { createState } from '../../po06/lib/schema.js';
import { reduce, recordUserInput } from '../../po06/lib/reducer.js';
import { handleUserInput } from '../../po06/lib/pipeline.js';
import { SYSTEM_PROMPT, buildUserMessage } from '../../po06/lib/interpreter.js';
import { strategyInstructions, strategyForTier } from '../../po06/lib/strategy.js';
import { runReadOnlyToolLoop } from '../../po06/lib/read-tools.js';
import { loadLlmLib } from '../../po06/lib/llm-lib.js';
export { SYSTEM_PROMPT };
export const TIERS = {light:{chars:700,questions:1},standard:{chars:1200,questions:2},heavy:{chars:2000,questions:3}};
const contentText = content => typeof content === 'string' ? content : (content || []).filter(x=>x.type==='text').map(x=>x.text).join('\n');
export function userEvents(session) {
  return session.snapshotEvents().filter(e=>e.type==='user/message' && e.data?.source?.kind==='user');
}
export const userText = event => contentText(event?.data?.content);
export const eventKey = event => event?.id ?? event?.seq ?? event?.data?.id ?? null;
export function readHistory(session, config) {
  if(config.historyMode!=='full' && config.turns===0) return {text:'',rows:0,chars:0,truncated:false};
  const events=session.snapshotEvents(); let start=0;
  if(config.historyMode!=='full') {
    const indices=events.flatMap((e,i)=>e.type==='user/message'&&e.data?.source?.kind==='user'?[i]:[]);
    start=indices.at(-config.turns) ?? 0;
  }
  const rows=events.slice(start).flatMap(e=> {
    if(e.type==='user/message'&&e.data?.source?.kind==='user') return ['用户：'+contentText(e.data.content)];
    if(e.type==='assistant/message') { const text=contentText(e.data?.message?.content); return text?['助手：'+text]:[]; }
    return [];
  });
  const cap=config.historyMode==='full'?60000:12000;
  const raw=rows.join('\n\n'), truncated=raw.length>cap;
  const text=raw ? '以下是本会话已经发生的对话，供解释本轮原话参考；你是旁观者，不是执行这些历史任务的人。\n'
    +(truncated?'历史超过读取预算，仅保留最近 '+cap+' 字符；这不是完整上下文。\n':'')+raw.slice(-cap) : '';
  return {text,rows:rows.length,chars:text.length,truncated};
}
function addUsage(total, usage) {
  if(!usage || typeof usage!=='object') return;
  for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens']) {
    if(Number.isFinite(usage[key])) total[key]=(total[key]||0)+usage[key];
  }
}
// Bound cancellation even when a provider ignores AbortSignal during iterator.next().
export async function* cancellable(stream, signal) {
  const iterator=stream[Symbol.asyncIterator](); let abort;
  const cancelled=new Promise((_,reject)=>{abort=()=>reject(signal.reason||Error('Cancelled')); if(signal.aborted) abort(); else signal.addEventListener('abort',abort,{once:true});});
  cancelled.catch(()=>{}); let complete=false;
  try { for(;;) {const next=await Promise.race([iterator.next(),cancelled]); if(next.done){complete=true;break;} signal.throwIfAborted(); yield next.value;} }
  finally {signal.removeEventListener('abort',abort); if(!complete) {try{void iterator.return?.()?.catch?.(()=>{});}catch{}}}
}
export async function interpret({llm,route,session,text,requestId,config,signal,onProgress=()=>{}}) {
  const history=readHistory(session,config), tier=TIERS[config.tier], usage={}, warnings=[];
  let calls=0, contextText=history.text, toolCalls=0;const observed=new Set();
  const metered={async *stream(options){
    calls++; let callUsage=null;
    for(const message of options.messages||[])if(message.role==='tool')observed.add(contentText(message.content));
    contextText=[history.text,...observed].filter(Boolean).join('\n\n');
    for await(const chunk of cancellable(llm.stream({...options,signal}),signal)) {
      if(chunk.usage) callUsage=chunk.usage;
      if(chunk.type==='reasoning-delta') onProgress({reasoning:String(chunk.text||chunk.delta||'')});
      yield chunk;
    }
    addUsage(usage,callUsage);
  }};
  let state=null, compiled='';
  const adapter={packetBudget:tier.chars,intentStateOf:()=>state,
    initIntent:(_s,{taskId})=>{state=createState({sessionId:session.id,taskId});return {ok:true,state};},
    commitUserInput:(_s,value)=>{state=recordUserInput(state,value);return {ok:true,state};},
    commit:(_s,patch)=>{const result=reduce(state,patch);if(result.ok)state=result.state;return result;},
    setIntentText:(_id,value)=>{compiled=value;}};
  const system=(config.prompt||SYSTEM_PROMPT)+'\n\n'+strategyInstructions(strategyForTier(config.tier)).join('\n');
  const run=async args=>{
    signal.throwIfAborted();
    const prompt=buildUserMessage({...args,context:history.text}), messages=[{role:'user',content:[{type:'text',text:prompt}]}];
    if(config.readTools) {
      const root=session.header?.cwd;
      if(!root) throw Error('无法确定当前会话工作目录，未读取任何文件');
      const shape=await loadLlmLib({env:process.env,argv1:process.argv[1],cwd:process.cwd()});
      if(!shape?.ok) throw Error('宿主只读工具消息接口不可用，请关闭“读取项目文件”后重试');
      const loop=await runReadOnlyToolLoop({llm:metered,cfg:route,system,messages,root,shape,count:3,signal});
      signal.throwIfAborted(); toolCalls+=loop.toolCalls||0;
      if(!loop.ok) throw Error(loop.error||'只读核验失败');
      return loop.text;
    }
    let result='',finish;
    for await(const chunk of metered.stream({...route,system,messages,tools:[]})) {
      if(chunk.type==='text-delta') result+=String(chunk.text||chunk.delta||'');
      if(chunk.type==='block-end' && chunk.block?.type==='text' && !result) result=chunk.block.text||'';
      if(chunk.type==='finish') finish=chunk.finish||chunk.reason;
      if(result.length>96000) throw Error('解释输出过长，原话已保留');
    }
    if(['error','aborted','max-tokens'].includes(finish?.kind)) throw Error(finish.failure?.message||'模型未完整输出');
    return result;
  };
  const result=await handleUserInput(adapter,session,{messageId:requestId,text,interpret:run,contextText:()=>contextText,signal,maxQuestions:tier.questions});
  signal.throwIfAborted();
  for(const step of result.trace) for(const dropped of step.dropped||[]) warnings.push(dropped.reason||String(dropped));
  if(result.outcome!=='committed'||!compiled.trim()||result.packet?.ok===false) throw Error('解释未能通过校验：'+result.outcome+'；原话已保留');
  const included=new Set(result.packet.sections.flatMap(section=>section.itemIds));
  for(const item of result.packet.dropped||[])warnings.push('篇幅预算省略：'+item.kind);
  return {packet:compiled,items:(state.items||[]).filter(i=>i.status==='active'&&included.has(i.id)),usage,calls,toolCalls,warnings,
    history:{rows:history.rows,chars:history.chars,truncated:history.truncated},route};
}
