# xAI Responses integration

The adapter targets xAI's developer Responses API. The supported surfaces were checked against the official [function calling](https://docs.x.ai/developers/tools/function-calling) and [remote MCP](https://docs.x.ai/developers/tools/remote-mcp) guides on 2026-11-13. It does not establish support for connections in the Grok consumer application.

## Local function execution

Register a service and connect the recipient using the [shared onboarding flow](../docs/ONBOARDING.md). Select forms unless SMS is needed. Keep CLI storage private and select the recipient connection explicitly. Registration, pairing, key delivery and connection management stay outside model tools.

```js
import { connectProviderTools } from './integrations/providers.mjs';

const relay = await connectProviderTools({profile: 'my-agent', connectionId: selectedConnectionId});
if (relay.status === 'setup_needed') {
  // Present relay.link in the application's setup UI, then reconnect after approval.
} else {
  try {
    // xaiClient is your application's Responses client for https://api.x.ai/v1.
    const response = await xaiClient.responses.create({model, input, tools: relay.xai});
    const outputs = [];
    for (const item of response.output) {
      if (item.type !== 'function_call') continue;
      const result = await relay.execute(item.name, JSON.parse(item.arguments));
      outputs.push({type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result)});
    }
    // Return all outputs with previous_response_id: response.id in the next Responses call.
    // Bound your application's tool loop and keep results in memory.
  } finally {
    await relay.close();
  }
}
```

`relay.xai` contains only capability-approved function names, descriptions and JSON schemas. `relay.execute` rejects undeclared tools; each MCP call also rechecks authorization at the relay server. Credentials are never included in these declarations. Each form submission or SMS disclosure still requires recipient consent.

## Remote MCP execution

Use `relay service hosted-link --profile NAME` to obtain the named-service HTTPS resource. Your application must complete OAuth authorization with its own registered HTTPS callback, PKCE S256 and that exact resource. Keep state, verifier and tokens in private application storage. The adapter does not obtain tokens or run an OAuth browser flow.

```js
import { hostedProviderConfig } from './integrations/providers.mjs';
const tool = hostedProviderConfig('xai', {resource, accessToken});
// Application-only configuration: contains a credential. Never print or expose as a model tool result.
const response = await xaiClient.responses.create({model, input, tools: [tool]});
```

The helper accepts only named-service HTTPS URLs and OAuth `smsa_` access tokens. Pairing and service credentials are rejected. xAI's `require_approval` and `connector_id` fields are unsupported and are omitted. Authorization is managed by application software; setting an authorization field alone is not an OAuth flow. Refresh follows the relay's static-credential policy from [PR #27](https://github.com/bluegrain-llc/sms-reader/pull/27): newly issued credentials persist until revocation or the approved connection expires; legacy credentials retain the documented [upgrade behavior](../docs/API.md#hosted-oauth-mcp).

## Acceptance

The synthetic xAI authorization profile exercises discovery, application callback binding, PKCE, narrowed forms permission, resource isolation, request creation/inspection/cancellation, refresh and revocation against both server runtimes. It uses an application-owned callback fixture; it neither registers an xAI application nor contacts xAI. Unit coverage checks declaration shape, unauthorized execution and credential/URL validation.

Before an integration release, verify a live xAI function-call/result exchange and authenticated remote MCP call, actual application OAuth redirects, recipient disconnection, and service/credential revocation. Physical Android App Links, first sign-in, installation handoff, notification permission and per-request consent remain pending under [issue #25](https://github.com/bluegrain-llc/sms-reader/issues/25). Marketplace approval is separate. Repository tests do not claim those external checks have passed.
