# Provider adapters

`connectProviderTools` reads one selected recipient connection from private CLI storage, connects to `/mcp`, and produces function declarations for OpenAI, Anthropic and Google. No credential is returned in those declarations. Registration, service management and delivery consumption run in software outside the model tool loop. Configure the model provider's SDK separately; these adapters make no inference calls and print no responses.

```js
import { connectProviderTools } from './integrations/providers.mjs';
const relay = await connectProviderTools({ profile: 'my-agent', connectionId: selectedConnectionId });
// Pass relay.openai, relay.anthropic, or relay.google to the provider's tool interface.
// Execute a provider-selected function with relay.execute(name, args).
// Send only that authorized result back to the model, then close on shutdown.
```

OpenAI Responses uses function tools; Anthropic Messages uses tools with `input_schema`; Google GenerateContent uses `functionDeclarations` with `parametersJsonSchema`. Preserve provider tool-call IDs when returning the result, according to the provider's SDK. The relay server rechecks permissions on every call. The SDK convenience clients also provide direct REST request/result/event methods.

The shapes follow the [OpenAI tool and MCP guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), [Anthropic MCP connector guide](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector), and [Google function calling guide](https://aistudio.google.com/docs/function-calling). Test each provider's live authorization and function-calling flow before publishing an integration release. The tests in this repository validate declarations and dispatch boundaries without sending inference requests.

These are developer integrations. Hosted connections use the separate OAuth endpoints described below; a direct `smsr_` bearer connection is not an OAuth implementation. Microsoft, AWS and xAI are tracked in issues [#23](https://github.com/bluegrain-llc/sms-reader/issues/23), [#24](https://github.com/bluegrain-llc/sms-reader/issues/24), and [#25](https://github.com/bluegrain-llc/sms-reader/issues/25).

## Hosted connections

Register the integration’s named service with the CLI, then run `relay service hosted-link --profile NAME`. Configure that public named-service URL as the provider’s remote MCP endpoint. Discovery, dynamic/client-metadata registration, Google/Firebase sign-in, one explicit Connect confirmation, PKCE and token rotation then use the relay server. Keep provider-managed OAuth tokens outside model arguments and prompts. No recipient credentials or delivery private keys are part of the provider’s model configuration.

- **OpenAI:** use an authenticated remote MCP app/connector with the returned URL. The server publishes authorization-server and protected-resource discovery, PKCE S256 and a DCR endpoint. Follow the [official hosted authentication requirements](https://developers.openai.com/plugins/build/auth).
- **Anthropic:** configure the named endpoint in the hosted remote MCP connection. For API integrations, obtain the connection token through OAuth in application software and pass it through the connector’s authentication setting, following the [official MCP connector guide](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector).
- **Google:** use the returned HTTPS endpoint in [Gemini Apps Developer Mode](https://developers.google.com/connected-apps/mcp/dev-mode/usage) and configure the requested relay scopes. The discovery document includes the registration endpoint required by Google’s [Connected Apps OAuth guide](https://developers.google.com/connected-apps/mcp/oauth). Connected Console enrollment and publication follow Google’s external preview/review process.

Use `forms` unless SMS is needed; the service must have declared SMS before approval can include it. The approval screen shows the configured service and requesting client, and the user can narrow the displayed permissions. A phone handoff QR contains a public consent-session URL. The original browser waits for the same signed-in owner’s approval. Test sign-in, resource discovery, cancellation, refresh, narrow scopes and disconnection in each provider before release. No provider registration, inference traffic or marketplace submission has been performed by the repository tests.
