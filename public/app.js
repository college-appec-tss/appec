let adminToken = '';
let timer = null;
const $ = id => document.getElementById(id);

$('loginBtn').addEventListener('click', login);
$('token').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('refreshBtn').addEventListener('click', refresh);
$('smsForm').addEventListener('submit', sendMessage);

async function login(){
  const token = $('token').value.trim();
  $('loginError').textContent = '';
  if (!token) { $('loginError').textContent = 'Enter your admin token.'; return; }
  $('loginBtn').disabled = true;
  try {
    const r = await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    if(!r.ok) throw new Error('Invalid admin token');
    adminToken = token;
    $('loginView').hidden = true;
    $('appView').hidden = false;
    await refresh();
    timer = setInterval(refresh, 5000);
  } catch(e) { $('loginError').textContent = e.message; }
  finally { $('loginBtn').disabled = false; }
}

async function api(url, options={}){
  const r = await fetch(url,{...options,headers:{'x-admin-token':adminToken,...(options.headers||{})}});
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function refresh(){
  if(!adminToken) return;
  try { const data = await api('/api/state'); render(data); }
  catch(e){ $('gatewayBadge').textContent='Dashboard error'; $('gatewayBadge').className='badge unknown'; }
}

function render(data){
  const d=data.device, state=d?._localStatus?.status || 'unknown';
  const badge=$('gatewayBadge');
  badge.className='badge '+state;
  badge.textContent=state==='online'?'Gateway online':state==='offline'?'Gateway offline':'Gateway status unknown';
  const hb=d?.lastHeartbeat ? new Date(d.lastHeartbeat).toLocaleString() : 'No heartbeat yet';
  const model=[d?.manufacturer,d?.model].filter(Boolean).join(' ') || 'Android device';
  $('gatewayDetail').textContent=`${model} • ${state==='online'?'Ready to send':'Waiting for gateway'} • Last heartbeat: ${hb}`;

  const list=$('messages');
  if(!data.messages?.length){list.innerHTML='<p class="muted">No messages yet.</p>';return;}
  list.innerHTML=data.messages.map(m=>{
    const status=m.status || 'queued';
    const retry=status==='failed'?`<button class="retry" data-id="${m.id}">Retry</button>`:'';
    return `<article class="message"><div class="message-row"><span class="recipient">To ${escapeHtml(m.recipient)}</span><span class="status ${status}">${escapeHtml(status)}</span></div><div class="body">${escapeHtml(m.message)}</div><div class="meta">${new Date(m.createdAt).toLocaleString()} • attempts: ${m.attempts||0}${m.lastError?` • ${escapeHtml(m.lastError)}`:''}</div>${retry}${m.status === "queued" ? `<button class="delete-btn" onclick="deleteMessage('${m.id}')">Delete</button>` : ""}</article>`;
  }).join('');
  document.querySelectorAll('.retry').forEach(b=>b.addEventListener('click',()=>retry(b.dataset.id)));
}

async function sendMessage(e){
  e.preventDefault();
  const recipient=$('recipient').value.trim(), message=$('message').value.trim();
  if(!recipient||!message)return;
  $('sendBtn').disabled=true;$('sendSpinner').hidden=false;$('sendText').textContent='Queueing…';$('formStatus').textContent='Saving message and checking gateway…';
  try{await api('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recipient,message})});$('smsForm').reset();$('formStatus').textContent='Message queued. The server will retry automatically if the gateway is offline.';await refresh();}
  catch(e){$('formStatus').textContent=e.message;}
  finally{$('sendBtn').disabled=false;$('sendSpinner').hidden=true;$('sendText').textContent='Send message';}
}

async function retry(id){try{await api('/api/retry/'+encodeURIComponent(id),{method:'POST'});await refresh();}catch(e){alert(e.message)}}
function escapeHtml(v){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}



async function deleteMessage(id) {
  if (!confirm('Delete this pending SMS?')) return;

  try {
    await api('/api/messages/' + encodeURIComponent(id), { method: 'DELETE' });
    await refresh();
  } catch (e) {
    alert(e.message);
  }
}
