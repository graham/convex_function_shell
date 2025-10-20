/**
 * Function Shell for Convex - Library API
 *
 * This module exports all types, utilities, and core functions for programmatic use.
 * You can use this library to build custom Convex function explorers and callers.
 *
 * @example
 * ```typescript
 * import { update, createProxyTree, FunctionSpec } from 'function-shell-for-convex';
 *
 * // Fetch and populate function specs
 * const { api, internal } = update();
 *
 * // Access functions via proxy objects
 * const result = api.myModule.myFunction({ arg1: 'value' });
 * ```
 *
 * @module
 */

import { execSync } from 'node:child_process';

// Type definitions
export interface FieldType {
  type?: string;
  tableName?: string;
  [key: string]: unknown;
}

export interface FunctionArg {
  fieldType: FieldType;
  optional: boolean;
}

export interface FunctionSpec {
  identifier: string;
  functionType: 'Query' | 'Mutation' | 'Action';
  args: {
    type: 'object';
    value: Record<string, FunctionArg>;
  };
  returns: Record<string, unknown>;
  visibility: {
    kind: 'public' | 'internal';
  };
}

export interface ConvexFunctionSpec {
  url: string;
  functions: FunctionSpec[];
}

export interface UpdateOptions {
  deploymentFlag?: string;
  isProd?: boolean;
  onUpdate?: (deploymentName: string) => void;
}

// Store function metadata globally
const functionsByPath: Map<string, FunctionSpec> = new Map();

// Store deployment info globally
let deploymentName = 'unknown';

// Format argument type for display
export function formatArgType(arg: FunctionArg): string {
  const { fieldType, optional } = arg;
  let typeStr = '';

  if (fieldType.type === 'id') {
    typeStr = `Id<"${fieldType.tableName}">`;
  } else if (fieldType.type === 'string') {
    typeStr = 'string';
  } else if (fieldType.type === 'number') {
    typeStr = 'number';
  } else if (fieldType.type === 'boolean') {
    typeStr = 'boolean';
  } else if (fieldType.type === 'array') {
    typeStr = 'array';
  } else if (fieldType.type === 'object') {
    typeStr = 'object';
  } else if (fieldType.type === 'union') {
    typeStr = 'union';
  } else if (fieldType.type === 'literal') {
    typeStr = `literal`;
  } else {
    typeStr = fieldType.type || 'any';
  }

  return optional ? `${typeStr}?` : typeStr;
}

// Format return type for display
export function formatReturnType(returns: Record<string, unknown>): string {
  if (returns.type === 'any') {
    return 'any';
  }
  return JSON.stringify(returns);
}

