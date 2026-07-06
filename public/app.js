// V4_CHANGE: 从 index.html 提取 JS 到独立文件，加入 JWT token 缓存和身份恢复
/* ====== 全局状态 ====== */
let myUser=null,activeChat=null,pollTimer=null,lastSeq=0,activeTab='messages';
const friendsMap=new Map();
const chatHistories=new Map();
const unreadCounts=new Map();
let pendingRequests=[];
let callState=null;
const EMOJI_LIST=[
  '😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','😘','🥰','😗',
  '😚','😇','🙂','🤗','🤩','😏','😌','😛','😜','😝','🤑','🤔','🤐','😐','😑','😶',
  '🙄','😣','😥','😮','😯','😪','😫','😴','😌','🤤','😒','😓','😕','🙃','😲','😖',
  '😞','😟','😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰','😱','🥵','🥶','😳',
  '🤪','😵','😡','😠','🤬','😷','🤒','🤕','🤢','🤮','😈','👿','💀','🤡','👻','👽',
  '🤖','❤️','🧡','💛','💚','💙','💜','🖤','💕','💖','💗','👍','👎','👏','🙌','🤝',
  '💪','🙏','✌️','👌','👋','🖐','✋','🎉','🎊','✨',
];
const RTC_CONFIG={iceServers:[{urls:'stun:stun.l.google.com:19302'}]};

// V4_CHANGE: localStorage 存取 token 相关身份信息
function saveIdentity(user, token) {
  localStorage.setItem('chat_user_id', user.id);
  localStorage.setItem('chat_nickname', user.nickname);
  localStorage.setItem('chat_token', token);
}

// V4_CHANGE: 从 localStorage 恢复缓存的旧身份（用于重连恢复）
function loadCachedIdentity() {
  const id = localStorage.getItem('chat_user_id');
  const nickname = localStorage.getItem('chat_nickname');
  const token = localStorage.getItem('chat_token');
  if (id && nickname) return { id, nickname, token };
  return null;
}

/* ====== 连接与轮询 ====== */
// V4_CHANGE: 登录请求携带旧 token 以便服务端恢复身份；响应中缓存新 token
async function connect(){
  try{
    const cached = loadCachedIdentity();
    const loginBody = { nickname: myUser.nickname };
    // V4_CHANGE: 如果有缓存的旧 token/ID，传给服务端尝试恢复身份（避免刷新丢身份）
    if (cached && cached.token) loginBody.token = cached.token;
    if (cached && cached.id) loginBody.userId = cached.id;

    const loginRes = await fetch('/api/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(loginBody)
    });
    const loginData = await loginRes.json();
    if(!loginData.ok){showToast('登录失败');return}
    myUser = loginData.user;
    // V4_CHANGE: 缓存 userId + nickname + token 三要素
    saveIdentity(myUser, loginData.token);
    updateMyAvatar();
    showToast(`欢迎，${myUser.nickname}！`);
    lastSeq=0;
    await poll();
    startPolling();
    loadFriends();
    loadRequests();
  }catch(err){showToast('网络错误，3秒后重连...');setTimeout(connect,3000)}
}

