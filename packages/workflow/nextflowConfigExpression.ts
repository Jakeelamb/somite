const MAX_CONFIG_EXPRESSION_BYTES = 16 * 1024;
const MAX_CONFIG_EXPRESSION_TOKENS = 1_024;
const MAX_CONFIG_EXPRESSION_NODES = 512;
const MAX_CONFIG_EXPRESSION_DEPTH = 128;
const MAX_CONFIG_VALUE_BYTES = 8 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type NextflowConfigScalar = string | number | boolean | null;

export type NextflowConfigExpressionContext = Readonly<{
  parameters: Readonly<Record<string, NextflowConfigScalar>>;
  environment: Readonly<Record<string, string | undefined>>;
}>;

export type NextflowConfigExpressionResolution =
  | Readonly<{
      status: "resolved";
      value: NextflowConfigScalar;
      parameters: readonly string[];
      environment: readonly string[];
    }>
  | Readonly<{
      status: "unresolved";
      reason: string;
      parameters: readonly string[];
      environment: readonly string[];
    }>;

export type NextflowConfigScalarDefaults = Readonly<{
  values: Readonly<Record<string, NextflowConfigScalar>>;
  unresolved: readonly string[];
}>;

type Token = Readonly<{
  kind: "identifier" | "string" | "bang" | "and" | "or" | "question" | "colon" | "dot" | "left_paren" | "right_paren" | "comma" | "eof";
  offset: number;
  value?: string;
  interpolated?: boolean;
}>;

type Expression =
  | Readonly<{ kind: "literal"; value: NextflowConfigScalar; interpolated?: boolean }>
  | Readonly<{ kind: "parameter"; name: string }>
  | Readonly<{ kind: "environment"; name: string }>
  | Readonly<{ kind: "not"; operand: Expression }>
  | Readonly<{ kind: "and" | "or"; left: Expression; right: Expression }>
  | Readonly<{ kind: "ternary"; condition: Expression; yes: Expression; no: Expression }>
  | Readonly<{ kind: "starts_with"; value: Expression; prefix: string }>;

type Evaluation =
  | Readonly<{ known: true; value: NextflowConfigScalar }>
  | Readonly<{ known: false; reason: string }>;

class ExpressionFailure extends Error {}

function printableValue(value: string) {
  const bytes = encoder.encode(value);
  return bytes.byteLength <= MAX_CONFIG_VALUE_BYTES && [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point >= 32 && point !== 127;
  });
}

function identifierStart(character: string | undefined) {
  return character !== undefined && /[A-Za-z_]/.test(character);
}

