import { randomUUID } from 'node:crypto';
import { credential, deliveryKey, hash, RelayClient } from './client.mjs';
export { RelayClient };
/** Software-only convenience layer. Never register these lifecycle methods as model tools. */
export class ServiceSession {
  constructor(state, storage, options) { this.state = state; this.storage = storage; this.client = new RelayClient(state.baseUrl, options); }
  static async create({ baseUrl, name, purpose, capabilities = ['forms'] }, storage, options) {
    const client = new RelayClient(baseUrl, options);
    const state = { version:1, baseUrl:client.baseUrl, name, purpose, capabilities, serviceToken:credential('smss'),registrationToken:credential('smsreg'),keys:[await deliveryKey()],connections:{} };
    await storage.save(state); return new ServiceSession(state, storage, options);
  }
  static async resume(storage, options) { const state = await storage.load(); if (!state) throw Error('No saved service session.'); return new ServiceSession(state, storage, options); }
  save = () => this.storage.save(this.state);
  async startRegistration() {
    const s = this.state;
    s.registration = await this.client.request('/v3/registration-sessions',s.registrationToken,{name:s.name,purpose:s.purpose,capabilities:s.capabilities,credentialHash:hash(s.serviceToken),deliveryPublicKey:s.keys[0].publicKey});
    await this.save();return {...s.registration,link:new URL(s.registration.registrationPath,s.baseUrl).href};
  }
  async waitForRegistration() {
    const s = this.state;
    if (!s.registered) {
      await this.startRegistration();
      const approved=await this.client.poll(()=>this.client.request('/v3/registration-sessions/current',s.registrationToken),r=>r.status==='approved');
      s.serviceId=approved.serviceId;s.servicePath=approved.servicePath;s.registered=true;await this.save();
    }
    await this.consumeDeliveries();return {serviceId:s.serviceId,link:new URL(s.servicePath,s.baseUrl).href};
  }
  async startPairing({capabilities=this.state.capabilities,expiresInDays=null,externalAccountRef}={}) {
    const s=this.state;
    if (!s.pairingInput) {s.pairingInput={capabilities,expiresInDays,idempotencyKey:randomUUID(),...(externalAccountRef?{externalAccountRef}:{})};await this.save();}
    s.pairing=await this.client.request('/v3/service/pairing-sessions',s.serviceToken,s.pairingInput);await this.save();return {...s.pairing,link:new URL(s.pairing.connectionPath,s.baseUrl).href};
  }
  async waitForPairing() {
    const s=this.state;if(!s.pairing)await this.startPairing();
    const approved=await this.client.poll(()=>this.client.request(`/v3/service/pairing-sessions/${s.pairing.sessionId}`,s.serviceToken),r=>r.status==='approved');
    await this.consumeDeliveries();s.pairing=null;s.pairingInput=null;await this.save();return approved.connectionId;
  }
  async restartPairing(options) {this.state.pairing=null;this.state.pairingInput=null;await this.save();return this.startPairing(options);}
  permanentLink() {if(!this.state.servicePath)throw Error('Registration is incomplete.');return new URL(this.state.servicePath,this.state.baseUrl).href;}
  async consumeDeliveries() {return this.client.consume(this.state,this.save);}
  async rotateCredential() {
    const s=this.state;s.nextServiceToken??=credential('smss');await this.save();
    try {await this.client.request('/v3/service',s.serviceToken,{credentialHash:hash(s.nextServiceToken)},'PATCH');}
    catch(e){if(e.status!==401)throw e;await this.client.request('/v3/service/deliveries',s.nextServiceToken);}
    s.serviceToken=s.nextServiceToken;delete s.nextServiceToken;await this.save();
  }
  async rotateKey(retireKeyId) {
    const s=this.state;
    if (!s.nextKey) { s.nextKey=await deliveryKey(); s.nextRetireKeyId=retireKeyId??null; }
    else if (!('nextRetireKeyId' in s)) s.nextRetireKeyId=retireKeyId??null;
    else if (retireKeyId!==undefined && retireKeyId!==s.nextRetireKeyId) throw Error('Resume the pending key rotation before changing retirement.');
    await this.save();
    await this.client.request('/v3/service',s.serviceToken,{deliveryPublicKey:s.nextKey.publicKey,...(s.nextRetireKeyId?{retireKeyId:s.nextRetireKeyId}:{})},'PATCH');
    if(!s.keys.some(k=>k.id===s.nextKey.id))s.keys.push(s.nextKey);delete s.nextKey;delete s.nextRetireKeyId;await this.save();
  }
  connection(id) {return new Connection(this.client,this.state.connections[id]?.token);}
}
export class Connection {
  constructor(client, token) {if(!token)throw Error('Connection has not been delivered.');this.client=client;this.token=token;}
  status(){return this.client.request('/v3/connection',this.token);}
  requestForm(definition){return this.client.request('/v2/requests',this.token,definition);}
  getForm(id){return this.client.request(`/v2/requests/${encodeURIComponent(id)}`,this.token);}
  formResult(id){return this.client.request(`/v2/requests/${encodeURIComponent(id)}/result`,this.token);}
  cancelForm(id){return this.client.request(`/v2/requests/${encodeURIComponent(id)}/cancel`,this.token,{});}
  requestSms(definition){return this.client.request('/v1/requests',this.token,definition);}
  getSms(id){return this.client.request(`/v1/requests/${encodeURIComponent(id)}`,this.token);}
  cancelSms(id){return this.client.request(`/v1/requests/${encodeURIComponent(id)}/cancel`,this.token,{});}
  events(cursor){return this.client.request('/v2/events'+(cursor?'?cursor='+encodeURIComponent(cursor):''),this.token);}
  registerWebhook(definition){return this.client.request('/v2/webhooks',this.token,definition);}
  webhooks(){return this.client.request('/v2/webhooks',this.token);}
  deleteWebhook(id){return this.client.request(`/v2/webhooks/${encodeURIComponent(id)}`,this.token,undefined,'DELETE');}
}
