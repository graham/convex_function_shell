#!/usr/bin/env tsx

import repl from 'node:repl';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Parse command line arguments
const args = process.argv.slice(2);
const isProd = args.includes('--prod');
const deploymentFlag = isProd ? '--prod' : '';

interface FieldType {
  type?: string;
  tableName?: string;
  [key: string]: unknown;
}

interface FunctionArg {
  fieldType: FieldType;
  optional: boolean;
}

interface FunctionSpec {
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

interface ConvexFunctionSpec {
  url: string;
  functions: FunctionSpec[];
}

// Store function metadata globally
const functionsByPath: Map<string, FunctionSpec> = new Map();

// Store deployment info globally
let deploymentName = 'unknown';

// Format argument type for display
function formatArgType(arg: FunctionArg): string {
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
function formatReturnType(returns: Record<string, unknown>): string {
  if (returns.type === 'any') {
    return 'any';
  }
  return JSON.stringify(returns);
}

// Convert function identifier to API path
// e.g., "namespaceGrants/mutations.js:addNamespaceGrant" -> "namespaceGrants.mutations.addNamespaceGrant"
function identifierToApiPath(identifier: string): string {
  const path = identifier
    .replace('.js:', '.')
    .replace('.ts:', '.')
    .replace(/\//g, '.');
  return path;
}

// Convert identifier to convex run format
// e.g., "namespaceGrants/mutations.js:addNamespaceGrant" -> "namespaceGrants/mutations:addNamespaceGrant"
function identifierToRunPath(identifier: string): string {
  return identifier.replace('.js:', ':').replace('.ts:', ':');
}

// Create a callable function proxy with toString
function createFunctionProxy(spec: FunctionSpec): CallableFunction & { toString: () => string; spec: FunctionSpec; runPath: string } {
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
function createProxyTree(functions: FunctionSpec[], visibility: 'public' | 'internal'): Record<string, unknown> {
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
    current[functionName] = createFunctionProxy(func);

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
function update() {
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
    const apiProxy = createProxyTree(validFunctions, 'public');
    const internalProxy = createProxyTree(validFunctions, 'internal');

    // Update global context
    globalThis.api = apiProxy;
    globalThis.internal = internalProxy;

    // Update REPL prompt if it exists
    if (globalThis.replServer) {
      updatePrompt();
    }

    console.log('\nReady! Type help() for usage information or use Tab for autocomplete.\n');

    return { api: apiProxy, internal: internalProxy };
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
function help() {
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

// Helper function to update the REPL prompt
function updatePrompt() {
  if (globalThis.replServer) {
    const deploymentType = isProd ? 'prod' : 'dev';
    globalThis.replServer.setPrompt(`${deploymentName}:${deploymentType}> `);
    globalThis.replServer.prompt();
  }
}

// Extend global types
declare global {
  var api: Record<string, unknown>;
  var internal: Record<string, unknown>;
  var update: () => { api: Record<string, unknown>; internal: Record<string, unknown> };
  var help: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  var replServer: any;
}

// Detect if this file is being run directly or imported
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

// Run update on startup (this will set deploymentName and populate api/internal)
update();

// Only start REPL if running as main module
if (isMainModule) {
  // Initialize
  const deploymentType = isProd ? 'PRODUCTION' : 'dev';
  console.log('Convex Shell - Interactive Function Explorer');
  console.log('===========================================');
  console.log(`Deployment: ${deploymentType}\n`);

  // Custom completer function for better proxy object support
  function customCompleter(line: string): [string[], string] {
  // Default completions for top-level commands
  const topLevelCompletions = ['api', 'internal', 'update', 'help'];

  // If line is empty or just whitespace, show top-level
  if (!line || line.trim() === '') {
    return [topLevelCompletions, line];
  }

  // Find the last expression that looks like property access
  // Match patterns like: api.foo.bar or internal.baz
  const match = line.match(/(\b(?:api|internal)(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)\./);

  if (match) {
    // We have something like "api.foo.bar." - need to complete the next property
    const expr = match[1]; // e.g., "api.foo.bar"
    const prefix = match[0]; // e.g., "api.foo.bar."

    try {
      // Evaluate the expression to get the object
      const obj = eval(expr);

      if (obj && typeof obj === 'object') {
        // Get all keys from the object (our Proxy traps will provide these)
        const keys = Object.keys(obj);

        // Get the partial property name after the last dot
        const afterDot = line.slice(prefix.length);
        const hits = keys.filter(k => k.startsWith(afterDot));

        // Return completions and the part after the last dot
        return [hits.length ? hits : keys, afterDot];
      }
    } catch {
      // If evaluation fails, return empty
      return [[], ''];
    }
  }

    // Handle partial top-level completions (e.g., "ap" -> "api")
    const lastToken = line.split(/\s+/).pop() || '';
    const hits = topLevelCompletions.filter(c => c.startsWith(lastToken));
    return [hits.length ? hits : topLevelCompletions, lastToken];
  }

  // Start REPL with enhanced autocomplete
  const replServer = repl.start({
    prompt: `${deploymentName}:${isProd ? 'prod' : 'dev'}> `,
    useColors: true,
    ignoreUndefined: true,
    terminal: true,
    useGlobal: true, // Changed to true for better default completion
    preview: true,
    completer: customCompleter
  });

  // Store replServer globally so update() can modify the prompt
  globalThis.replServer = replServer;

  // Add functions to REPL context
  replServer.context.update = update;
  replServer.context.help = help;
  replServer.context.api = globalThis.api;
  replServer.context.internal = globalThis.internal;

  // Store help globally
  globalThis.help = help;

  // Setup autocomplete refresh after update
  replServer.setupHistory = replServer.setupHistory || (() => {});
  replServer.on('reset', () => {
    replServer.context.update = update;
    replServer.context.help = help;
    replServer.context.api = globalThis.api;
    replServer.context.internal = globalThis.internal;
  });

  // Handle exit
  replServer.on('exit', () => {
    console.log('\nGoodbye!');
    process.exit(0);
  });
}

// Export api and internal for programmatic use
export const api = globalThis.api;
export const internal = globalThis.internal;