function identifierPart(character: string | undefined) {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function stringToken(source: string, start: number): Readonly<{ token: Token; offset: number }> {
  const quote = source[start]!;
  let offset = start + 1;
  let value = "";
  while (offset < source.length) {
    const character = source[offset]!;
    if (character === quote) {
      if (!printableValue(value)) throw new ExpressionFailure("config expression string is not one bounded printable value");
      return {
        token: {
          kind: "string",
          offset: start,
          value,
          ...(quote === '"' && value.includes("$") ? { interpolated: true } : {}),
        },
        offset: offset + 1,
      };
    }
    if (character === "\\") {
      const escaped = source[offset + 1];
      if (escaped !== quote && escaped !== "\\" && escaped !== "$" ) {
        throw new ExpressionFailure("config expression string uses an unsupported escape");
      }
      value += escaped;
      offset += 2;
      continue;
    }
    if (character === "\n" || character === "\r") throw new ExpressionFailure("config expression string spans multiple lines");
    value += character;
    offset += 1;
  }
  throw new ExpressionFailure("config expression string is unterminated");
}

function tokenize(source: string) {
  const tokens: Token[] = [];
  let offset = 0;
  const push = (token: Token) => {
    if (tokens.length >= MAX_CONFIG_EXPRESSION_TOKENS) throw new ExpressionFailure("config expression has too many tokens");
    tokens.push(token);
  };
  while (offset < source.length) {
    const character = source[offset]!;
    if (/\s/.test(character)) {
      offset += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      const parsed = stringToken(source, offset);
      push(parsed.token);
      offset = parsed.offset;
      continue;
    }
    if (identifierStart(character)) {
      const start = offset++;
      while (identifierPart(source[offset])) offset += 1;
      push({ kind: "identifier", offset: start, value: source.slice(start, offset) });
      continue;
    }
    const pair = source.slice(offset, offset + 2);
    if (pair === "&&" || pair === "||") {
      push({ kind: pair === "&&" ? "and" : "or", offset });
      offset += 2;
      continue;
    }
    const kind = character === "!" ? "bang"
      : character === "?" ? "question"
        : character === ":" ? "colon"
          : character === "." ? "dot"
            : character === "(" ? "left_paren"
              : character === ")" ? "right_paren"
                : character === "," ? "comma"
                  : undefined;
    if (!kind) throw new ExpressionFailure(`config expression contains unsupported syntax at byte ${offset}`);
    push({ kind, offset });
    offset += 1;
  }
  push({ kind: "eof", offset: source.length });
  return tokens;
}

class Parser {
  readonly #tokens: readonly Token[];
  #index = 0;
  #nodes = 0;
  #depth = 0;

  constructor(tokens: readonly Token[]) {
    this.#tokens = tokens;
  }

  parse() {
    const expression = this.#ternary();
    if (this.#peek().kind !== "eof") throw new ExpressionFailure(`config expression has trailing syntax at byte ${this.#peek().offset}`);
    return expression;
  }

  #node<T extends Expression>(node: T): T {
    this.#nodes += 1;
    if (this.#nodes > MAX_CONFIG_EXPRESSION_NODES) throw new ExpressionFailure("config expression has too many nodes");
    return node;
  }

  #nested<T>(parse: () => T) {
    this.#depth += 1;
    if (this.#depth > MAX_CONFIG_EXPRESSION_DEPTH) throw new ExpressionFailure("config expression is nested too deeply");
    try {
      return parse();
    } finally {
      this.#depth -= 1;
    }
  }

  #peek() {
    return this.#tokens[this.#index]!;
  }

  #take(kind: Token["kind"]) {
    if (this.#peek().kind !== kind) throw new ExpressionFailure(`expected ${kind} at byte ${this.#peek().offset}`);
    return this.#tokens[this.#index++]!;
  }

  #optional(kind: Token["kind"]) {
    if (this.#peek().kind !== kind) return false;
    this.#index += 1;
    return true;
  }

  #ternary(): Expression {
    const condition = this.#or();
    if (!this.#optional("question")) return condition;
    const yes = this.#nested(() => this.#ternary());
    this.#take("colon");
    const no = this.#nested(() => this.#ternary());
    return this.#node({ kind: "ternary", condition, yes, no });
  }

  #or(): Expression {
    let expression = this.#and();
    while (this.#optional("or")) expression = this.#node({ kind: "or", left: expression, right: this.#and() });
    return expression;
  }

  #and(): Expression {
    let expression = this.#unary();
    while (this.#optional("and")) expression = this.#node({ kind: "and", left: expression, right: this.#unary() });
    return expression;
  }

  #unary(): Expression {
    if (this.#optional("bang")) return this.#node({ kind: "not", operand: this.#nested(() => this.#unary()) });
    return this.#postfix();
  }

  #postfix(): Expression {
    let expression = this.#primary();
    while (this.#optional("dot")) {
      const method = this.#take("identifier").value!;
      if (method !== "startsWith") throw new ExpressionFailure(`unsupported config expression method ${method}`);
      this.#take("left_paren");
      const prefix = this.#take("string");
      if (prefix.interpolated) throw new ExpressionFailure("startsWith prefix cannot be interpolated");
      this.#take("right_paren");
      expression = this.#node({ kind: "starts_with", value: expression, prefix: prefix.value! });
    }
    return expression;
  }

  #primary(): Expression {
    const token = this.#peek();
    if (token.kind === "string") {
      this.#index += 1;
      return this.#node({ kind: "literal", value: token.value!, ...(token.interpolated ? { interpolated: true } : {}) });
    }
    if (this.#optional("left_paren")) {
      const expression = this.#nested(() => this.#ternary());
      this.#take("right_paren");
      return expression;
    }
    const root = this.#take("identifier").value!;
    if (root === "true" || root === "false" || root === "null") {
      return this.#node({ kind: "literal", value: root === "null" ? null : root === "true" });
    }
    if (root === "params") {
      this.#take("dot");
      return this.#node({ kind: "parameter", name: this.#take("identifier").value! });
    }
    if (root === "System") {
      this.#take("dot");
      if (this.#take("identifier").value !== "getenv") throw new ExpressionFailure("only System.getenv is supported");
      this.#take("left_paren");
      const name = this.#take("string");
      if (name.interpolated) throw new ExpressionFailure("environment variable name cannot be interpolated");
      this.#take("right_paren");
      return this.#node({ kind: "environment", name: name.value! });
    }
    throw new ExpressionFailure(`unsupported config expression identifier ${root}`);
  }
}

function truthy(value: NextflowConfigScalar) {
  return value !== null && value !== false && value !== "" && value !== 0;
}

