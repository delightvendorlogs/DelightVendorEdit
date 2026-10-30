(function(){
"use strict";
if(window.__dvAnnouncementLoaded)return;window.__dvAnnouncementLoaded=true;
var SUPABASE_URL="https://genlmqzkjouinofkitqt.supabase.co";
var KEY="sb_publishable_8uj618f_n35zeF3Fcyt5VA_xLHHOkNv";
function loadClient(done){
 if(window.supabase&&window.supabase.createClient){done();return;}
 var urls=["https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2","https://unpkg.com/@supabase/supabase-js@2"],i=0;
 function next(){if(i>=urls.length)return;var s=document.createElement("script");s.src=urls[i++];s.onload=function(){if(window.supabase&&window.supabase.createClient)done();else next();};s.onerror=next;document.head.appendChild(s);}next();
}
function appendMessage(target,message){
 var re=/https?:\/\/[^\s<>"']+/gi,last=0,m;
 while((m=re.exec(message))){
  if(m.index>last)target.appendChild(document.createTextNode(message.slice(last,m.index)));
  var raw=m[0],url=raw,trail="";
  while(/[),.!?;:]$/.test(url)){trail=url.slice(-1)+trail;url=url.slice(0,-1);}
  try{var parsed=new URL(url);if(parsed.protocol!=="http:"&&parsed.protocol!=="https:")throw 0;
   var a=document.createElement("a");a.href=parsed.href;a.target="_blank";a.rel="noopener noreferrer";a.textContent="Click here";a.className="dv-announcement-link";target.appendChild(a);
  }catch(_){target.appendChild(document.createTextNode(url));}
  if(trail)target.appendChild(document.createTextNode(trail));
  last=re.lastIndex;
 }
 if(last<message.length)target.appendChild(document.createTextNode(message.slice(last)));
}
function render(data){
 if(!data||!data.enabled||!String(data.message||"").trim())return;
 var bar=document.createElement("div");bar.className="dv-announcement-bar";bar.setAttribute("role","region");bar.setAttribute("aria-label","Site announcement");
 var track=document.createElement("div");track.className="dv-announcement-track";
 for(var n=0;n<2;n++){var item=document.createElement("span");item.className="dv-announcement-item";appendMessage(item,String(data.message));track.appendChild(item);}
 bar.appendChild(track);
 var style=document.createElement("style");style.textContent=".dv-announcement-bar{width:100%;height:39px;overflow:hidden;display:flex;align-items:center;background:#17130a;border-bottom:1px solid rgba(231,184,75,.3);color:#f5d982;position:relative;z-index:40;font:600 12px/1.4 system-ui,sans-serif}.dv-announcement-track{display:flex;align-items:center;width:max-content;min-width:max-content;animation:dvAnnouncementMove 34s linear infinite}.dv-announcement-bar:hover .dv-announcement-track{animation-play-state:paused}.dv-announcement-item{display:inline-flex;align-items:center;gap:8px;padding-left:42px;padding-right:42px;white-space:nowrap}.dv-announcement-link{color:#63a9ff!important;text-decoration:underline!important;text-underline-offset:2px;font-weight:800;cursor:pointer}.dv-announcement-link:hover{color:#9bc9ff!important}@keyframes dvAnnouncementMove{from{transform:translateX(0)}to{transform:translateX(-50%)}}@media(prefers-reduced-motion:reduce){.dv-announcement-track{animation-duration:90s}}";
 document.head.appendChild(style);
 var body=document.body;if(body.firstElementChild)body.insertBefore(bar,body.firstElementChild);else body.appendChild(bar);
}
loadClient(function(){try{var db=window.supabase.createClient(SUPABASE_URL,KEY,{auth:{persistSession:true,autoRefreshToken:true}});db.rpc("get_site_announcement").then(function(r){if(!r.error)render(r.data);}).catch(function(){});}catch(e){}});
})();