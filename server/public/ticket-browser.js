// This module is used only by authenticated agent management, never model tools.
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
export async function createTicket(agent) {
  const serviceCredential = 'smss_' + encode(crypto.getRandomValues(new Uint8Array(32)));
  const pair = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const fullPublic = await crypto.subtle.exportKey('jwk',pair.publicKey), fullPrivate = await crypto.subtle.exportKey('jwk',pair.privateKey);
  const publicKey = {kty:'EC',crv:'P-256',x:fullPublic.x,y:fullPublic.y};
  const privateKey = {...publicKey,d:fullPrivate.d}, id = await digest(JSON.stringify(publicKey));
  return {version:1,relayOrigin:location.origin,agent,serviceCredential,deliveryKeys:[{id,publicKey,privateKey}]};
}
export async function declaration(ticket) {
  return {...ticket.agent,credentialHash:await digest(ticket.serviceCredential),deliveryPublicKey:ticket.deliveryKeys[0].publicKey};
}
export async function retained(uid, value, expectedCredential) {
  const db = await new Promise((resolve,reject)=>{const r=indexedDB.open('relay-agent-provisioning',1);r.onupgradeneeded=()=>r.result.createObjectStore('tickets');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('Private storage is unavailable.'));});
  try {
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction('tickets',value === undefined?'readonly':'readwrite'), store=tx.objectStore('tickets');
      const request=store.get(uid); let result, conflict=false;
      request.onsuccess=()=>{
        const existing=request.result;
        if(value===undefined){result=existing;return;}
        if((value===null && existing && existing.serviceCredential!==expectedCredential) ||
           (value && existing && JSON.stringify(existing)!==JSON.stringify(value))){
          conflict=true;tx.abort();return;
        }
        if(value===null)store.delete(uid);else store.put(value,uid);
        result=value;
      };
      tx.oncomplete=()=>resolve(result);
      tx.onerror=tx.onabort=()=>reject(Error(conflict?'Another tab retained a different ticket. Reload to recover it before continuing.':'Could not save private provisioning state.'));
    });
  } finally { db.close(); }
}
export function downloadTicket(ticket) {
  const blob=new Blob([JSON.stringify(ticket)],{type:'application/json'}), url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url;a.download='agent-session-ticket.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
