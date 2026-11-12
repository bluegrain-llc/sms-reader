export type Capability = 'forms' | 'sms';
export type Json = { [key:string]: any };
export interface Storage { load():Promise<Json|null>; save(state:Json):Promise<void> }
export interface Options { signal?:AbortSignal; fetch?:typeof fetch; allowHttpLoopback?:boolean }
export class RelayClient { constructor(baseUrl:string,options?:Options); request(path:string,token:string,body?:unknown,method?:string):Promise<Json> }
export interface SessionTicket { version:1; relayOrigin:string; agent:{name:string;purpose:string;capabilities:Capability[]}; serviceCredential:string; deliveryKeys:Json[] }
export class ServiceSession {
  /** Private software state; never expose it through model tools or configuration. */
  readonly state: Json;
  static create(input:{baseUrl:string;name:string;purpose:string;capabilities?:Capability[]},storage:Storage,options?:Options):Promise<ServiceSession>;
  static importTicket(ticket:SessionTicket,storage:Storage,options?:Options):Promise<ServiceSession>;
  exportTicket():Promise<SessionTicket>;
  static resume(storage:Storage,options?:Options):Promise<ServiceSession>;
  startRegistration():Promise<Json>;waitForRegistration():Promise<{serviceId:string;link:string}>;
  startPairing(options?:{capabilities?:Capability[];expiresInDays?:number|null;externalAccountRef?:string}):Promise<Json>;
  waitForPairing():Promise<string>;restartPairing(options?:Json):Promise<Json>;permanentLink():string;
  consumeDeliveries():Promise<number>;rotateCredential():Promise<void>;rotateKey(retireKeyId?:string):Promise<void>;
  connection(id:string):Connection;
}
export class Connection {
  status():Promise<Json>;requestForm(definition:Json):Promise<Json>;getForm(id:string):Promise<Json>;formResult(id:string):Promise<Json>;cancelForm(id:string):Promise<Json>;
  requestSms(definition:Json):Promise<Json>;getSms(id:string):Promise<Json>;cancelSms(id:string):Promise<Json>;events(cursor?:string):Promise<Json>;
  registerWebhook(definition:Json):Promise<Json>;webhooks():Promise<Json>;deleteWebhook(id:string):Promise<Json>;
}
