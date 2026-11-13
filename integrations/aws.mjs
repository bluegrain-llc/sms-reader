import { connectProviderTools } from './providers.mjs';

/** Adapt an already authorized relay provider session to Bedrock Converse. */
export function bedrockTools(relay) {
  const allowed = new Set(relay.openai.map(tool => tool.name));
  const toolConfig = {tools: relay.openai.map(tool => ({toolSpec: {
    name: tool.name,
    ...(tool.description ? {description: tool.description} : {}),
    inputSchema: {json: tool.parameters},
  }}))};
  return {
    toolConfig,
    async executeToolUse(toolUse) {
      if (!toolUse || typeof toolUse.toolUseId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(toolUse.toolUseId)
        || typeof toolUse.name !== 'string' || !allowed.has(toolUse.name)
        || !toolUse.input || typeof toolUse.input !== 'object' || Array.isArray(toolUse.input)) {
        throw Error('invalid_or_unapproved_tool_use');
      }
      // Only a caller result enters the conversation. Transport/authentication errors stay in software.
      const result = await relay.execute(toolUse.name, toolUse.input);
      return {toolResult: {
        toolUseId: toolUse.toolUseId,
        content: [{json: {
          content: result.content,
          ...(result.structuredContent === undefined ? {} : {structuredContent: result.structuredContent}),
          ...(result.isError === undefined ? {} : {isError: result.isError}),
        }}],
      }};
    },
  };
}

/** Reads the explicitly selected recipient credential from private CLI storage. */
export async function connectBedrockTools(options) {
  const relay = await connectProviderTools(options);
  if (relay.status === 'setup_needed') return relay;
  try {
    return {...bedrockTools(relay), status: relay.status, close: relay.close};
  } catch (error) {
    await relay.close();
    throw error;
  }
}
