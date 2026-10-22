import { randomUUID } from "node:crypto";
import { DEFAULT_AGENTS, type AgentDefinition, type AgentResponse } from "@atlas/agents";
import { inferIntent } from "@atlas/kernel";
import { memorySearchResultsToCognitiveItems, runCognitiveCycle } from "@atlas/cognition";
import { DefaultContextLoader, type AppContext, type ProjectContext, type UserContext } from "@atlas/context";
import { InMemoryStore, LongTermMemory, ShortTermMemory, type MemoryStore } from "@atlas/memory";
import { redactText } from "@atlas/privacy";
import { DEFAULT_SECURITY_POLICY, SecurityGuard, type SecurityPolicy } from "@atlas/security";
import {
  auditLogTool,
  databaseDeleteAllTool,
  echoTool,
  memorySearchTool,
  ToolRegistry,
  type ToolDefinition,
  type ToolInput,
  type ToolOutput
} from "@atlas/tools";
// Reference session runtime. Project-memory CLI consumers use the agent entry point.

export interface RuntimeConfig {
  projectId?: string;
  projectName?: string;
  defaultAgentId?: string;
  securityPolicy?: SecurityPolicy;
}

export interface RuntimeEvent {
  id: string;
  type:
    | "session.started"
    | "context.loaded"
    | "intent.inferred"
    | "message.received"
    | "memory.attached"
    | "memory.created"
    | "cognition.updated"
    | "security.attached"
    | "agent.registered"
    | "tool.registered"
    | "tool.executed"
    | "agent.response";
  timestamp: string;
  payload?: Record<string, unknown>;
}

export interface RuntimeSession {
  id: string;
  projectId: string;
  activeAgentId: string;
  startedAt: string;
  updatedAt: string;
  events: RuntimeEvent[];
  context?: AppContext;
}

export interface RuntimeResult {
  session: RuntimeSession;
  response: AgentResponse;
  context: AppContext;
  events: RuntimeEvent[];
}

export class CoreRuntime {
  private readonly agents = new Map<string, AgentDefinition>();
  private readonly tools = new ToolRegistry();
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly contextLoader = new DefaultContextLoader();
  private readonly config: Required<Pick<RuntimeConfig, "projectId" | "projectName" | "defaultAgentId">>;
  private shortTermMemory: ShortTermMemory;
  private longTermMemory: LongTermMemory;
  private securityGuard: SecurityGuard;

  constructor(config: RuntimeConfig = {}) {
    const store: MemoryStore = new InMemoryStore();
    this.config = {
      projectId: config.projectId ?? "lmti-playground",
      projectName: config.projectName ?? "LMTI Playground",
      defaultAgentId: config.defaultAgentId ?? "developer"
    };
    this.shortTermMemory = new ShortTermMemory(store, { projectId: this.config.projectId });
    this.longTermMemory = new LongTermMemory(store, { projectId: this.config.projectId });
    this.securityGuard = new SecurityGuard(config.securityPolicy ?? DEFAULT_SECURITY_POLICY);
  }

  startSession(options: { agentId?: string; projectId?: string } = {}): RuntimeSession {
    const session: RuntimeSession = {
      id: randomUUID(),
      projectId: options.projectId ?? this.config.projectId,
      activeAgentId: options.agentId ?? this.config.defaultAgentId,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: []
    };
    this.record(session, "session.started", { agentId: session.activeAgentId });
    this.sessions.set(session.id, session);
    return session;
  }

