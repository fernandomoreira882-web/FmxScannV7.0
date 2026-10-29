'use strict';
// FMX WEB PUSH 1: receptor isolado. Não lê, altera ou confirma OS.
// O registro FCM usa este ServiceWorkerRegistration explicitamente.
// Tratamos PushEvent diretamente para validar conta/preferências ANTES de exibir.
const FMX_SCOPE=new URL('./',self.location.href).href;
const FMX_CATEGORIES=['OS_ATRIBUIDA','PLANO_ATRIBUIDO','PRIORIDADE','OS_FINALIZADA','NOVA_SOLICITACAO'];
const FMX_VERSION=1,FMX_DB='fmx-web-push:'+FMX_SCOPE;
let dbFlight=null,serial=Promise.resolve();
function openDB(){if(dbFlight)return dbFlight;dbFlight=new Promise((resolve,reject)=>{const r=indexedDB.open(FMX_DB,1);r.onupgradeneeded=()=>{r.result.createObjectStore('kv');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});return dbFlight;}
function edit(fn){const job=serial.catch(()=>{}).then(async()=>{const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction('kv','readwrite'),store=tx.objectStore('kv'),r=store.get('state');let result;r.onsuccess=()=>{try{const state=r.result||{binding:null,revision:0,inboxes:{},seen:[]};result=fn(state);store.put(state,'state');}catch(e){tx.abort();reject(e);}};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Armazenamento de notificações indisponível.'));});});serial=job;return job;}
const uidOK=v=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
const trim=(v,max=240)=>typeof v==='string'?v.slice(0,max):'';
const ownURL=value=>{try{const u=new URL(value);return u.origin===new URL(FMX_SCOPE).origin&&u.href.startsWith(FMX_SCOPE);}catch{return false;}};
const categories=v=>Object.fromEntries(FMX_CATEGORIES.map(k=>[k,v?.[k]===true]));
async function closeAlerts(){for(const n of await self.registration.getNotifications())if(String(n.tag||'').startsWith('fmx:'))n.close();}
async function stateFor(uid){return edit(s=>({version:FMX_VERSION,uid:s.binding?.uid||null,enabled:!!s.binding?.enabled,categories:s.binding?.categories||categories(),revision:s.revision,inbox:uidOK(uid)&&s.binding?.uid===uid?s.inboxes['u:'+uid]||[]:[]}));}
async function command(m){
 if(m.type==='FMX_PUSH_STATE')return stateFor(m.uid);
 if(m.type==='FMX_PUSH_BIND'){
  if(!uidOK(m.uid))throw Error('Conta inválida para notificações.');
  const result=await edit(s=>{if(s.binding?.uid&&s.binding.uid!==m.uid&&!m.takeover)throw Error('Este navegador está vinculado a outra conta. Toque em HABILITAR para trocar.');s.revision++;s.binding={uid:m.uid,enabled:true,categories:categories(m.categories)};return {version:FMX_VERSION,uid:m.uid,enabled:true,revision:s.revision};});await closeAlerts();return result;
 }
 if(m.type==='FMX_PUSH_DISABLE'){
  const result=await edit(s=>{if(s.binding?.uid&&s.binding.uid!==m.uid)return {disabled:false};s.revision++;s.binding=null;return {disabled:true,revision:s.revision};});if(result.disabled)await closeAlerts();return result;
 }
 if(m.type==='FMX_PUSH_READ'){
  if(!uidOK(m.uid))throw Error('Conta inválida.');return edit(s=>{if(s.binding?.uid!==m.uid)throw Error('Aviso fora da conta deste aparelho.');const rows=s.inboxes['u:'+m.uid]||[];for(const row of rows)if(!m.id||row.id===m.id)row.read=true;return {inbox:rows};});
 }
 if(m.type==='FMX_PUSH_LOCAL_TEST'){
  const s=await stateFor(m.uid);if(!s.enabled||s.uid!==m.uid)throw Error('Habilite o recebimento primeiro.');await receive({data:{uid:m.uid,category:'TESTE',eventId:'LOCAL-'+crypto.randomUUID(),title:'FMX · teste neste aparelho',body:'Exibição local funcionando. O recebimento pelo Firebase deve ser testado separadamente.'}});return {localTest:true};
 }
 throw Error('Comando de notificações desconhecido.');
}
self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>{
 if(!ownURL(event.source?.url)||!event.ports?.[0])return;
 event.waitUntil((async()=>{try{event.ports[0].postMessage({ok:true,result:await command(event.data||{})});}catch(e){event.ports[0].postMessage({ok:false,error:String(e.message||e)});}})());
});
async function receive(payload){
 const data=payload?.data||{},notification=payload?.notification||{};
 const result=await edit(s=>{
  const b=s.binding;if(!b?.enabled)return null;
  // Mensagens de teste do console podem não trazer UID. Nesse caso, só texto genérico.
  const targeted=uidOK(data.uid);if(targeted&&data.uid!==b.uid)return null;
  if(!targeted&&data.uid!==undefined)return null;
  const category=targeted?trim(data.category,40)||'TESTE':'TESTE';if(category!=='TESTE'&&(!FMX_CATEGORIES.includes(category)||!b.categories[category]))return null;
  const supplied=trim(data.eventId||payload.fcmMessageId||payload.messageId||payload['google.message_id'],160);
  const id=supplied||crypto.randomUUID(),key=b.uid+':'+id;if(s.seen.includes(key))return null;
  s.seen.push(key);s.seen=s.seen.slice(-300);
  const row={id,uid:b.uid,category,title:targeted?trim(data.title||notification.title,120)||'FMX · novo aviso':'FMX · teste de recebimento',body:targeted?trim(data.body||notification.body,500):'Uma mensagem de teste chegou pelo Firebase. Abra o FMX para conferir.',at:new Date().toISOString(),read:false};
  const rows=s.inboxes['u:'+b.uid]||[];rows.unshift(row);s.inboxes['u:'+b.uid]=rows.slice(0,50);
  return {row,revision:s.revision};
 });
 if(!result)return;
 const valid=await stateFor(result.row.uid);if(!valid.enabled||valid.uid!==result.row.uid||valid.revision!==result.revision)return;
 await self.registration.showNotification(result.row.title,{body:result.row.body,tag:'fmx:'+result.row.id,icon:new URL('fmx-icon-192.png',FMX_SCOPE).href,data:{uid:result.row.uid,id:result.row.id},renotify:false});
 const after=await stateFor(result.row.uid);if(after.uid!==result.row.uid||!after.enabled||after.revision!==result.revision){await closeAlerts();return;}
 for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true}))if(ownURL(client.url))client.postMessage({type:'FMX_PUSH_RECEIVED',uid:result.row.uid,id:result.row.id});
}
self.addEventListener('push',event=>event.waitUntil((async()=>{let payload;try{payload=event.data?.json();}catch{return;}if(payload&&typeof payload==='object')await receive(payload);})()));
self.addEventListener('notificationclick',event=>{
 event.notification.close();event.waitUntil((async()=>{const data=event.notification.data||{},s=await stateFor(data.uid);if(!s.enabled||s.uid!==data.uid)return;const all=await self.clients.matchAll({type:'window',includeUncontrolled:true});const existing=all.find(c=>ownURL(c.url));if(existing){await existing.focus();existing.postMessage({type:'FMX_PUSH_OPEN',uid:data.uid});}else await self.clients.openWindow(FMX_SCOPE+'?fmxAvisos=1');})());
});
// Sem fetch handler: este worker não cria cache do HTML nem intercepta o Firebase.