function interpolate(
  value: string,
  context: NextflowConfigExpressionContext,
  parameters: Set<string>,
): Evaluation {
  let unresolved: string | undefined;
  const rendered = value.replace(/\$\{params\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    parameters.add(name);
    const parameter = context.parameters[name];
    if (parameter === undefined || parameter === null) {
      unresolved = `config expression parameter ${name} has no scalar value`;
      return "";
    }
    return String(parameter);
  });
  if (unresolved) return { known: false, reason: unresolved };
  if (rendered.includes("$")) return { known: false, reason: "config expression contains unsupported interpolation" };
  if (!printableValue(rendered)) return { known: false, reason: "config expression produced an invalid string" };
  return { known: true, value: rendered };
}

function evaluate(
  expression: Expression,
  context: NextflowConfigExpressionContext,
  parameters: Set<string>,
  environment: Set<string>,
): Evaluation {
  switch (expression.kind) {
    case "literal":
      return expression.interpolated && typeof expression.value === "string"
        ? interpolate(expression.value, context, parameters)
        : { known: true, value: expression.value };
    case "parameter": {
      parameters.add(expression.name);
      if (!(expression.name in context.parameters)) {
        return { known: false, reason: `config expression parameter ${expression.name} is unknown` };
      }
      return { known: true, value: context.parameters[expression.name]! };
    }
    case "environment": {
      environment.add(expression.name);
      return { known: true, value: context.environment[expression.name] ?? null };
    }
    case "not": {
      const operand = evaluate(expression.operand, context, parameters, environment);
      return operand.known ? { known: true, value: !truthy(operand.value) } : operand;
    }
    case "and": {
      const left = evaluate(expression.left, context, parameters, environment);
      if (!left.known) return left;
      if (!truthy(left.value)) return { known: true, value: left.value };
      return evaluate(expression.right, context, parameters, environment);
    }
    case "or": {
      const left = evaluate(expression.left, context, parameters, environment);
      if (!left.known) return left;
      if (truthy(left.value)) return { known: true, value: left.value };
      return evaluate(expression.right, context, parameters, environment);
    }
    case "ternary": {
      const condition = evaluate(expression.condition, context, parameters, environment);
      if (!condition.known) return condition;
      return evaluate(truthy(condition.value) ? expression.yes : expression.no, context, parameters, environment);
    }
    case "starts_with": {
      const value = evaluate(expression.value, context, parameters, environment);
      if (!value.known) return value;
      if (typeof value.value !== "string") return { known: false, reason: "startsWith receiver is not a string" };
      return { known: true, value: value.value.startsWith(expression.prefix) };
    }
  }
}

/**
 * Evaluate the deliberately small, side-effect-free Nextflow config subset
 * needed to close source-relative includeConfig expressions. This is not a
 * Groovy interpreter; unsupported syntax returns an unresolved result.
 */
