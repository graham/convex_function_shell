import repl from 'node:repl';
import { fileURLToPath } from 'node:url';
import { update, help } from './lib.js';

// Parse command line arguments
const args = process.argv.slice(2);

// Show help if requested
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Convex Function Shell - Interactive REPL for Convex functions

Usage: convex-shell [options]

Options:
  --prod         Connect to production deployment (default: dev)
  --help, -h     Show this help message

Examples:
  convex-shell              # Connect to dev deployment
  convex-shell --prod       # Connect to production deployment

Once in the shell:
  - Type help() for available commands
  - Use Tab for autocomplete
  - Access functions via api.<path> or internal.<path>
  - Type .exit to quit
`);
  process.exit(0);
}

const isProd = args.includes('--prod');
const deploymentFlag = isProd ? '--prod' : '';

// Store deployment name globally
let deploymentName = 'unknown';

// Helper function to update the REPL prompt
function updatePrompt() {
  if (globalThis.replServer) {
    const deploymentType = isProd ? 'prod' : 'dev';
    globalThis.replServer.setPrompt(`${deploymentName}:${deploymentType}> `);
    globalThis.replServer.prompt();
  }
}

// Wrapper for update function that works with the shell
function shellUpdate() {
  return update({
    deploymentFlag,
    isProd,
    onUpdate: (name) => {
      deploymentName = name;
      updatePrompt();
    }
  });
}

// Wrapper for help function that works with the shell
function shellHelp() {
  help(isProd);
}

// Extend global types
declare global {
  var api: Record<string, unknown>;
  var internal: Record<string, unknown>;
  var update: () => { api: Record<string, unknown>; internal: Record<string, unknown>; deploymentName: string };
  var help: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  var replServer: any;
}

// Function to start the REPL
export function startRepl() {
  // Run update first to populate api/internal
  const result = shellUpdate();
  deploymentName = result.deploymentName;

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
    useGlobal: true,
    preview: true,
    completer: customCompleter
  });

  // Store replServer globally so update() can modify the prompt
  globalThis.replServer = replServer;

  // Add functions to REPL context
  replServer.context.update = shellUpdate;
  replServer.context.help = shellHelp;
  replServer.context.api = globalThis.api;
  replServer.context.internal = globalThis.internal;

  // Store help and update globally
  globalThis.help = shellHelp;
  globalThis.update = shellUpdate;

  // Setup autocomplete refresh after update
  replServer.setupHistory = replServer.setupHistory || (() => {});
  replServer.on('reset', () => {
    replServer.context.update = shellUpdate;
    replServer.context.help = shellHelp;
    replServer.context.api = globalThis.api;
    replServer.context.internal = globalThis.internal;
  });

  // Handle exit
  replServer.on('exit', () => {
    console.log('\nGoodbye!');
    process.exit(0);
  });
}

// Detect if this file is being run directly
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

// Start REPL if running as main module (for backward compatibility)
if (isMainModule) {
  startRepl();
}

// Export for programmatic use
export { update, help } from './lib.js';
export const api = globalThis.api;
export const internal = globalThis.internal;
