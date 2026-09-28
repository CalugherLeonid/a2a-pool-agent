import type { EvalPack } from '../eval-pack.js';
import type { RatchetSystem } from '../ratchet.js';
import type { Sandbox } from '../sandbox.js';
import { MetaToolRegistry } from './registry.js';
import { ReadSourceTool, type ReadSourceInput, type ReadSourceOutput } from './tools/read-source.js';
import { EditSourceTool, type EditSourceInput, type EditSourceOutput } from './tools/edit-source.js';
import { CreateToolTool, type CreateToolInput, type CreateToolOutput } from './tools/create-tool.js';
import { HotReloadTool, type HotReloadInput, type HotReloadOutput } from './tools/hot-reload.js';
import { createLogger } from '../../observability/logger.js';

export interface MetaToolKitDeps {
  registry: MetaToolRegistry;
  sandbox?: Sandbox;
  evalPack?: EvalPack;
  ratchetSystem?: RatchetSystem;
}

export type ExecutionTier = 'system1' | 'system2';

/**
 * MetaToolKit manages and exposes meta-tools.
 *
 * CRITICAL ACCESS CONTROL:
 * Meta-Tools (especially write operations like edit_source, create_tool, hot_reload)
 * are STRICTLY available to System 2 (Reflective / Morphling evolution),
 * and NEVER accessible to System 1 (Deterministic Fast Path).
 */
export class MetaToolKit {
  private readonly log = createLogger('meta-tool-kit');
  public readonly readSourceTool: ReadSourceTool;
  public readonly editSourceTool: EditSourceTool;
  public readonly createToolTool: CreateToolTool;
  public readonly hotReloadTool: HotReloadTool;

  constructor(private readonly deps: MetaToolKitDeps) {
    this.readSourceTool = new ReadSourceTool(deps.registry);
    this.editSourceTool = new EditSourceTool(deps.registry);
    this.createToolTool = new CreateToolTool(
      deps.registry,
      deps.sandbox,
      deps.evalPack,
      deps.ratchetSystem,
    );
    this.hotReloadTool = new HotReloadTool(
      deps.registry,
      deps.sandbox,
      deps.evalPack,
      deps.ratchetSystem,
    );
  }

  /**
   * Invokes read_source.
   * Allowed from System 2. If System 1 attempts invocation, it is rejected.
   */
  readSource(input: ReadSourceInput, callerTier: ExecutionTier = 'system2'): ReadSourceOutput {
    this.enforceSystem2(callerTier, 'read_source');
    return this.readSourceTool.execute(input);
  }

  /**
   * Invokes edit_source.
   * Proposes modifications (computes unified diff & runs static security audit).
   * NEVER applies code directly (`applied: false`).
   * Prohibited from System 1.
   */
  editSource(input: EditSourceInput, callerTier: ExecutionTier = 'system2'): EditSourceOutput {
    this.enforceSystem2(callerTier, 'edit_source');
    return this.editSourceTool.execute(input);
  }

  /**
   * Invokes create_tool.
   * Mandatory pass through SandboxSecurityGuard -> EvalPack -> RatchetSystem
   * before registration.
   * Prohibited from System 1.
   */
  async createTool(
    input: CreateToolInput,
    callerTier: ExecutionTier = 'system2',
  ): Promise<CreateToolOutput> {
    this.enforceSystem2(callerTier, 'create_tool');
    this.log.info({ toolId: input.id, callerTier }, 'System 2 invoking create_tool meta-tool');
    return this.createToolTool.execute(input);
  }

  /**
   * Invokes hot_reload.
   * Re-evaluates candidate through RatchetSystem and hot-reloads only upon acceptance.
   * Prohibited from System 1.
   */
  async hotReload(
    input: HotReloadInput,
    callerTier: ExecutionTier = 'system2',
  ): Promise<HotReloadOutput> {
    this.enforceSystem2(callerTier, 'hot_reload');
    this.log.info({ toolId: input.toolId, callerTier }, 'System 2 invoking hot_reload meta-tool');
    return this.hotReloadTool.execute(input);
  }

  /**
   * Enforces zero-trust boundary: System 1 must NEVER access meta-tools.
   */
  private enforceSystem2(tier: ExecutionTier, toolName: string): void {
    if (tier !== 'system2') {
      const errorMsg = `Access Denied: Meta-Tool '${toolName}' is strictly reserved for System 2 reflective reasoning and forbidden on System 1 fast path.`;
      this.log.warn({ tier, toolName }, errorMsg);
      throw new Error(errorMsg);
    }
  }

  getRegistry(): MetaToolRegistry {
    return this.deps.registry;
  }
}