// V4_CHANGE: 轮询请求附加 token 校验
async function poll(){
  if(!myUser)return;
  try{
    const cached = loadCachedIdentity();
    const token = cached ? cached.token : '';
    const res = await fetch(`/api/poll?userId=${myUser.id}&since=${lastSeq}&token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if(!data.ok)return;
    (data.events||[]).forEach(evt=>{lastSeq=Math.max(lastSeq,evt.seq);handleEvent(evt)});
  }catch(e){}
}
function startPolling(){if(pollTimer)clearInterval(pollTimer);pollTimer=setInterval(poll,2000)}
function handleEvent(evt){
  switch(evt.type){
    case'message':addMessageToChat(evt.data.message);break;
    case'typing':handleTyping(evt.data);break;
    case'user_online':case'user_offline':loadFriends();if(activeChat)updateChatHeader();break;
    case'friend_request':loadRequests();showToast(`${evt.data.fromNickname} 请求加你为好友`);break;
    case'friend_accepted':loadFriends();showToast(`${evt.data.fromNickname} 已接受好友请求`);break;
    case'friends_update':loadFriends();break;
    case'call_offer':handleCallOffer(evt.data);break;
    case'call_answer':handleCallAnswer(evt.data);break;
    case'call_ice':handleCallICE(evt.data);break;
    case'call_end':handleCallEnd();break;
  }
}

/* ====== 标签切换 ====== */
function switchTab(tab){
  activeTab=tab;
  document.querySelectorAll('.sidebar-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+tab));
  // 同步移动端底部导航
  document.querySelectorAll('.mobile-tabbar .tab-item').forEach(t=>t.classList.toggle('active',tab==='messages'&&t.textContent.includes('消息')||tab==='contacts'&&t.textContent.includes('通讯录')||tab==='requests'&&t.textContent.includes('新的朋友')));
  if(tab==='contacts')document.getElementById('userSearchInput').focus();
  if(tab==='requests')loadRequests();
}

/* ====== 好友列表 ====== */
async function loadFriends(){
  try{const res=await fetch(`/api/friends?userId=${myUser.id}`);const data=await res.json();if(data.ok){friendsMap.clear();data.friends.forEach(f=>friendsMap.set(f.id,f));renderFriendList()}}catch(e){}
}
function renderFriendList(){
  const c=document.getElementById('friendList');
  const q=(document.getElementById('friendSearchInput')?.value||'').toLowerCase();
  let entries=Array.from(friendsMap.values());
  if(q)entries=entries.filter(f=>f.nickname.toLowerCase().includes(q));
  entries.sort((a,b)=>{const au=unreadCounts.get(a.id)||0,bu=unreadCounts.get(b.id)||0;return bu-au});
  if(entries.length===0){c.innerHTML='<div class="empty-state"><p>还没有好友，去「通讯录」搜索添加吧</p></div>';return}
  c.innerHTML=entries.map(f=>{
    const lastMsg=getLastMessage(f.id),unread=unreadCounts.get(f.id)||0;
    return`<div class="contact-item${activeChat===f.id?' active':''}" onclick="openChat('${f.id}')">
      <div class="contact-avatar" style="background:${f.avatarColor}">${f.nickname[0]}</div>
      <div class="contact-info"><div class="contact-name">${esc(f.nickname)}${f.online?' <span class="online-dot"></span>':''}</div><div class="contact-last">${lastMsg?lastMsg.text:''}</div></div>
      <div class="contact-meta"><span class="contact-time">${lastMsg?formatTime(lastMsg.timestamp):''}</span><span class="contact-unread${unread>0?' show':''}">${unread>99?'99+':unread}</span></div>
    </div>`;
  }).join('');
}
function filterFriends(){renderFriendList()}
function getLastMessage(uid){const h=chatHistories.get(uid)||[];return h[h.length-1]||null}

/* ====== 搜索用户 ====== */
let searchTimer=null;
async function searchUsers(){
  clearTimeout(searchTimer);
  searchTimer=setTimeout(async()=>{
    const q=document.getElementById('userSearchInput').value.trim();
    const r=document.getElementById('searchResults');
    const e=document.getElementById('contactEmpty');
    if(!q){r.innerHTML='';e.style.display='flex';return}
    e.style.display='none';
    try{
      const res=await fetch(`/api/search?userId=${myUser.id}&q=${encodeURIComponent(q)}`);
      const data=await res.json();
      if(!data.ok||data.users.length===0){r.innerHTML='<div class="empty-state"><p>未找到用户</p></div>';return}
      r.innerHTML=data.users.map(u=>{
        let btn='';
        if(u.isFriend)btn='<button class="btn-add friend">已是好友</button>';
        else if(u.hasPendingRequest)btn='<button class="btn-add pending">已发送</button>';
        else btn=`<button class="btn-add add" onclick="sendFriendRequest('${u.id}')">加好友</button>`;
        return`<div class="search-result">
          <div class="result-avatar" style="background:${u.avatarColor}">${u.nickname[0]}</div>
          <div class="result-info"><div class="result-name">${esc(u.nickname)}</div><div class="result-status">${u.online?'在线':'离线'}</div></div>
          ${btn}
        </div>`;
      }).join('');
    }catch(e){}
  },300);
}
async function sendFriendRequest(toId){
  try{const res=await apiPost('/api/friend/request',{from:myUser.id,to:toId});if(res.ok)showToast('好友请求已发送');else showToast(res.error||'发送失败');searchUsers()}catch(e){}
}

/* ====== 好友请求 ====== */
async function loadRequests(){
  try{
    const res=await fetch(`/api/friend/requests?userId=${myUser.id}`);
    const data=await res.json();
    if(data.ok){pendingRequests=data.requests||[];renderRequests();const badge=document.getElementById('requestBadge');const cnt=pendingRequests.length;badge.textContent=cnt;badge.style.display=cnt>0?'inline-flex':'none';const dot=document.getElementById('tabDot');if(dot)dot.classList.toggle('has-badge',cnt>0)}
  }catch(e){}
}
function renderRequests(){
  const c=document.getElementById('requestList'),e=document.getElementById('requestEmpty');
  if(pendingRequests.length===0){c.innerHTML='';e.style.display='flex';return}
  e.style.display='none';
  c.innerHTML=pendingRequests.map(r=>`<div class="request-card">
    <div class="req-avatar" style="background:${r.fromAvatarColor||'#ccc'}">${(r.fromNickname||'?')[0]}</div>
    <div class="req-info"><div class="req-name">${esc(r.fromNickname)}</div><div class="req-text">请求添加你为好友</div></div>
    <div class="req-actions">
      <button class="btn-accept" onclick="acceptRequest('${r.from}','${r.to}')">接受</button>
      <button class="btn-reject" onclick="rejectRequest('${r.from}','${r.to}')">拒绝</button>
    </div>
  </div>`).join('');
}
async function acceptRequest(from,to){await apiPost('/api/friend/accept',{from,to});loadRequests();loadFriends()}
async function rejectRequest(from,to){await apiPost('/api/friend/reject',{from,to});loadRequests()}

/* ====== 聊天 ====== */
function openChat(userId){
  activeChat=userId;unreadCounts.set(userId,0);
  const sb=document.getElementById('sidebar'),ca=document.getElementById('chatArea');
  if(window.innerWidth<=768){sb.classList.add('mobile-hidden');ca.classList.add('mobile-active')}
  document.getElementById('welcomeScreen').style.display='none';
  document.getElementById('chatView').style.display='flex';
  updateChatHeader();requestHistory(userId);renderFriendList();
  document.getElementById('typingIndicator').classList.remove('show');
  document.getElementById('emojiPicker').classList.remove('show');
  setTimeout(()=>scrollToBottom(),100);
  document.getElementById('messageInput').focus();
}
function updateChatHeader(){
  if(!activeChat)return;
  const u=friendsMap.get(activeChat);
  if(u){
    document.getElementById('chatAvatar').style.background=u.avatarColor;
    document.getElementById('chatAvatar').textContent=u.nickname[0];
    document.getElementById('chatTitle').textContent=u.nickname;
    document.getElementById('chatSubtitle').textContent=u.online?'在线':'离线';
    document.getElementById('btnVideoCall').style.display='flex';
  }
}
function goBack(){
  document.getElementById('sidebar').classList.remove('mobile-hidden');
  document.getElementById('chatArea').classList.remove('mobile-active');
  activeChat=null;
  document.getElementById('welcomeScreen').style.display='flex';
  document.getElementById('chatView').style.display='none';
}
function requestHistory(uid){const h=chatHistories.get(uid);if(!h||h.length===0)fetchHistory(uid);else renderMessages(uid)}
async function fetchHistory(uid){
  try{const res=await fetch(`/api/history?userId=${myUser.id}&with=${uid}`);const data=await res.json();if(data.ok){chatHistories.set(data.with,data.messages);renderMessages(data.with)}}catch(e){}
}
function renderMessages(uid){
  const msgs=chatHistories.get(uid)||[];
  document.getElementById('chatMessages').innerHTML=msgs.map(m=>{
    if(m.type==='system')return`<div class="message-row system"><span class="msg-system-text">${esc(m.text)}</span></div>`;
    const isSelf=m.from===myUser.id;
    const t=new Date(m.timestamp),ts=`${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    return`<div class="message-row ${isSelf?'self':'other'}">
      <div class="msg-avatar" style="background:${m.fromAvatarColor||'#ccc'}">${(m.fromNickname||'?')[0]}</div>
      <div class="msg-body"><div class="msg-bubble">${esc(m.text)}</div><span class="msg-time">${ts}</span></div>
    </div>`;
  }).join('');
  scrollToBottom();
}
function addMessageToChat(msg){
  const uid=msg.from===myUser.id?msg.to:msg.from;
  if(!chatHistories.has(uid))chatHistories.set(uid,[]);
  const hist=chatHistories.get(uid);
  if(hist.some(m=>m.id===msg.id))return;
  hist.push(msg);
  if(msg.from!==myUser.id&&activeChat!==uid){const cnt=(unreadCounts.get(uid)||0)+1;unreadCounts.set(uid,cnt)}
  if(activeChat===uid){document.getElementById('chatMessages').insertAdjacentHTML('beforeend',renderMsgBubble(msg));scrollToBottom()}
  renderFriendList();
}
function renderMsgBubble(m){
  const isSelf=m.from===myUser.id,t=new Date(m.timestamp),ts=`${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
  return`<div class="message-row ${isSelf?'self':'other'}">
    <div class="msg-avatar" style="background:${m.fromAvatarColor||'#ccc'}">${(m.fromNickname||'?')[0]}</div>
    <div class="msg-body"><div class="msg-bubble">${esc(m.text)}</div><span class="msg-time">${ts}</span></div>
  </div>`;
}
function handleTyping(data){if(activeChat===data.from){const el=document.getElementById('typingIndicator');if(data.isTyping)el.classList.add('show');else el.classList.remove('show')}}

/* ====== 发送消息 ====== */
async function sendMessage(){
  if(!activeChat)return;
  const input=document.getElementById('messageInput'),text=input.value.trim();
  if(!text)return;
  const msg={id:'local_'+Date.now(),from:myUser.id,fromNickname:myUser.nickname,fromAvatarColor:myUser.avatarColor,to:activeChat,text,timestamp:Date.now()};
  addMessageToChat(msg);
  input.value='';input.style.height='40px';updateSendButton();
  const result=await apiPost('/api/message',{from:myUser.id,to:activeChat,text});
  if(result.ok){const hist=chatHistories.get(activeChat)||[],idx=hist.findIndex(m=>m.id===msg.id);if(idx>=0){hist[idx]=result.message;if(activeChat===msg.to)renderMessages(activeChat)}}
  else showToast('发送失败');
}
function handleInputKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}}
function autoResize(el){el.style.height='40px';el.style.height=Math.min(el.scrollHeight,120)+'px';updateSendButton()}
function updateSendButton(){document.getElementById('btnSend').disabled=!document.getElementById('messageInput').value.trim()}

/* ====== 视频通话 ====== */
async function startCall(){
  if(!activeChat||callState)return;
  const peer=friendsMap.get(activeChat);
  if(!peer||!peer.online){showToast('好友不在线');return}
  callState={peerId:peer.id,peerName:peer.nickname,peerConnection:null,localStream:null,isCaller:true,muted:false};
  document.getElementById('videoCallOverlay').classList.add('active');
  document.getElementById('callPeerName').textContent=peer.nickname;
  document.getElementById('callStatus').textContent='正在呼叫...';
  try{
    callState.localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    document.getElementById('localVideo').srcObject=callState.localStream;
    const pc=new RTCPeerConnection(RTC_CONFIG);callState.peerConnection=pc;
    callState.localStream.getTracks().forEach(t=>pc.addTrack(t,callState.localStream));
    pc.ontrack=e=>{document.getElementById('remoteVideo').srcObject=e.streams[0];document.getElementById('callStatus').textContent='通话中'};
    pc.onicecandidate=e=>{if(e.candidate)apiPost('/api/call/ice',{from:myUser.id,to:peer.id,candidate:e.candidate})};
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);
    await apiPost('/api/call/offer',{from:myUser.id,to:peer.id,sdp:offer});
  }catch(e){showToast('无法访问摄像头/麦克风');endCall()}
}
async function handleCallOffer(data){
  if(callState)return;
  document.getElementById('incomingName').textContent=data.fromNickname;
  document.getElementById('incomingCall').classList.add('show');
  window._pendingOffer={from:data.from,fromNickname:data.fromNickname,sdp:data.sdp};
}
async function acceptCall(){
  document.getElementById('incomingCall').classList.remove('show');
  const o=window._pendingOffer;if(!o)return;
  callState={peerId:o.from,peerName:o.fromNickname,peerConnection:null,localStream:null,isCaller:false,muted:false};
  document.getElementById('videoCallOverlay').classList.add('active');
  document.getElementById('callPeerName').textContent=o.fromNickname;
  document.getElementById('callStatus').textContent='连接中...';
  try{
    callState.localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    document.getElementById('localVideo').srcObject=callState.localStream;
    const pc=new RTCPeerConnection(RTC_CONFIG);callState.peerConnection=pc;
    callState.localStream.getTracks().forEach(t=>pc.addTrack(t,callState.localStream));
    pc.ontrack=e=>{document.getElementById('remoteVideo').srcObject=e.streams[0];document.getElementById('callStatus').textContent='通话中'};
    pc.onicecandidate=e=>{if(e.candidate)apiPost('/api/call/ice',{from:myUser.id,to:o.from,candidate:e.candidate})};
    await pc.setRemoteDescription(new RTCSessionDescription(o.sdp));
    const answer=await pc.createAnswer();await pc.setLocalDescription(answer);
    await apiPost('/api/call/answer',{from:myUser.id,to:o.from,sdp:answer});
  }catch(e){showToast('无法访问摄像头/麦克风');endCall()}
}
async function handleCallAnswer(data){if(!callState||!callState.peerConnection)return;try{await callState.peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));document.getElementById('callStatus').textContent='通话中'}catch(e){}}
async function handleCallICE(data){if(!callState||!callState.peerConnection)return;try{await callState.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate))}catch(e){}}
function rejectCall(){document.getElementById('incomingCall').classList.remove('show');if(window._pendingOffer)apiPost('/api/call/end',{from:myUser.id,to:window._pendingOffer.from}).catch(()=>{});window._pendingOffer=null}
function handleCallEnd(){showToast('对方已挂断');cleanupCall()}
function endCall(){if(callState)apiPost('/api/call/end',{from:myUser.id,to:callState.peerId}).catch(()=>{});cleanupCall()}
function cleanupCall(){
  if(callState&&callState.localStream)callState.localStream.getTracks().forEach(t=>t.stop());
  if(callState&&callState.peerConnection)callState.peerConnection.close();
  callState=null;
  document.getElementById('videoCallOverlay').classList.remove('active');
  document.getElementById('localVideo').srcObject=null;
  document.getElementById('remoteVideo').srcObject=null;
  document.getElementById('btnMute').classList.remove('muted');
}
function toggleMute(){
  if(!callState||!callState.localStream)return;
  callState.muted=!callState.muted;
  callState.localStream.getAudioTracks().forEach(t=>t.enabled=!callState.muted);
  document.getElementById('btnMute').classList.toggle('muted',callState.muted);
}
window.addEventListener('beforeunload',()=>{if(myUser)navigator.sendBeacon('/api/logout',JSON.stringify({userId:myUser.id}))});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&myUser)poll()});

/* ====== 工具函数 ====== */
async function apiPost(path,body){
  try{const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return await res.json()}catch(e){return{ok:false,error:e.message}}
}
function updateMyAvatar(){
  document.getElementById('myAvatarSmall').style.background=myUser.avatarColor;
  document.getElementById('myAvatarSmall').textContent=myUser.nickname[0];
}
function scrollToBottom(){requestAnimationFrame(()=>{const el=document.getElementById('chatMessages');el.scrollTop=el.scrollHeight})}
function formatTime(ts){const d=new Date(ts),n=new Date();if(d.toDateString()===n.toDateString())return`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;return`${d.getMonth()+1}/${d.getDate()}`}
function esc(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._timeout);t._timeout=setTimeout(()=>t.classList.remove('show'),2000)}

