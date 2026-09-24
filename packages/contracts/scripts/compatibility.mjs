export function isBackwardCompatible(previous, next, allowNewProperties = false) {
  if (Array.isArray(previous)) return Array.isArray(next) && JSON.stringify(previous) === JSON.stringify(next);
  if (previous === null || typeof previous !== 'object') return previous === next;
  if (next === null || typeof next !== 'object' || Array.isArray(next)) return false;
  if (!allowNewProperties && Object.keys(previous).length !== Object.keys(next).length) return false;
  for (const [key, value] of Object.entries(previous)) {
    if (key === 'properties') {
      if (!isBackwardCompatible(value, next[key], true)) return false;
    } else if (!isBackwardCompatible(value, next[key])) return false;
  }
  return true;
}

export function checkEventSchemaCompatibility(baseline, current) {
  for (const [key, schema] of Object.entries(baseline.schemas ?? {})) {
    if (!isBackwardCompatible(schema, current.schemas?.[key])) {
      throw new Error(`Breaking change to event schema ${key}. Add a new event version.`);
    }
  }
}

export function checkOpenApiCompatibility(baseline, current) {
  for (const [path, methods] of Object.entries(baseline.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      const nextOperation = current.paths?.[path]?.[method];
      if (!nextOperation) throw new Error(`Breaking OpenAPI change: ${method.toUpperCase()} ${path} was removed.`);
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        const nextResponse = nextOperation.responses?.[status];
        if (!nextResponse) throw new Error(`Breaking OpenAPI change: ${method.toUpperCase()} ${path} response ${status} was removed.`);
        for (const [contentType, content] of Object.entries(response.content ?? {})) {
          if (!nextResponse.content?.[contentType] || !isBackwardCompatible(content.schema, nextResponse.content[contentType].schema)) {
            throw new Error(`Breaking OpenAPI change: ${method.toUpperCase()} ${path} ${status} ${contentType} changed.`);
          }
        }
      }
    }
  }
  for (const [name, schema] of Object.entries(baseline.components?.schemas ?? {})) {
    if (!isBackwardCompatible(schema, current.components?.schemas?.[name])) {
      throw new Error(`Breaking OpenAPI change: component schema ${name} changed.`);
    }
  }
}
