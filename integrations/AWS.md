# AWS Bedrock integration

The adapter targets Amazon Bedrock's developer **Converse** API with client-side tool execution. The supported surface was checked against the official [client-side tool guide](https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use-client-side.html), [ToolSpecification](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolSpecification.html) and [ToolResultBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolResultBlock.html) on 2026-11-13. Select a model and region that support Converse tool use; this helper does not invoke AWS, configure IAM or select a model.

## Register and connect

Use the CLI's [shared onboarding flow](../docs/ONBOARDING.md) to register a service. The CLI displays a public HTTPS link and a locally generated QR. Registration grants no account access. After registration, run `relay service connect --profile my-agent` and approve the separate connection screen, including when connecting your own account. Recipients can also use the reusable service link. Select forms/SMS permissions and an expiry during connection approval. The connect command saves and acknowledges encrypted credential deliveries; run `relay service deliveries --profile my-agent` to collect deliveries after reusable-link approval. A specific external account requires an opaque reference supplied by the application's authenticated backend and a temporary pairing session with `--external-account-ref`; never use an email or Firebase identity as that reference.

Keep the CLI profile directory private, explicitly select one recipient connection in application software, and keep AWS credentials in the AWS SDK's credential provider chain. Neither credential belongs in prompts, JSON schemas, tool arguments, logs or model-visible settings. Registration, pairing, key delivery and connection management are software operations outside the model tool loop. Use forms unless SMS is necessary. The same service can connect to several recipients; the model does not select their connection IDs.

## Converse tool loop

Install `@aws-sdk/client-bedrock-runtime` in your application separately. From this repository checkout, use:

```js
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { connectBedrockTools } from './integrations/aws.mjs';

const relay = await connectBedrockTools({profile:'my-agent', connectionId:selectedConnectionId});
if (relay.status === 'setup_needed') {
  // Present relay.link in your application's setup UI when available, then reconnect after approval.
} else {
  const bedrock = new BedrockRuntimeClient({region});
  try {
    // modelId and the initial messages are application inputs. Choose a tool-capable model.
    for (let turn = 0; turn < 8; turn++) {
      const response = await bedrock.send(new ConverseCommand({modelId, messages, toolConfig:relay.toolConfig}));
      const message = response.output.message;
      messages.push(message);
      if (response.stopReason !== 'tool_use') break;
      const results = [];
      for (const block of message.content) {
        if (block.toolUse) results.push(await relay.executeToolUse(block.toolUse));
      }
      if (!results.length) throw Error('Missing Bedrock tool requests');
      messages.push({role:'user',content:results});
    }
    // Surface the last assistant message, or the loop limit, through your application UI.
  } finally {
    await relay.close();
    bedrock.destroy();
  }
}
```

The declarations use Bedrock's `toolConfig.tools[].toolSpec` and `inputSchema.json`. The helper preserves each `toolUseId`, groups the MCP caller result under a JSON result block and omits MCP transport metadata. It omits the optional Bedrock `status` field because support depends on the selected model; MCP failures retain `isError` inside the JSON result. Transport/authentication errors reject the call so application software handles them without returning raw diagnostics to the model. Do not catch an exception and put its message into the conversation.

Process every requested tool block and preserve the complete assistant message before supplying the results as the next user message. Keep results in memory and bound the loop. Pending requests are asynchronous: `inspect_request` and the result tools can be called on later turns after recipient action. `phone_setup_needed` or `waiting_for_service` means the connection exists but setup is incomplete; report that state in application UI. Every form submission and SMS disclosure still requires recipient consent. Saved declarations cannot bypass server authorization: each MCP call rechecks capabilities, connection isolation, expiry and revocation.

The lower-level `bedrockTools(relay)` accepts an already authorized session returned by `connectProviderTools`. This allows application-owned transport integration without reading credentials into a model tool. It is not a mechanism to grant capabilities or authenticate a recipient.

## Other AWS surfaces and acceptance

Bedrock's [server-side tools](https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use-server-side.html) use Lambda or AgentCore Gateway ARN connectors. AgentCore [MCP targets](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html) have their own outbound authorization configuration. Those are separate integrations: this adapter does not provision a gateway, configure an identity provider, claim direct remote-MCP support in Converse, or implement a hosted AWS OAuth flow. Direct pairing credentials are bearer credentials, not OAuth. Hosted AgentCore support requires a separately verified authorization-code/PKCE/resource-binding integration; do not substitute client-credentials authorization for a recipient's consent.

Unit tests cover Bedrock schemas, tool/result ID binding, metadata omission, malformed and unapproved calls, MCP failures and missing setup. The AWS conformance cases use real MCP clients against both backends to test forms-only declarations, blocked SMS, idempotent request creation, result inspection, connection isolation, service disable and recipient disconnection. They share the onboarding suite's registration, encrypted delivery, concurrent approval, reusable-link, expiry, key retirement and account-deletion coverage. These tests make no AWS inference requests and do not prove live AWS acceptance.

Before an integration release, verify a live Converse tool/result exchange with the selected model/region and real recipient approval, plus explicit disconnect, service/key revocation and process-restart recovery. Physical Android App Links, first sign-in, installation handoff, notification permission and per-request consent remain pending under [issue #24](https://github.com/bluegrain-llc/sms-reader/issues/24). Hosted AgentCore OAuth acceptance and marketplace publication, if selected, are separate gates. The relay's current static OAuth credential policy is documented in [API.md](../docs/API.md#hosted-oauth-mcp); this client-side adapter does not change that policy.
