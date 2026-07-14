/**
 * Tiny declarative flag parser for the CLI. Supports `--flag value`,
 * `--flag=value`, repeatable string flags, and typed values. Anything not
 * matching a declared flag is a positional; unknown `--flags` are errors
 * so typos never silently change behavior.
 */

export interface FlagSpec {
  name: string;
  kind: "string" | "number" | "boolean";
  repeatable?: boolean;
  /** Allowed values, for enum-like flags such as --format. */
  choices?: string[];
}

export interface ParsedArgs {
  positionals: string[];
  strings: Map<string, string>;
  numbers: Map<string, number>;
  booleans: Set<string>;
  lists: Map<string, string[]>;
  error: string | null;
}

export function parseArgs(argv: string[], specs: FlagSpec[]): ParsedArgs {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const out: ParsedArgs = {
    positionals: [],
    strings: new Map(),
    numbers: new Map(),
    booleans: new Set(),
    lists: new Map(),
    error: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] as string;
    if (!raw.startsWith("--")) {
      out.positionals.push(raw);
      continue;
    }
    let name = raw.slice(2);
    let inlineValue: string | null = null;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const spec = byName.get(name);
    if (!spec) {
      out.error = `unknown flag "--${name}"`;
      return out;
    }
    if (spec.kind === "boolean") {
      if (inlineValue !== null) {
        out.error = `flag "--${name}" takes no value`;
        return out;
      }
      out.booleans.add(name);
      continue;
    }
    let value = inlineValue;
    if (value === null) {
      i += 1;
      if (i >= argv.length) {
        out.error = `flag "--${name}" requires a value`;
        return out;
      }
      value = argv[i] as string;
    }
    if (spec.choices && !spec.choices.includes(value)) {
      out.error = `flag "--${name}" must be one of: ${spec.choices.join(", ")}`;
      return out;
    }
    if (spec.kind === "number") {
      const n = value.trim() === "" ? NaN : Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        out.error = `flag "--${name}" requires a non-negative integer, got "${value}"`;
        return out;
      }
      out.numbers.set(name, n);
      continue;
    }
    if (spec.repeatable) {
      const list = out.lists.get(name) ?? [];
      list.push(value);
      out.lists.set(name, list);
    } else {
      if (out.strings.has(name)) {
        out.error = `flag "--${name}" was given more than once`;
        return out;
      }
      out.strings.set(name, value);
    }
  }

  return out;
}
