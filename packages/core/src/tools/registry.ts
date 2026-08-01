import { ConfigurationError } from '../errors/errors.js'
import type { ToolDefinition } from '../providers/provider.js'
import type { AnyTool } from './tool.js'

/**
 * An immutable, name-indexed view over an agent's tools.
 *
 * Built once when the agent is constructed, so a duplicate tool name is a
 * construction-time error rather than a confusing provider rejection later.
 */
export class ToolRegistry {
  private readonly byName: ReadonlyMap<string, AnyTool>

  constructor(tools: readonly AnyTool[] = []) {
    const map = new Map<string, AnyTool>()
    for (const t of tools) {
      if (map.has(t.name)) {
        throw new ConfigurationError(`Two tools are both named "${t.name}".`, {
          hint: 'Tool names must be unique within an agent — the model refers to them by name.',
          details: { name: t.name },
        })
      }
      map.set(t.name, t)
    }
    this.byName = map
  }

  get size(): number {
    return this.byName.size
  }

  get isEmpty(): boolean {
    return this.byName.size === 0
  }

  get(name: string): AnyTool | undefined {
    return this.byName.get(name)
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  names(): readonly string[] {
    return [...this.byName.keys()]
  }

  all(): readonly AnyTool[] {
    return [...this.byName.values()]
  }

  /**
   * The wire-format definitions to send to the model, resolved in parallel.
   * Returns `undefined` when there are no tools, so callers can omit the field
   * entirely — some providers reject an empty `tools` array.
   */
  async definitions(): Promise<readonly ToolDefinition[] | undefined> {
    if (this.isEmpty) return undefined
    return Promise.all(this.all().map((t) => t.toDefinition()))
  }
}
