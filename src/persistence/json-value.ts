export type JsonValue =
  | null
  | string
  | boolean
  | number
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function invalid(path: string, reason: string): never {
  throw new Error(`invalid JSON value at ${path}: ${reason}`);
}

function validate(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      invalid(path, 'numbers must be finite');
    }
    if (Object.is(value, -0)) {
      invalid(path, 'negative zero is not preserved by JSON serialization');
    }
    return;
  }
  if (typeof value !== 'object') {
    invalid(path, `${typeof value} is not a JSON type`);
  }
  if (ancestors.has(value)) {
    invalid(path, 'cyclic references are not allowed');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        invalid(path, 'array subclasses are not allowed');
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          invalid(`${path}[${index}]`, 'sparse array entries are not allowed');
        }
        validate(value[index], `${path}[${index}]`, ancestors);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') {
          continue;
        }
        if (
          typeof key !== 'string' ||
          !/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= value.length
        ) {
          invalid(path, 'arrays may not contain ignored custom properties');
        }
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(path, 'only plain objects are allowed');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        invalid(path, 'symbol-keyed properties are not preserved by JSON');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      ) {
        invalid(`${path}.${key}`, 'only enumerable data properties are allowed');
      }
      validate(descriptor.value, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  validate(value, '$', new Set<object>());
}

export function serializeJsonValue(value: unknown): string {
  assertJsonValue(value);
  return JSON.stringify(value);
}

export function parseJsonValue(serialized: string, field: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`invalid ${field} JSON`, { cause: error });
  }
  try {
    assertJsonValue(parsed);
  } catch (error) {
    throw new Error(`invalid ${field} JSON value`, { cause: error });
  }
  return parsed;
}