export function resolveNextflowConfigExpression(
  source: string,
  context: NextflowConfigExpressionContext,
): NextflowConfigExpressionResolution {
  const parameters = new Set<string>();
  const environment = new Set<string>();
  const result = (reason: string): NextflowConfigExpressionResolution => ({
    status: "unresolved",
    reason,
    parameters: [...parameters].sort(),
    environment: [...environment].sort(),
  });
  if (!source.trim()) return result("config expression is empty");
  if (encoder.encode(source).byteLength > MAX_CONFIG_EXPRESSION_BYTES) {
    return result(`config expression exceeds ${MAX_CONFIG_EXPRESSION_BYTES} bytes`);
  }
  try {
    const expression = new Parser(tokenize(source)).parse();
    const resolved = evaluate(expression, context, parameters, environment);
    if (!resolved.known) return result(resolved.reason);
    return {
      status: "resolved",
      value: resolved.value,
      parameters: [...parameters].sort(),
      environment: [...environment].sort(),
    };
  } catch (error) {
    return result(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Extract unambiguous scalar defaults from top-level `params {}` blocks.
 * Dynamic, duplicate, nested, dotted, or interpolated assignments are
 * deliberately excluded so they cannot silently influence config closure.
 */
export function extractNextflowConfigScalarDefaults(bytes: Uint8Array): NextflowConfigScalarDefaults {
  let source: string;
  try {
    source = decoder.decode(bytes);
  } catch {
    return { values: {}, unresolved: ["<non-utf8>"] };
  }
  if (encoder.encode(source).byteLength > MAX_CONFIG_EXPRESSION_BYTES * 64) {
    return { values: {}, unresolved: ["<oversized>"] };
  }

  // This scanner masks comments and quoted strings while retaining byte
  // offsets. Values are parsed separately from their exact source slices.
  const masked = [...source];
  let offset = 0;
  while (offset < source.length) {
    if (source.startsWith("//", offset)) {
      while (offset < source.length && source[offset] !== "\n") masked[offset++] = " ";
      continue;
    }
    if (source.startsWith("/*", offset)) {
      masked[offset++] = " ";
      masked[offset++] = " ";
      while (offset < source.length && !source.startsWith("*/", offset)) {
        if (source[offset] !== "\n") masked[offset] = " ";
        offset += 1;
      }
      if (offset < source.length) {
        masked[offset++] = " ";
        masked[offset++] = " ";
      }
      continue;
    }
    const quote = source[offset];
    if (quote === "'" || quote === '"') {
      const triple = source.slice(offset, offset + 3) === quote.repeat(3);
      const width = triple ? 3 : 1;
      for (let index = 0; index < width; index += 1) masked[offset++] = " ";
      while (offset < source.length) {
        if (source[offset] === "\\" && !triple) {
          masked[offset++] = " ";
          if (offset < source.length) masked[offset++] = " ";
          continue;
        }
        if (source.slice(offset, offset + width) === quote.repeat(width)) {
          for (let index = 0; index < width; index += 1) masked[offset++] = " ";
          break;
        }
        if (source[offset] !== "\n") masked[offset] = " ";
        offset += 1;
      }
      continue;
    }
    offset += 1;
  }
  const visible = masked.join("");
  const candidates = new Map<string, string[]>();
  const unresolved = new Set<string>();
  let depth = 0;
  offset = 0;
  while (offset < visible.length) {
    if (visible[offset] === "{") {
      depth += 1;
      offset += 1;
      continue;
    }
    if (visible[offset] === "}") {
      depth = Math.max(0, depth - 1);
      offset += 1;
      continue;
    }
    if (depth !== 0 || !visible.startsWith("params", offset)
      || identifierPart(visible[offset - 1]) || identifierPart(visible[offset + 6])) {
      offset += 1;
      continue;
    }
    let open = offset + 6;
    while (/\s/.test(visible[open] ?? "")) open += 1;
    if (visible[open] !== "{") {
      offset += 6;
      continue;
    }
    let close = open + 1;
    let blockDepth = 1;
    while (close < visible.length && blockDepth) {
      if (visible[close] === "{") blockDepth += 1;
      else if (visible[close] === "}") blockDepth -= 1;
      close += 1;
    }
    if (blockDepth) break;
    const blockSource = source.slice(open + 1, close - 1);
    const blockVisible = visible.slice(open + 1, close - 1);
    let blockOffset = 0;
    let nested = 0;
    while (blockOffset < blockVisible.length) {
      const character = blockVisible[blockOffset]!;
      if (character === "{") {
        nested += 1;
        blockOffset += 1;
        continue;
      }
      if (character === "}") {
        nested = Math.max(0, nested - 1);
        blockOffset += 1;
        continue;
      }
      if (nested || !identifierStart(character)) {
        blockOffset += 1;
        continue;
      }
      const start = blockOffset++;
      while (identifierPart(blockVisible[blockOffset])) blockOffset += 1;
      const name = blockVisible.slice(start, blockOffset);
      let equals = blockOffset;
      while (/[ \t\r\f\v]/.test(blockVisible[equals] ?? "")) equals += 1;
      if (blockVisible[equals] !== "=") continue;
      let end = equals + 1;
      while (end < blockVisible.length && blockVisible[end] !== "\n" && blockVisible[end] !== ";") end += 1;
      const rawExpression = blockSource.slice(equals + 1, end);
      let expressionEnd = rawExpression.length;
      let quote: string | undefined;
      for (let index = 0; index < rawExpression.length; index += 1) {
        const current = rawExpression[index]!;
        if (quote) {
          if (current === "\\") index += 1;
          else if (current === quote) quote = undefined;
        } else if (current === "'" || current === '"') quote = current;
        else if (current === "/" && rawExpression[index + 1] === "/") {
          expressionEnd = index;
          break;
        }
      }
      const expression = rawExpression.slice(0, expressionEnd).trim();
      const expressions = candidates.get(name) ?? [];
      expressions.push(expression);
      candidates.set(name, expressions);
      blockOffset = end + 1;
    }
    offset = close;
  }

  const pending = new Map<string, string>();
  for (const [name, expressions] of [...candidates].sort(([left], [right]) => left.localeCompare(right))) {
    if (expressions.length !== 1 || !expressions[0]) {
      unresolved.add(name);
      continue;
    }
    pending.set(name, expressions[0]);
  }
  const values: Record<string, NextflowConfigScalar> = {};
  let progressed = true;
  while (progressed && pending.size) {
    progressed = false;
    for (const [name, expression] of [...pending]) {
      const resolution = resolveNextflowConfigExpression(expression, { parameters: values, environment: {} });
      if (resolution.status !== "resolved" || resolution.environment.length) continue;
      values[name] = resolution.value;
      pending.delete(name);
      progressed = true;
    }
  }
  for (const name of pending.keys()) unresolved.add(name);
  return { values, unresolved: [...unresolved].sort() };
}