  async sendMessage(sessionId: string, message: string, agentId?: string): Promise<RuntimeResult> {
    const session = this.requireSession(sessionId);
    if (agentId) {
      session.activeAgentId = agentId;
    }

    const messagePreview = redactText(message).slice(0, 120);
    const inferredIntent = inferIntent(message);
    this.record(session, "message.received", { messagePreview, length: message.length });
    this.record(session, "intent.inferred", { primaryIntent: inferredIntent.primaryIntent, confidence: inferredIntent.confidence });
    await this.shortTermMemory.add({
      kind: "task",
      title: `User message: ${messagePreview.slice(0, 64)}`,
      content: message,
      source: "runtime.message",
      tags: ["session", session.activeAgentId],
      importance: 0.5
    });
    this.record(session, "memory.created", { scope: "short_term" });

    const remembered = extractRememberedContent(message);
    if (remembered) {
      const rememberedPreview = redactText(remembered).slice(0, 64);
      await this.longTermMemory.add({
        kind: "preference",
        title: `Remembered: ${rememberedPreview}`,
        content: remembered,
        source: "runtime.remember",
        tags: ["remembered", session.activeAgentId],
        importance: 0.8,
        confidence: "high"
      });
      this.record(session, "memory.created", { scope: "long_term" });
    }

    const context = await this.loadContext(session.id, {
      message,
      currentGoal: message
    });
    this.updateCognitiveState(session, message, context, inferredIntent);
    const agent = this.requireAgent(session.activeAgentId);

    const routedResponse = await this.tryRouteRuntimeIntent(session, agent, message, context, remembered);
    if (routedResponse) {
      this.record(session, "agent.response", { agentId: routedResponse.agentId, routed: true });
      return {
        session,
        response: routedResponse,
        context,
        events: [...session.events]
      };
    }

    const response = await agent.respond(message, {
      sessionId: session.id,
      projectId: session.projectId,
      shortTermMemory: this.shortTermMemory,
      longTermMemory: this.longTermMemory,
      executeTool: (toolName, input) => this.execute(session.id, toolName, input)
    });

    this.record(session, "agent.response", { agentId: agent.id });
    return {
      session,
      response,
      context,
      events: [...session.events]
    };
  }

  async loadContext(sessionId: string, user: Partial<UserContext> = {}): Promise<AppContext> {
    const session = this.requireSession(sessionId);
    const project: ProjectContext = {
      projectId: session.projectId,
      name: this.config.projectName
    };
    const context = await this.contextLoader.load({
      project,
      user,
      activeAgentId: session.activeAgentId,
      securityPolicy: this.securityGuard.getPolicy(),
      memorySearch: (query) => this.longTermMemory.search(query, { limit: 5 })
    });
    session.context = context;
    this.record(session, "context.loaded", { relatedMemory: context.relatedMemory.length });
    return context;
  }

  attachMemory(memory: { shortTerm?: ShortTermMemory; longTerm?: LongTermMemory }): this {
    if (memory.shortTerm) {
      this.shortTermMemory = memory.shortTerm;
    }
    if (memory.longTerm) {
      this.longTermMemory = memory.longTerm;
    }
    for (const session of this.sessions.values()) {
      this.record(session, "memory.attached");
    }
    return this;
  }

  attachSecurityPolicy(policy: SecurityPolicy): this {
    this.securityGuard.attachPolicy(policy);
    for (const session of this.sessions.values()) {
      this.record(session, "security.attached", { policyId: policy.id });
    }
    return this;
  }

  registerAgent(agent: AgentDefinition): this {
    this.agents.set(agent.id, agent);
    for (const session of this.sessions.values()) {
      this.record(session, "agent.registered", { agentId: agent.id });
    }
    return this;
  }

  registerTool(tool: ToolDefinition): this {
    this.tools.register(tool);
    for (const session of this.sessions.values()) {
      this.record(session, "tool.registered", { toolName: tool.name });
    }
    return this;
  }

  async execute(sessionId: string, toolName: string, input: ToolInput = {}): Promise<ToolOutput> {
    const session = this.requireSession(sessionId);
    const result = await this.tools.execute(toolName, input, {
      securityGuard: this.securityGuard,
      shortTermMemory: this.shortTermMemory,
      longTermMemory: this.longTermMemory
    });
    this.record(session, "tool.executed", { toolName, ok: result.ok });
    return result;
  }

  getShortTermMemory(): ShortTermMemory {
    return this.shortTermMemory;
  }

  getLongTermMemory(): LongTermMemory {
    return this.longTermMemory;
  }

  getSecurityGuard(): SecurityGuard {
    return this.securityGuard;
  }

