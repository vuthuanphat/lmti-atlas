/** Packaged, fixed read boundary. No general CLI or user-selected command. */
import { agentContextCommand, readAgentContextRequest } from '../packages/cli/src/agent-context.js';

try {
  if (process.argv.length !== 3 || process.argv[2] !== 'agent-context') throw new Error('INVALID_INPUT');
  const result = await agentContextCommand(await readAgentContextRequest());
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stdout.write('{"schema":"lmti.agent.knowledge.v1","error":"KNOWLEDGE_REQUEST_DENIED"}\n');
  process.exitCode = 3;
}
