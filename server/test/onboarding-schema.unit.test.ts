import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const schemas=JSON.parse(readFileSync(new URL('../../contracts/onboarding.schemas.json',import.meta.url),'utf8'));
test('published input schemas preserve runtime defaults and explicit capability uniqueness',()=>{
  assert.ok(!schemas.ServiceRegistration.required.includes('capabilities'));
  assert.ok(!schemas.Pairing.required.includes('expiresInDays'));
  assert.ok(!schemas.OAuthClient.required.includes('grant_types'));
  assert.ok(!schemas.FormRequest.required.includes('fields'));
  assert.equal(schemas.OAuthDecision.properties.capabilities.uniqueItems,true);
});