  listAgents(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  listTools(): ToolDefinition[] {
    return this.tools.list();
  }

  private requireSession(sessionId: string): RuntimeSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Runtime session not found: ${sessionId}`);
    }
    return session;
  }

  private requireAgent(agentId: string): AgentDefinition {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not registered: ${agentId}`);
    }
    return agent;
  }

  private updateCognitiveState(
    session: RuntimeSession,
    message: string,
    context: AppContext,
    inferredIntent: ReturnType<typeof inferIntent>
  ): void {
    const cognition = runCognitiveCycle({
      projectId: session.projectId,
      task: message,
      inferredIntent,
      contextItems: memorySearchResultsToCognitiveItems(context.relatedMemory),
      subscribers: [
        { id: "context_builder", role: "local" },
        { id: "runtime_session", role: "local" },
        { id: "agent_response_planner", role: "local" },
        { id: "privacy_audit", role: "local" }
      ]
    });
    this.record(session, "cognition.updated", {
      focusId: cognition.focus.focusId,
      selectedFocus: redactText(cognition.focus.selectedFocus).slice(0, 160),
      phi: cognition.state.integratedInformation.normalizedPhi,
      predictionError: cognition.predictionError.error
    });
  }

  private async tryRouteRuntimeIntent(
    session: RuntimeSession,
    agent: AgentDefinition,
    message: string,
    context: AppContext,
    remembered?: string
  ): Promise<AgentResponse | undefined> {
    if (remembered) {
      return {
        agentId: agent.id,
        role: agent.role,
        message: "Saved to memory."
      };
    }

    if (isAuditLogIntent(message)) {
      const result = await this.execute(session.id, "audit.logs", { limit: 20 });
      return {
        agentId: agent.id,
        role: agent.role,
        message: result.ok
          ? `Security approved.\nAudit log:\n${formatToolData(result.data)}`
          : `Security blocked. ${result.error ?? "Could not read audit log."}`,
        toolResults: [result]
      };
    }

    if (isDatabaseDeleteIntent(message)) {
      const result = await this.execute(session.id, "database.deleteAll", {});
      return {
        agentId: agent.id,
        role: agent.role,
        message: result.ok
          ? "[SECURITY WARNING] Database delete tool was approved, but this playground tool is a no-op."
          : `Security blocked. Missing admin/database permission.\nReason: ${result.error ?? "Denied by security policy."}`,
        toolResults: [result]
      };
    }

    if (isProjectRecallIntent(message)) {
      const results = context.relatedMemory.length > 0 ? context.relatedMemory : await this.longTermMemory.search(message, { limit: 3 });
      const answer = formatProjectMemoryAnswer(results[0]?.record?.content);
      return {
        agentId: agent.id,
        role: agent.role,
        message: answer ?? "No matching memory found for this question."
      };
    }

    return undefined;
  }

  private record(session: RuntimeSession, type: RuntimeEvent["type"], payload: Record<string, unknown> = {}): RuntimeEvent {
    const event: RuntimeEvent = {
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      payload
    };
    session.updatedAt = event.timestamp;
    session.events.push(event);
    return event;
  }
}

export function createDefaultRuntime(config: RuntimeConfig = {}): CoreRuntime {
  const runtime = new CoreRuntime(config);
  for (const agent of DEFAULT_AGENTS) {
    runtime.registerAgent(agent);
  }
  for (const tool of [echoTool, memorySearchTool, auditLogTool, databaseDeleteAllTool]) {
    runtime.registerTool(tool);
  }
  return runtime;
}

function extractRememberedContent(message: string): string | undefined {
  const normalized = normalizeSearchText(message);
  const markers = ["remember that", "remember"];

  for (const marker of markers) {
    const index = normalized.indexOf(marker);
    if (index >= 0) {
      const content = message.slice(index + marker.length).replace(/^[:\s]+/, "").trim();
      return content.length > 0 ? content : undefined;
    }
  }

  return undefined;
}

function isAuditLogIntent(message: string): boolean {
  const normalized = normalizeSearchText(message);
  return normalized.includes("audit log") && /\b(run|read|show)\b/i.test(normalized);
}

function isDatabaseDeleteIntent(message: string): boolean {
  const normalized = normalizeSearchText(message);
  const hasDelete = /\b(delete|remove|drop|clear)\b/i.test(normalized);
  const hasDatabase = /\b(database|db)\b/i.test(normalized);
  const hasWideScope = /\b(all|everything|entire|whole)\b/i.test(normalized);
  return hasDelete && hasDatabase && hasWideScope;
}

function isProjectRecallIntent(message: string): boolean {
  const normalized = normalizeSearchText(message);
  const asksProject = /\b(project)\b/i.test(normalized);
  const asksWhat = /\b(what|working on|is)\b/i.test(normalized);
  return asksProject && asksWhat;
}

function formatProjectMemoryAnswer(content?: string): string | undefined {
  if (!content) {
    return undefined;
  }

  const trimmed = content.trim().replace(/\s+\.$/, ".");
  return ensureSentence(trimmed.charAt(0).toUpperCase() + trimmed.slice(1));
}

function formatToolData(data: unknown): string {
  if (!Array.isArray(data)) {
    return JSON.stringify(data ?? null, null, 2);
  }

  if (data.length === 0) {
    return "[]";
  }

  return JSON.stringify(data.slice(0, 20), null, 2);
}

function ensureSentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}