// Convert function identifier to API path
// e.g., "namespaceGrants/mutations.js:addNamespaceGrant" -> "namespaceGrants.mutations.addNamespaceGrant"
export function identifierToApiPath(identifier: string): string {
  const path = identifier
    .replace('.js:', '.')
    .replace('.ts:', '.')
    .replace(/\//g, '.');
  return path;
}

// Convert identifier to convex run format
// e.g., "namespaceGrants/mutations.js:addNamespaceGrant" -> "namespaceGrants/mutations:addNamespaceGrant"
export function identifierToRunPath(identifier: string): string {
  return identifier.replace('.js:', ':').replace('.ts:', ':');
}

// Create a callable function proxy with toString
export function createFunctionProxy(
  spec: FunctionSpec,
  deploymentFlag = ''
): CallableFunction & { toString: () => string; spec: FunctionSpec; runPath: string } {
  const runPath = identifierToRunPath(spec.identifier);

  const fn = function(args: Record<string, unknown> = {}) {
    try {
      // Convert args to JSON string
      const argsJson = JSON.stringify(args);

      // Run the convex function with deployment flag
      const cmd = `npx convex run ${deploymentFlag} "${runPath}" '${argsJson}'`.trim();
      console.log(`Running: ${cmd}`);

      const output = execSync(cmd, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Try to parse as JSON, otherwise return as string
      try {
        return JSON.parse(output);
      } catch {
        return output.trim();
      }
    } catch (error: unknown) {
      const err = error as Error & { stderr?: Buffer | string };
      console.error('Error running function:', err.message);
      if (err.stderr) {
        console.error('stderr:', err.stderr.toString());
      }
      throw error;
    }
  };

  // Add toString method
  fn.toString = function() {
    const args = spec.args.value;
    const argsList = Object.entries(args)
      .map(([name, arg]) => `  ${name}: ${formatArgType(arg)}`)
      .join('\n');

    const returnType = formatReturnType(spec.returns);

    return `[${spec.functionType}] ---- ${runPath}\nArgs: {\n${JSON.stringify(argsList, null, 2)}\n}\nReturns: ${returnType}`;
  };

  // Add metadata properties using Object.assign for better type safety
  const fnWithMetadata = Object.assign(fn, {
    spec,
    runPath
  });

  return fnWithMetadata as CallableFunction & { toString: () => string; spec: FunctionSpec; runPath: string };
}

// Create nested proxy objects
export function createProxyTree(
  functions: FunctionSpec[],
  visibility: 'public' | 'internal',
  deploymentFlag = ''
): Record<string, unknown> {
  // Filter functions by visibility
  const filteredFunctions = functions.filter(f => f.visibility.kind === visibility);

  // Build a tree structure
  const tree: Record<string, unknown> = {};

  for (const func of filteredFunctions) {
    const apiPath = identifierToApiPath(func.identifier);
    const parts = apiPath.split('.');

    let current = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    // Set the leaf function
    const functionName = parts[parts.length - 1];
    current[functionName] = createFunctionProxy(func, deploymentFlag);

    // Store in global map
    functionsByPath.set(apiPath, func);
  }

  // Cache proxies to ensure consistent object references for autocomplete
  const proxyCache = new WeakMap<Record<string, unknown>, Record<string, unknown>>();

  // Create proxy to handle property access
  function createProxy(obj: Record<string, unknown>, path: string[] = []): Record<string, unknown> {
    // Return cached proxy if it exists
    const cached = proxyCache.get(obj);
    if (cached) {
      return cached;
    }

    const proxy = createProxyImpl(obj, path);
    proxyCache.set(obj, proxy);
    return proxy;
  }

  function createProxyImpl(obj: Record<string, unknown>, path: string[] = []): Record<string, unknown> {
    return new Proxy(obj, {
      get(target, prop: string | symbol) {
        if (typeof prop === 'symbol') {
          if (prop === Symbol.for('nodejs.util.inspect.custom')) {
            return () => {
              const keys = Object.keys(obj);
              if (keys.length === 0) {
                return '{}';
              }
              return `{ ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ', ...' : ''} }`;
            };
          }
          return undefined;
        }
        if (prop === 'inspect' || prop === 'constructor' || prop === (Symbol.toStringTag as unknown)) {
          return undefined;
        }

        const value = target[prop];

        if (value === undefined) {
          console.log(`Property '${prop}' not found at path: ${path.join('.')}`);
          return undefined;
        }

        // If it's a function, return it directly (already has toString and is callable)
        if (typeof value === 'function') {
          return value;
        }

        // If it's an object, wrap it in a proxy
        if (typeof value === 'object' && value !== null) {
          return createProxy(value as Record<string, unknown>, [...path, prop]);
        }

        return value;
      },

      // Support autocomplete by listing available properties
      ownKeys(target) {
        return Reflect.ownKeys(target);
      },

      // Make properties appear enumerable for autocomplete
      getOwnPropertyDescriptor(target, prop) {
        const desc = Object.getOwnPropertyDescriptor(target, prop);
        if (desc) {
          return {
            ...desc,
            enumerable: true,
            configurable: true
          };
        }
        return undefined;
      },

      // Support 'in' operator
      has(target, prop) {
        return prop in target;
      }
    });
  }

  return createProxy(tree);
}

// Main update function
export function update(options: UpdateOptions = {}) {
  const { deploymentFlag = '', isProd = false, onUpdate } = options;
  const deploymentType = isProd ? 'production' : 'dev';
  console.log(`Fetching function specs from Convex (${deploymentType})...`);

  try {
    const cmd = `npx convex function-spec ${deploymentFlag}`.trim();
    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const spec: ConvexFunctionSpec = JSON.parse(output);

    // Extract deployment name from URL (e.g., "frugal-fox-192" from "https://frugal-fox-192.convex.cloud")
    const urlMatch = spec.url.match(/https?:\/\/([^.]+)\./);
    if (urlMatch) {
      deploymentName = urlMatch[1];
    }

    console.log(`Loaded ${spec.functions.length} functions from ${spec.url}`);

    // Filter out functions without visibility property (malformed functions)
    const validFunctions = spec.functions.filter(f => f.visibility && f.visibility.kind);

    const publicCount = validFunctions.filter(f => f.visibility.kind === 'public').length;
    const internalCount = validFunctions.filter(f => f.visibility.kind === 'internal').length;

    const invalidCount = spec.functions.length - validFunctions.length;
    if (invalidCount > 0) {
      console.log(`  (skipped ${invalidCount} functions without visibility information)`);
    }

    console.log(`  - ${publicCount} public functions (api)`);
    console.log(`  - ${internalCount} internal functions (internal)`);

    // Build proxy trees
    const apiProxy = createProxyTree(validFunctions, 'public', deploymentFlag);
    const internalProxy = createProxyTree(validFunctions, 'internal', deploymentFlag);

    // Update global context
    globalThis.api = apiProxy;
    globalThis.internal = internalProxy;

    // Call onUpdate callback if provided
    if (onUpdate) {
      onUpdate(deploymentName);
    }

    console.log('\nReady! Type help() for usage information or use Tab for autocomplete.\n');

    return { api: apiProxy, internal: internalProxy, deploymentName };
  } catch (error: unknown) {
    const err = error as Error & { stderr?: Buffer | string };
    console.error('Error fetching function specs:', err.message);
    if (err.stderr) {
      console.error('stderr:', err.stderr.toString());
    }
    throw error;
  }
}

// Helper function to list available top-level modules
export function help(isProd = false) {
  const deploymentType = isProd ? 'PRODUCTION' : 'dev';
  console.log('\n=== Convex Shell Help ===\n');
  console.log(`Deployment: ${deploymentType}`);
  console.log('\nAvailable commands:');
  console.log('  update()     - Refresh function list from Convex');
  console.log('  help()       - Show this help message');
  console.log('  .exit        - Exit the shell');
  console.log('\nAvailable objects:');
  console.log('  api          - Public functions');
  console.log('  internal     - Internal functions');

  if (globalThis.api) {
    const apiKeys = Object.keys(globalThis.api as Record<string, unknown>);
    if (apiKeys.length > 0) {
      console.log('\nPublic modules (api):');
      apiKeys.sort().forEach(key => {
        console.log(`  api.${key}`);
      });
    }
  }

  if (globalThis.internal) {
    const internalKeys = Object.keys(globalThis.internal as Record<string, unknown>);
    if (internalKeys.length > 0) {
      console.log('\nInternal modules (internal):');
      internalKeys.sort().forEach(key => {
        console.log(`  internal.${key}`);
      });
    }
  }

  console.log('\nTips:');
  console.log('  - Use Tab for autocomplete');
  console.log('  - Type a function name to see its signature');
  console.log('  - Call functions with: functionName({arg1: value1, ...})');
  console.log('  - Example: internal.utils.actions.helloWorld({})');
  console.log();
}

// Extend global types
declare global {
  var api: Record<string, unknown>;
  var internal: Record<string, unknown>;
}

// Export api and internal for programmatic use (will be undefined until update() is called)
export const api = globalThis.api;
export const internal = globalThis.internal;
