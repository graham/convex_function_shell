# function-shell-for-convex

Interactive REPL shell for exploring and calling Convex functions directly from your terminal.

**Note:** This is an unofficial community package, not affiliated with Convex.

## Features

- Interactive REPL with autocomplete support
- Call Convex functions (queries, mutations, actions) directly
- Explore both public and internal functions
- Support for dev and production deployments
- View function signatures and argument types

## Installation

### In a Convex Project

Install as a dev dependency in your Convex project:

```bash
npm install --save-dev function-shell-for-convex
```

Or install globally:

```bash
npm install -g function-shell-for-convex
```

## Usage

Navigate to your Convex project directory and run:

```bash
npx convex-shell
```

Or if installed globally:

```bash
convex-shell
```

### Production Mode

To connect to your production deployment:

```bash
npx convex-shell --prod
```

## Commands

Once in the shell, you can use these commands:

- `update()` - Refresh the function list from Convex
- `help()` - Show help information
- `.exit` - Exit the shell

## Objects

- `api` - Access public functions
- `internal` - Access internal functions

## Example Session

```javascript
// View available modules
help()

// Call a function
api.messages.send({ text: "Hello from the shell!" })

// View function signature
api.messages.send

// Call an internal function
internal.utils.cleanup({})
```

## Development

### Building from Source

```bash
git clone https://github.com/graham/convex_function_shell.git
cd convex_function_shell
npm install
npm run build
```

### Publishing

```bash
npm run build
npm publish
```

## Requirements

- Node.js >= 18.0.0
- A Convex project with `convex` CLI installed

## License

MIT
