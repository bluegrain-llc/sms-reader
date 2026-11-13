# Microsoft Azure OpenAI integration

This adapter targets Microsoft's developer Azure OpenAI Responses API. Its [function calling](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses#function-calling) and [remote MCP authentication](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses#authentication) interfaces were checked on 2026-11-13. Configure your Azure resource, deployment and Azure API authentication separately. This does not establish support for consumer Copilot, Microsoft 365 Copilot, or Foundry Agent Service project connections.

## Local execution

Use the [shared CLI onboarding flow](../docs/ONBOARDING.md) to register a service. Registration grants no recipient access, including to the registering owner. After registration, run `relay service connect --profile my-agent` and have the selected recipient approve the separate connection link. To connect your own account, approve that link while signed in to your account; there is no self-access option in the registration confirmation. Recipients can choose forms and/or SMS, expiry, and disconnect later. Select forms unless SMS is necessary. A connection for a particular external account must start with a temporary pairing session whose opaque account reference comes from your authenticated backend; reusable links cannot target an account.

Keep CLI storage, credentials and delivery private keys in private application software. Registration, locally generated QR codes, pairing, encrypted delivery consumption and acknowledgement stay outside the model tool loop. The public setup URL and QR contain no credentials.

```js
import { connectProviderTools } from './integrations/providers.mjs';

const relay = await connectProviderTools({profile: 'my-agent', connectionId: selectedConnectionId});
if (relay.status === 'setup_needed') {
  // Present relay.link in setup UI and reconnect after recipient approval.
} else {
  try {
    // azureClient is the application's Azure OpenAI Responses client.
    // deployment is an Azure model deployment supporting Responses function calling.
    const response = await azureClient.responses.create({
      model: deployment, input, tools: relay.microsoft, store: false,
    });
    const outputs = [];
    for (const item of response.output) {
      if (item.type !== 'function_call') continue;
      const result = await relay.execute(item.name, JSON.parse(item.arguments));
      outputs.push({type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result)});
    }
    // Continue with the original input, response.output and outputs as input,
    // tools: relay.microsoft and store: false. Bound the tool loop in your application.
  } finally {
    await relay.close();
  }
}
```

`relay.microsoft` contains capability-approved function declarations with JSON schemas. The executor rejects undeclared names; the relay reauthorizes every MCP call, including after disconnection. Registration authority and credentials are absent from function declarations and arguments. Recipient consent is still required before form submission or SMS disclosure. Keep results in memory and omit answers, tokens and private keys from logs.

## Remote MCP execution

Obtain the named-service resource with `relay service hosted-link --profile NAME`. Application software must register its own exact HTTPS callback and complete the relay OAuth authorization-code flow with PKCE S256, state validation and that resource. Keep state, verifier and tokens in private software storage. The relay supports discovery and registration; the helper below does not run browser authorization or obtain tokens.

```js
import { hostedProviderConfig } from './integrations/providers.mjs';

const tool = hostedProviderConfig('microsoft', {resource, accessToken});
// Private application configuration: contains authentication. Never print or return from a tool.
const response = await azureClient.responses.create({
  model: deployment, input, tools: [tool], store: false,
});
```

Microsoft's Responses remote MCP interface uses `headers.Authorization` with a bearer token. The helper requires a named-service HTTPS URL and an OAuth `smsa_` access token; direct pairing and service credentials are rejected. It sets `require_approval: 'always'`; handle each `mcp_approval_request` in your application's approval UI before continuing with the matching `mcp_approval_response`. This approval concerns the outgoing tool call and does not replace the recipient's consent to answer. Do not automatically approve all calls. Keep passing the private tool configuration on subsequent turns as required by your client.

An authorization header is token transport, not an OAuth login flow. Your application owns the OAuth callback; the synthetic callback in the fixture is neither a Microsoft callback nor a production deployment. Azure API credentials authenticate to Microsoft and are distinct from the relay OAuth access token. Refresh follows the [static-credential policy](../docs/API.md#hosted-oauth-mcp) merged in PR #27: newly issued credentials remain unchanged on refresh until explicit revocation or an approved connection expiry. It deliberately supersedes the older refresh-rotation wording in issue #23.

## Acceptance

The Microsoft profile in `contracts/provider-authorization.json` tests discovery, exact callback and resource binding, PKCE rejection, forms-only capability narrowing, function dispatch and remote MCP request operations, stable refresh and revocation against both relay runtimes. Unit tests check the Microsoft declaration/header shapes and reject unapproved execution and invalid authority. Shared onboarding and SDK tests cover registration, owner-access choice, pairing, reusable links, encrypted delivery, acknowledgement retries and revocation; no Microsoft inference call is made by these tests.

Before releasing the integration, verify a live Azure function-call/result exchange and authenticated remote MCP call on the chosen deployment, the actual application's redirects and disconnection, first sign-in through Android/browser, physical Android App Links and installation handoff, notification permission, and per-request consent. Service disable, credential rotation and operator/recipient deletion must also be verified against the deployment. These live and physical checks remain pending under [issue #23](https://github.com/bluegrain-llc/sms-reader/issues/23), which this implementation PR does not close. Marketplace approval is tracked separately.