/* ====== 表情 ====== */
function toggleEmoji(){
  const p=document.getElementById('emojiPicker');
  if(!p.innerHTML)p.innerHTML=EMOJI_LIST.map(e=>`<span class="emoji-item" onclick="insertEmoji('${e}')">${e}</span>`).join('');
  p.classList.toggle('show');
}
function insertEmoji(emoji){
  const input=document.getElementById('messageInput'),s=input.selectionStart,e2=input.selectionEnd;
  input.value=input.value.substring(0,s)+emoji+input.value.substring(e2);
  input.selectionStart=input.selectionEnd=s+emoji.length;
  input.focus();updateSendButton();autoResize(input);
}
document.addEventListener('click',e=>{
  const p=document.getElementById('emojiPicker');
  if(p.classList.contains('show')&&!e.target.closest('.emoji-picker')&&!e.target.closest('.input-tool'))p.classList.remove('show');
});

/* ====== 登录 & 初始化 ====== */
// V4_CHANGE: 调用 /api/login 获取 JWT token，localStorage 缓存三要素
function login(){
  const input=document.getElementById('nicknameInput'),nickname=input.value.trim();
  if(!nickname){input.focus();input.style.borderColor='#FA5151';setTimeout(()=>input.style.borderColor='',1500);return}
  // V4_CHANGE: 不再手动组装 myUser，由 connect() 调用 /api/login 拿到服务端分配的身份
  const cached = loadCachedIdentity();
  myUser = { id: cached ? cached.id : null, nickname };
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('app').classList.add('active');
  connect();
}
document.getElementById('nicknameInput').addEventListener('keydown',e=>{if(e.key==='Enter')login()});

// V4_CHANGE: 页面加载时，如果有缓存的 token 且昵称不为空，自动登录
(function autoLoginOnLoad() {
  const cached = loadCachedIdentity();
  if (cached && cached.nickname) {
    document.getElementById('nicknameInput').value = cached.nickname;
    myUser = { id: cached.id, nickname: cached.nickname };
  }
})();

/* 输入状态 */
let typingTimeout=null;
document.getElementById('messageInput').addEventListener('input',()=>{
  if(!activeChat)return;
  apiPost('/api/typing',{from:myUser.id,to:activeChat,isTyping:true});
  clearTimeout(typingTimeout);
  typingTimeout=setTimeout(()=>{apiPost('/api/typing',{from:myUser.id,to:activeChat,isTyping:false})},1000);
});
