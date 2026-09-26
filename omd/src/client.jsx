import React,{useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {createStore,IntentController,request} from './client-state.mjs';
import css from './client.css';
export const inject=['slots','sessions','conversation','locale'];
const tiers=[['light','轻度','Light'],['standard','标准','Standard'],['heavy','重度','Heavy']];
function Icon({size=16}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v12H9l-5 4V5Z M8 9h8 M8 13h5"/></svg>;}
function Toggle({checked,onChange,children,disabled}){return <label className="opi-toggle"><span>{children}</span><input type="checkbox" role="switch" checked={!!checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/></label>;}
function Styles(){useEffect(()=>{const tag=document.createElement('style');tag.dataset.plugin='omd-intent-assistant';tag.textContent=css;document.head.append(tag);return()=>tag.remove();},[]);return null;}
export function apply(ctx){
  const store=createStore(),controllers=new Set();let mounted=null,disposed=false;
  const language=()=>/^zh/i.test(ctx.locale.getLocale()?.active||'zh');
  const L=(zh,en)=>language()?zh:en;
  function useLocale(){const [,render]=useState(0);useEffect(()=>ctx.locale.subscribe(()=>render(n=>n+1)),[]);}
  function Options({compact=false}){
    useLocale();const state=useSyncExternalStore(store.subscribe,store.getSnapshot),c=state.config;
    const [models,setModels]=useState([]),[error,setError]=useState(''),[prompt,setPrompt]=useState(''),[promptReady,setPromptReady]=useState(false),[previous,setPrevious]=useState(undefined);
    const busy=state.saving;
    const modelsLoad=async()=>{try{const value=await request('/models');setModels(value.models);setError(value.problems.join('\n'));}catch(e){setError(e.message);}};
    const promptLoad=async()=>{try{const value=await request('/prompt');setPrompt(value.text);setPromptReady(true);setError('');}catch(e){setError(e.message);}};
    return <div className="opi-options">
      <div className="opi-segments" role="group" aria-label={L('优化档位','Interpretation depth')}>{tiers.map(([id,zh,en])=><button key={id} type="button" disabled={busy} aria-pressed={c.tier===id} onClick={()=>void store.set({tier:id})}>{L(zh,en)}</button>)}</div>
      <p className="opi-muted">{L({light:'少量补充，聚焦明确意图。',standard:'梳理需求、限制和必要的未决项。',heavy:'更深入地分析歧义与质量目标。'}[c.tier],{light:'Minimal additions, focused intent.',standard:'Clarify requirements, constraints and open choices.',heavy:'Explore ambiguity and quality goals in more depth.'}[c.tier])}</p>
      <div className="opi-field"><span>{L('发送方式','Delivery')}</span><select aria-label={L('优化权限','Delivery mode')} value={c.permission} disabled={busy} onChange={e=>void store.set({permission:e.target.value})}><option value="review">{L('审查后发送','Review before sending')}</option><option value="auto">{L('完成后自动发送','Send automatically')}</option></select></div>
      <details className="opi-advanced" onToggle={e=>{if(e.target===e.currentTarget&&e.currentTarget.open)void modelsLoad();}}><summary>{L('模型与上下文','Model and context')}</summary>
        <div className="opi-field"><span>{L('解释模型','Interpreter model')}</span><select aria-label={L('解释模型','Interpreter model')} value={c.model?JSON.stringify(c.model):''} disabled={busy} onChange={e=>void store.set({model:e.target.value?JSON.parse(e.target.value):null})}><option value="">{L('跟随当前会话','Follow this conversation')}</option>{c.model&&!models.some(m=>m.provider===c.model.provider&&m.model===c.model.model)&&<option value={JSON.stringify(c.model)}>{c.model.provider+' / '+c.model.model}</option>}{models.map(m=><option key={m.provider+'/'+m.model} value={JSON.stringify({provider:m.provider,model:m.model})}>{m.label}</option>)}</select></div>
        <div className="opi-field"><span>{L('会话历史','Conversation history')}</span><select aria-label={L('上下文范围','History scope')} value={c.historyMode} disabled={busy} onChange={e=>void store.set({historyMode:e.target.value})}><option value="turns">{L('最近回合','Recent turns')}</option><option value="full">{L('可读历史 · 最多 6 万字符','Available history · up to 60k characters')}</option></select></div>
        {c.historyMode==='turns'&&<div className="opi-field"><label htmlFor={compact?'opi-turns-pop':'opi-turns-settings'}>{L('读取回合','Turns to read')}</label><select id={compact?'opi-turns-pop':'opi-turns-settings'} value={c.turns} disabled={busy} onChange={e=>void store.set({turns:Number(e.target.value)})}>{Array.from({length:11},(_,n)=><option key={n} value={n}>{n===0?L('不读取','None'):n}</option>)}</select></div>}
        <Toggle checked={c.readTools} disabled={busy} onChange={readTools=>void store.set({readTools})}>{L('读取项目文件','Read project files')}</Toggle>
        <p className="opi-muted">{L('仅在当前工作目录内只读查证。不会新增 Bash 工具；所选内容会发送给你配置的模型服务。','Read-only checks within the current workspace. No extra Bash tool. Selected content is sent to your configured model provider.')}</p>
      </details>
      {!compact&&<details className="opi-advanced" onToggle={e=>{if(e.target===e.currentTarget&&e.currentTarget.open)void promptLoad();}}><summary>{L('解释层提示词','Interpreter prompt')}</summary>
        <textarea aria-label={L('解释层提示词','Interpreter prompt')} value={prompt} disabled={!promptReady||busy} onChange={e=>setPrompt(e.target.value)} rows={10}/>
        <div className="opi-actions"><button type="button" disabled={!promptReady||busy||!prompt.trim()} onClick={()=>{setPrevious(c.prompt);void store.set({prompt});}}>{L('保存提示词','Save prompt')}</button><button type="button" disabled={previous===undefined||busy} onClick={()=>{void store.set({prompt:previous}).then(promptLoad);setPrevious(undefined);}}>{L('撤销上次修改','Undo last change')}</button><button type="button" disabled={busy} onClick={()=>{setPrevious(c.prompt);void store.set({prompt:null}).then(promptLoad);}}>{L('恢复上游默认','Restore upstream default')}</button></div>
      </details>}
      {(state.error||error)&&<p className="opi-error" role="alert">{state.error||error}</p>}
    </div>;
  }
  function Settings(){
    useLocale();const state=useSyncExternalStore(store.subscribe,store.getSnapshot);
    useEffect(()=>{void store.load();},[]);
    return <section className="opi opi-settings"><Styles/><header className="opi-heading"><span className="opi-logo"><Icon size={23}/></span><div><h2>{L('需求理解','Intent assistant')}</h2><p>{L('先理解，再行动。你的原话始终保留。','Understand first. Your original words stay intact.')}</p></div><span className="opi-badge">OMD</span></header>
      <div className="opi-card"><Toggle checked={state.config.enabled} disabled={!state.ready||state.saving} onChange={enabled=>void store.set({enabled})}>{L('启用需求理解','Enable intent assistant')}</Toggle><p className="opi-muted">{state.config.enabled?L('每次发送前解释本轮需求；可随时停止或跳过。会额外调用模型。','Interpret each message before sending. Stop or skip anytime. Uses additional model calls.'):L('当前已关闭。发送、模型工具和 OMD 原有功能保持原样。','Disabled. Sending, model tools and existing OMD features stay unchanged.')}</p></div>
      {state.config.enabled?<Options/>:<div className="opi-empty"><Icon size={30}/><h3>{L('需要时再打开','Enable when needed')}</h3><p>{L('安装不等于启用。关闭时不监听发送、不运行优化、不注入随行内容。','Installation does not enable it. While disabled, no send interception, optimization or context injection runs.')}</p></div>}
      {state.error&&!state.config.enabled&&<p role="alert" className="opi-error">{state.error}</p>}
      <footer className="opi-attribution">{L('解释与校验引擎源自','Interpretation and validation by')} <a href="https://github.com/WestFox-AwA/dsh-prompt-optimizer" target="_blank" rel="noreferrer">dsh-prompt-optimizer 0.7.4</a> · {L('独立 UI 增强版','Independent UI edition')}</footer>
    </section>;
  }
  function Entry({sessionId}){
    useLocale();const binding=ctx.sessions.binding(sessionId);
    const controller=useMemo(()=>binding?new IntentController({shell:ctx.conversation.input.for(binding.ctx),sessionId,store}):null,[binding,sessionId]);
    useEffect(()=>{if(!controller)return;controllers.add(controller);controller.activate();return()=>{controller.dispose();controllers.delete(controller);};},[controller]);
    return controller?<Panel key={sessionId} controller={controller}/>:null;
  }
  function Panel({controller}){
    const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot),prefs=useSyncExternalStore(store.subscribe,store.getSnapshot);
    const [open,setOpen]=useState(false),[options,setOptions]=useState(false),[editing,setEditing]=useState(false),[packet,setPacket]=useState(''),[,tick]=useState(0);
    const anchor=useRef(null),panel=useRef(null),[position,setPosition]=useState({});
    useEffect(()=>{if(state.phase!=='idle'){setOpen(true);setOptions(false);}},[state.phase]);
    useEffect(()=>{if(state.result){setPacket(state.result.packet);setEditing(false);}},[state.result]);
    useEffect(()=>{if(state.phase!=='optimizing')return;const timer=setInterval(()=>tick(n=>n+1),1000);return()=>clearInterval(timer);},[state.phase]);
    useLayoutEffect(()=>{
      if(!open)return;
      const place=()=>{const rect=anchor.current?.getBoundingClientRect();if(!rect)return;const width=Math.min(460,innerWidth-24);setPosition({width,left:Math.max(12,Math.min(rect.right-width,innerWidth-width-12)),bottom:Math.max(12,innerHeight-rect.top+10),maxHeight:Math.max(140,Math.min(680,rect.top-22))});};place();
      const outside=e=>{if(!anchor.current?.contains(e.target)&&!panel.current?.contains(e.target)&&state.phase==='idle')setOpen(false);};
      const escape=e=>{if(e.key==='Escape'&&panel.current?.contains(document.activeElement)){e.stopPropagation();setOpen(false);anchor.current?.querySelector('button')?.focus();}};
      window.addEventListener('resize',place);window.addEventListener('scroll',place,true);document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
      return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
    },[open,state.phase]);
    const active=state.phase!=='idle',working=state.phase==='optimizing'||state.phase==='sending';
    const label=tiers.find(t=>t[0]===prefs.config.tier);
    const kindName={user_requirement:L('明确要求','Requirement'),user_decision:L('你的决定','Your decision'),quality_interpretation:L('质量方向','Quality'),observed_fact:L('已读事实','Observed fact'),implementation_option:L('实现选项','Implementation option'),unknown:L('待确定','Open choice'),proposal:L('建议','Suggestion')};
    const token=n=>Number.isFinite(n)?new Intl.NumberFormat(language()?'zh-CN':'en').format(n):'—';
    return <div className="opi opi-entry" ref={anchor}><Styles/>
      <button type="button" className="opi-chip" aria-label={L('需求理解选项','Intent assistant options')} aria-expanded={open} data-busy={working||undefined} onClick={()=>setOpen(!open)}><Icon/><span>{working?L('理解中','Interpreting'):L('需求理解','Intent')}</span><small>{label&&L(label[1],label[2])}</small></button>
      {active&&<button type="button" className="opi-stop" aria-label={L('停止需求理解','Stop interpretation')} onClick={()=>controller.cancel()}>{L('停止','Stop')}</button>}
      {open&&createPortal(<section ref={panel} style={position} className="opi opi-panel" role="dialog" aria-label={L('需求理解','Intent assistant')}>
        <header className="opi-panel-head"><span className="opi-logo"><Icon size={20}/></span><div><strong>{L('需求理解','Intent assistant')}</strong><small>{L('原话保留 · 仅本轮随行','Original words preserved · this turn only')}</small></div><button type="button" className="opi-icon-button" aria-label={L('关闭需求理解面板','Close intent panel')} onClick={()=>setOpen(false)}>×</button></header>
        <div className="opi-panel-body">
          {state.phase==='optimizing'&&<div className="opi-progress" role="status"><span className="opi-dot"/><div><strong>{L('正在梳理你的需求','Clarifying your request')}</strong><small>{L('已用','Elapsed')} {Math.floor((Date.now()-state.startedAt)/1000)}s · {L('可停止，原话不会丢失','You can stop; your draft stays intact')}</small></div><progress aria-label={L('正在优化','Interpreting')}/></div>}
          {state.reasoning&&<details className="opi-thinking"><summary>{L('查看解释模型的思考','Interpreter reasoning')}</summary><pre>{state.reasoning}</pre></details>}
          {state.result&&<><div className="opi-result-title"><strong>{L('本轮随行内容','Accompanying context')}</strong><button type="button" disabled={working} onClick={()=>setEditing(!editing)}>{editing?L('查看卡片','View cards'):L('编辑内容','Edit context')}</button></div>
            {editing?<textarea aria-label={L('随行内容','Accompanying context')} className="opi-editor" rows={10} value={packet} onChange={e=>setPacket(e.target.value)}/>:packet!==state.result.packet?<article className="opi-result-card"><small>{L('你的编辑','Your edits')}</small><pre>{packet}</pre></article>:<div className="opi-results">{state.result.items.map(item=><article className="opi-result-card" key={item.id} data-kind={item.kind}><small>{kindName[item.kind]||item.kind}{item.provenance==='machine'?' · '+L('从上下文推导','inferred from context'):''}</small><p>{item.text}</p>{item.rationale&&<span>{item.rationale}</span>}{item.candidates?.map((c,i)=><p key={i} className="opi-muted">{c.text}{c.impact?' — '+c.impact:''}</p>)}</article>)}</div>}
            {state.result.warnings.length>0&&<details className="opi-thinking"><summary>{L('部分条目未采用','Some items were excluded')}</summary>{state.result.warnings.map((w,i)=><p key={i} className="opi-muted">{w}</p>)}</details>}
            <div className="opi-usage"><span>{L('输入','Input')} <b>{token(state.result.usage.inputTokens)}</b></span><span>{L('输出','Output')} <b>{token(state.result.usage.outputTokens)}</b></span><span>{L('缓存读取','Cache read')} <b>{token(state.result.usage.cacheReadTokens)}</b></span></div>
            <p className="opi-muted">{state.result.calls} {L('次解释调用','interpreter calls')} · {L('读取历史','History read')} {token(state.result.history.chars)} {L('字符','characters')}{state.result.history.truncated?' · '+L('已标明截断范围','truncation disclosed'):''}</p>
          </>}
          {state.error&&<p className="opi-error" role="alert">{state.error}</p>}
          {state.phase==='idle'&&!options&&<div className="opi-ready"><strong>{L('照常输入，发送前自动理解','Type normally; interpret before sending')}</strong><p>{L('不改写原话，不替你执行任务。你可以审查补充内容，也可以切换为自动发送。','No rewriting or task execution. Review the extra context, or choose automatic delivery.')}</p></div>}
          {!active&&<button type="button" className="opi-options-link" aria-expanded={options} onClick={()=>setOptions(!options)}>{L('档位、模型与上下文','Depth, model and context')} <span>{options?'−':'+'}</span></button>}
          {options&&!active&&<Options compact/>}
        </div>
        <footer className="opi-panel-foot">{active?<><button type="button" disabled={state.phase==='sending'} onClick={()=>controller.skip()}>{L('跳过并发送原话','Skip and send original')}</button>{state.result&&state.phase!=='error'?<button type="button" className="opi-primary" disabled={working||!packet.trim()} onClick={()=>void controller.accept(packet)}>{state.phase==='sending'?L('发送中…','Sending…'):L('采用并发送','Accept and send')}</button>:state.phase==='error'?<button type="button" onClick={()=>{const mode=controller.pending?.mode;controller.cancel();void controller.run(mode);}}>{L('重新生成','Try again')}</button>:<button type="button" onClick={()=>controller.cancel()}>{L('停止','Stop')}</button>}</>:<><span className="opi-muted">{L('开启后会额外调用模型','Uses additional model calls')}</span><button type="button" disabled={prefs.saving} onClick={()=>void store.set({enabled:false})}>{L('关闭组件','Disable component')}</button></>}</footer>
      </section>,document.body)}
    </div>;
  }
  const sync=()=>{
    const enabled=store.getSnapshot().config.enabled===true;
    if(enabled&&!mounted&&!disposed)mounted=ctx.slots.inject('conversation.input.right',()=>ctx.slots.register({name:'conversation.input.right',id:'omd-intent-assistant',order:95},Entry));
    else if(!enabled&&mounted){mounted();mounted=null;for(const c of controllers)c.dispose();controllers.clear();}
  };
  const off=store.subscribe(sync);
  const settings=ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'omd-intent-assistant',order:19,label:()=>L('需求理解','Intent assistant')},Settings));
  ctx.effect(()=>()=>{disposed=true;off();mounted?.();settings?.();for(const c of controllers)c.dispose();controllers.clear();store.dispose();});
  void store.load();
}
