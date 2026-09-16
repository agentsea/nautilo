import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { isInteropZodSchema } from "@langchain/core/utils/types";
import type { ChatModel } from "./types";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

function requiredProperties(schema: JsonObject): string[] {
  return Array.isArray(schema["required"])
    ? schema["required"].filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * Anthropic rejects root anyOf/oneOf/allOf, even with type=object. Expose the
 * same flat arguments as an object projection; the original tool schema still
 * validates branch-specific combinations at execution. Do not rewrite that
 * authoritative schema or wrap arguments in a synthetic property.
 */
export function ensureAnthropicObjectInputSchema(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  const result: JsonObject = { ...schema, type: "object" };
  const properties: JsonObject = isObject(schema["properties"]) ? { ...schema["properties"] } : {};
  const required = new Set(requiredProperties(schema));
  let projected = false;
  for (const combinator of ROOT_COMBINATORS) {
    const alternatives = schema[combinator];
    if (!Array.isArray(alternatives)) continue;
    projected = true;
    delete result[combinator];
    const branches = alternatives.map(ensureAnthropicObjectInputSchema).filter(isObject);
    const branchProperties = branches.map((branch) => isObject(branch["properties"]) ? branch["properties"] : {});
    const names = new Set(branchProperties.flatMap((branch) => Object.keys(branch)));
    for (const name of names) {
      const values = branchProperties.flatMap((branch, index) => {
        if (Object.hasOwn(branch, name)) return [branch[name]];
        const additional = branches[index]?.["additionalProperties"];
        return combinator !== "allOf" && additional !== false ? [isObject(additional) ? additional : {}] : [];
      });
      const unique = values.filter((value, index) => values.findIndex((other) => JSON.stringify(other) === JSON.stringify(value)) === index);
      const value = unique.length === 1 ? unique[0] : { [combinator === "allOf" ? "allOf" : "anyOf"]: unique };
      properties[name] = Object.hasOwn(properties, name) ? { allOf: [properties[name], value] } : value;
    }
    const branchRequired = branches.map(requiredProperties);
    const candidates = combinator === "allOf" ? branchRequired.flat() : (branchRequired[0] ?? []).filter((name) => branchRequired.every((names) => names.includes(name)));
    for (const name of candidates) required.add(name);
    // Keep closed unions closed, but include every branch's actual argument.
    if (result["additionalProperties"] === undefined && branches.length > 0 && branches.every((branch) => branch["additionalProperties"] === false)) {
      result["additionalProperties"] = false;
    }
  }
  if (projected) {
    result["properties"] = properties;
    result["required"] = [...required];
  }
  return result;
}

/**
 * Convert LangChain/OpenAI custom tools to Anthropic's native descriptor while
 * preserving built-in Anthropic tools. This gives Nautilo one provider boundary
 * where a union-shaped JSON schema cannot invalidate every tool in a request.
 */
export function convertToolToAnthropicTool(tool: unknown): unknown {
  if (!isObject(tool)) return tool;

  if (isObject(tool["input_schema"])) {
    return {
      ...tool,
      input_schema: ensureAnthropicObjectInputSchema(tool["input_schema"]),
    };
  }

  if (tool["type"] === "function" && isObject(tool["function"])) {
    const fn = tool["function"];
    if (typeof fn["name"] !== "string") return tool;
    return {
      name: fn["name"],
      description: typeof fn["description"] === "string" ? fn["description"] : "",
      input_schema: ensureAnthropicObjectInputSchema(fn["parameters"]),
    };
  }

  // Anthropic built-ins carry a provider-specific type and no input_schema.
  if (typeof tool["type"] === "string") return tool;
  if (typeof tool["name"] !== "string" || tool["schema"] === undefined) return tool;

  const schema = isInteropZodSchema(tool["schema"])
    ? toJsonSchema(tool["schema"])
    : tool["schema"];
  return {
    name: tool["name"],
    description: typeof tool["description"] === "string" ? tool["description"] : "",
    input_schema: ensureAnthropicObjectInputSchema(schema),
  };
}

/** Intercept every bindTools call, including binds on an already-bound model. */
export function wrapAnthropicModelForToolSchemas<M extends ChatModel>(model: M): M {
  if (!model.bindTools) return model;
  const originalBindTools = model.bindTools.bind(model);
  const bindTools: NonNullable<ChatModel["bindTools"]> = (tools, options) => {
    const normalizedTools = Array.isArray(tools)
      ? tools.map(convertToolToAnthropicTool)
      : tools;
    return wrapAnthropicModelForToolSchemas(originalBindTools(normalizedTools, options));
  };

  // Preserve the concrete LangChain model and every configuration/runnable
  // field. Only tool binding changes; all other property access remains a
  // transparent view of the real model.
  return new Proxy(model as M & object, {
    get(target, property, receiver) {
      if (property === "bindTools") return bindTools;
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as M;
}
