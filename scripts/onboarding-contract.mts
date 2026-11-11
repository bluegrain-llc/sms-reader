/** Deterministic publication of v3 schemas and the transport contract. */
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { FOREVER, capabilitiesSchema, publicKeySchema, serviceSchema, pairingSchema, decisionSchema, registrationDecisionSchema } from '../server/src/onboarding.js';
import { authorizationSchema, clientSchema, oauthDecisionSchema } from '../server/src/oauth.js';
import { formSchema } from '../server/src/forms-model.js';
import { requestSchema } from '../server/src/model.js';
const schemas = Object.fromEntries(Object.entries({ OAuthAuthorization: authorizationSchema, OAuthClient: clientSchema, OAuthDecision: oauthDecisionSchema, Capabilities: capabilitiesSchema, DeliveryPublicKey: publicKeySchema, ServiceRegistration: serviceSchema,
  Pairing: pairingSchema, PairingDecision: decisionSchema, RegistrationDecision: registrationDecisionSchema, FormRequest: formSchema, SmsRequest: requestSchema }).map(([key,s]) => [key,z.toJSONSchema(s)]));
(schemas.Capabilities as Record<string,unknown>).uniqueItems = true;
for (const name of ['ServiceRegistration','Pairing','PairingDecision','RegistrationDecision']) {
  const schema = schemas[name] as unknown as { properties: { capabilities: Record<string,unknown> } }; schema.properties.capabilities.uniqueItems = true;
}
const methods: [string,string,string,string,string?][] = [
 ['get','/v3/oauth/sessions/{id}','reviewHostedAuthorization','OwnerSession'],
 ['post','/v3/oauth/sessions/{id}/decision','decideHostedAuthorization','OwnerSession','OAuthDecision'],
 ['post','/v3/oauth/sessions/{id}/response','resumeHostedAuthorization','OwnerSession'],
 ['post','/v3/registration-sessions','startRegistration','RegistrationCredential','ServiceRegistration'],
 ['get','/v3/registration-sessions/current','pollRegistration','RegistrationCredential'],
 ['get','/v3/registration-sessions/{id}','reviewRegistration','OwnerSession'],
 ['post','/v3/registration-sessions/{id}/decision','decideRegistration','OwnerSession','RegistrationDecision'],
 ['get','/v3/services','listServices','OwnerSession'],
 ['get','/v3/services/{id}','getService','OwnerSession'],
 ['patch','/v3/services/{id}','manageService','OwnerSession','ServiceUpdate'],
 ['delete','/v3/services/{id}','deleteService','OwnerSession'],
 ['post','/v3/services/{id}/connections','startReusableConnection','OwnerSession','Pairing'],
 ['patch','/v3/service','rotateService','ServiceCredential','ServiceUpdate'],
 ['post','/v3/service/pairing-sessions','startPairing','ServiceCredential','Pairing'],
 ['get','/v3/service/pairing-sessions/{id}','pollPairing','ServiceCredential'],
 ['get','/v3/pairing-sessions/{id}','reviewPairing','OwnerSession'],
 ['post','/v3/pairing-sessions/{id}/decision','decidePairing','OwnerSession','PairingDecision'],
 ['get','/v3/service/deliveries','listDeliveries','ServiceCredential'],
 ['post','/v3/service/deliveries/{id}/acknowledgement','acknowledgeDelivery','ServiceCredential'],
 ['get','/v3/service/connections/{id}','serviceConnectionStatus','ServiceCredential'],
 ['get','/v3/connection','connectionStatus','ConnectionCredential'],
 ['get','/v3/connections/{id}','ownerConnectionStatus','OwnerSession'],
 ['patch','/v3/connections/{id}','manageConnection','OwnerSession','ConnectionUpdate'],
 ['delete','/v3/connections/{id}','disconnect','OwnerSession'],
 ['post','/v1/requests','requestSms','ConnectionCredential','SmsRequest'],
 ['get','/v1/requests/{id}','getSms','ConnectionCredential'],
 ['post','/v1/requests/{id}/cancel','cancelSms','ConnectionCredential'],
 ['post','/v2/requests','requestForm','ConnectionCredential','FormRequest'],
 ['get','/v2/requests/{id}','getForm','ConnectionCredential'],
 ['get','/v2/requests/{id}/result','getFormResult','ConnectionCredential'],
 ['post','/v2/requests/{id}/cancel','cancelForm','ConnectionCredential'],
 ['get','/v2/events','pollEvents','ConnectionCredential'],
 ['post','/v2/webhooks','registerWebhook','ConnectionCredential','Webhook'],
 ['get','/v2/webhooks','listWebhooks','ConnectionCredential'],
 ['delete','/v2/webhooks/{id}','deleteWebhook','ConnectionCredential'],
];
const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const paths: Record<string,Record<string,unknown>> = {};
for (const [verb,path,name,auth,body] of methods) {
  const parameters: unknown[] = path.includes('{id}') ? [{ name: 'id', in: 'path', required: true, schema: { type:'string', pattern:'^[a-zA-Z0-9_-]{1,128}$' } }] : [];
  if (name === 'pollEvents') parameters.push({ name:'cursor',in:'query',required:false,schema:{type:'string',maxLength:128} });
  (paths[path] ??= {})[verb] = { operationId: name, security:[{[auth]:[]}], parameters,
    ...(body ? { requestBody: { required:true,content:{'application/json':{schema:schemaRef(body)}} } } : {}),
    responses: Object.fromEntries([(verb==='post'&&['startRegistration','startPairing','startReusableConnection','requestSms','requestForm','registerWebhook'].includes(name))?'201':'200','400','401','403','404','409','410','429','503'].map(code=>[code,{description: code[0]==='2'?'Success':'Relay error; never log authentication headers or payloads',content:{'application/json':{schema:code[0]==='2'?{type: name === 'listServices' || name === 'listWebhooks' ? 'array' : 'object', ...(name === 'listServices' || name === 'listWebhooks' ? { items: {type:'object',additionalProperties:true} } : {additionalProperties:true})}:schemaRef('Error')}}}])) };
}
paths['/oauth/register'] = { post: {operationId:'registerOAuthClient',security:[],requestBody:{required:true,content:{'application/json':{schema:schemaRef('OAuthClient')}}},responses:{'201':{description:'Client registered; confidential client secret is returned once.'},'400':{description:'Invalid client metadata'},'429':{description:'Registration limit'}}} };
paths['/oauth/authorize'] = {get:{operationId:'startHostedAuthorization',security:[],parameters:Object.entries((schemas.OAuthAuthorization as any).properties).map(([name,schema])=>({name,in:'query',required:name!=='state',schema})),responses:{'303':{description:'Redirect to focused sign-in and consent; no access is granted.'},'400':{description:'Invalid authorization request'},'503':{description:'OAuth is not configured'}}}};
for (const operation of ['token','revoke']) paths[`/oauth/${operation}`]={post:{operationId:`${operation}OAuthCredential`,security:[],requestBody:{required:true,content:{'application/x-www-form-urlencoded':{schema:{type:'object',additionalProperties:{type:'string'},description:'Public clients send client_id. Confidential clients also send client_secret. Token exchange requires the exact resource and PKCE verifier; refresh requires the current rotating refresh token. Revocation accepts token.'}}}},responses:{'200':{description:operation==='token'?'Resource/client/connection-bound access token; rotating refresh token when registered.':'Token family revoked, or unknown token ignored.'},'400':{description:'Invalid OAuth request or grant'},'401':{description:'Invalid client authentication'}}}};
paths['/.well-known/oauth-authorization-server']={get:{operationId:'getOAuthMetadata',security:[],responses:{'200':{description:'RFC 8414 authorization server metadata'}}}};
paths['/.well-known/oauth-protected-resource/mcp/services/{id}']={get:{operationId:'getMcpResourceMetadata',security:[],parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}],responses:{'200':{description:'RFC 9728 named-service resource metadata'}}}};
paths['/mcp/services/{id}']={post:{operationId:'callHostedMcp',security:[{HostedOAuth:[]}],parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}],requestBody:{required:true,content:{'application/json':{schema:{type:'object'}}}},responses:{'200':{description:'MCP response containing only connection-authorized tools/results'},'401':{description:'WWW-Authenticate identifies protected-resource metadata'}}}};
const document = { openapi:'3.1.0',info:{ title:'Request Relay onboarding and caller API',version:'3.0.0',description:'One relay origin. Prefixes separate registration, service and connection authority. Service tokens cannot request information or retrieve results. Firebase identities stay on the owner side. Legacy request interfaces remain compatible.' },paths,
  components:{securitySchemes:{HostedOAuth:{type:'oauth2',flows:{authorizationCode:{authorizationUrl:'/oauth/authorize',tokenUrl:'/oauth/token',scopes:{forms:'Information and decisions through forms',sms:'Upcoming SMS codes, shared with your approval'}}}},...Object.fromEntries(['RegistrationCredential','ServiceCredential','ConnectionCredential','OwnerSession'].map(name=>[name,{type:'http',scheme:'bearer',description:{RegistrationCredential:'Private smsreg_ credential generated before starting registration.',ServiceCredential:'Private smss_ credential, limited to pairing and delivery.',ConnectionCredential:'Private smsr_ recipient credential delivered by JWE.',OwnerSession:'Firebase ID token; never sent to the service.'}[name]}]))},schemas:{...schemas,
  ServiceUpdate:{type:'object',additionalProperties:false,properties:{credentialHash:{type:'string',pattern:'^[a-f0-9]{64}$'},deliveryPublicKey:schemaRef('DeliveryPublicKey'),retireKeyId:{type:'string',pattern:'^[a-f0-9]{64}$'},active:{type:'boolean'},delete:{const:true}}},
  ConnectionUpdate:{type:'object',additionalProperties:false,required:['capabilities','expiresAt'],properties:{capabilities:schemaRef('Capabilities'),expiresAt:{type:['integer','null'],minimum:1,maximum:FOREVER}}},
  Webhook:z.toJSONSchema((await import('../server/src/forms-model.js')).webhookSchema),
  Error:{type:'object',required:['error'],properties:{error:{type:'string'}},additionalProperties:false} }} };
writeFileSync(new URL('../contracts/onboarding.openapi.json',import.meta.url),JSON.stringify(document,null,2)+'\n');
writeFileSync(new URL('../contracts/onboarding.schemas.json',import.meta.url),JSON.stringify(schemas,null,2)+'\n');
