import { mkdirSync,readFileSync,writeFileSync,renameSync,existsSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveProfileName } from '../../po06/lib/wire.js';
import { IntentService,DEFAULTS,normalizeConfig } from './service.mjs';
import { SYSTEM_PROMPT } from './engine.mjs';
import { loadLlmLib } from '../../po06/lib/llm-lib.js';
export const name='omd-prompt-optimizer';
export const inject=['webServer','connection','sessions','agents','sessionProjections','llm'];
export const API='/omd-intent/api';
function json(res,status,value) {
  if(res.destroyed||res.writableEnded) return;
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));
}
async function body(req) {
  let bytes=0;const parts=[];
  for await(const part of req) {bytes+=part.length;if(bytes>300000)throw Object.assign(Error('请求过大'),{statusCode:413});parts.push(part);}
  const value=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('请求须为对象');return value;
}
export function apply(ctx) {
  const home=process.env.DSH_HOME||join(homedir(),'.dsh');
  const profile=resolveProfileName({argv:process.argv,profileExists:n=>existsSync(join(home,'profiles',n))}).name;
  const file=join(home,'profiles',profile,'omd-intent-assistant.json');
  let saved={revision:0,config:{...DEFAULTS}},startupError='';
  try {const value=JSON.parse(readFileSync(file,'utf8'));saved={revision:Number.isSafeInteger(value.revision)?value.revision:0,config:normalizeConfig(value.config)};}
  catch(error){if(error.code!=='ENOENT')startupError='配置读取失败，已保持关闭：'+error.message;}
  let messageModule=null;
  const service=new IntentService({ctx,config:saved.config,makeMessage:input=>messageModule.createUserMessage(input)});
  let closed=false;
  const persist=value=>{mkdirSync(dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,file);};
  const config=()=>({...saved,startupError,runtime:service.stats()});
  const unregister=ctx.webServer.register({kind:'prefix',path:API,async handler(req,res){
    const denied=ctx.connection.requestRejection(req);
    if(denied!==undefined){res.writeHead(denied);res.end();return;}
    const path=new URL(req.url,'http://localhost').pathname.slice(API.length);
    try {
      if(closed) return json(res,503,{error:'插件已卸载'});
      if(req.method==='GET'&&path==='/config')return json(res,200,config());
      if(req.method==='GET'&&path==='/prompt')return json(res,200,{text:saved.config.prompt||SYSTEM_PROMPT,builtin:SYSTEM_PROMPT});
      if(req.method==='GET'&&path==='/models') {
        const providers=await ctx.llm.listProviders();const problems=[];
        const rows=await Promise.all(providers.map(async p=>{try{return (await ctx.llm.listModels(p.id)).map(m=>({provider:p.id,model:m.id,label:(p.name||p.id)+' / '+(m.name||m.id)}));}catch(error){problems.push((p.name||p.id)+': '+error.message);return [];}}));
        return json(res,200,{models:rows.flat(),problems});
      }
      if(req.method!=='POST')return json(res,404,{error:'接口不存在'});
      if(req.headers['x-omd-intent']!=='1')return json(res,403,{error:'缺少同源写入标识'});
      const input=await body(req);
      if(path==='/config') {
        if(input.revision!==saved.revision)return json(res,409,{error:'设置已在其他窗口更新，请重新读取',code:'conflict',...config()});
        const next={revision:saved.revision+1,config:normalizeConfig({...saved.config,...input.patch})};
        const previous=saved;
        persist(next);
        try{service.update(next.config);}catch(error){persist(previous);service.update(previous.config);throw error;}
        saved=next;startupError='';return json(res,200,config());
      }
      const sessionId=typeof input.sessionId==='string'?input.sessionId:'';
      const session=ctx.agents.get(sessionId)?.session ?? ctx.sessions.get(sessionId);
      if(!session)return json(res,404,{error:'会话不可用，请先选择会话'});
      if(path==='/discard'){service.discard(sessionId,input);return json(res,200,{ok:true});}
      if(path==='/stage'){
        service.assertEnabled();
        if(!messageModule){const loaded=await loadLlmLib({env:process.env,argv1:process.argv[1],cwd:process.cwd()});if(!loaded.ok||typeof loaded.mod?.createUserMessage!=='function')throw Error('宿主消息接口不可用，未发送原话');messageModule=loaded.mod;}
        return json(res,200,service.stage(session,input.token,input.text));
      }
      if(path!=='/optimize')return json(res,404,{error:'接口不存在'});
      service.assertEnabled();
      const controller=new AbortController();
      const close=()=>{if(!res.writableEnded)controller.abort(Error('客户端已取消'));};
      res.on('close',close);req.on('aborted',close);
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store, no-transform','Content-Encoding':'identity','X-Content-Type-Options':'nosniff'});
      const emit=value=>{if(!res.destroyed&&!res.writableEnded&&!controller.signal.aborted)res.write(JSON.stringify(value)+'\n');};
      try {
        const result=await service.optimize(session,input,controller.signal,value=>emit({type:'progress',...value}));
        emit({type:'result',...result});
      }catch(error){emit({type:'error',error:error.message,code:error.code});}
      finally {res.off('close',close);req.off('aborted',close);if(!res.destroyed&&!res.writableEnded)res.end();}
    }catch(error){json(res,error.statusCode||400,{error:error.message,code:error.code});}
  }});
  ctx.effect(()=>()=>{closed=true;service.close();unregister();});
}
