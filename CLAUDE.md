# Project Context for Claude

## IMPORTANT: Command Execution Policy

**ALWAYS use the t-pane MCP server for ALL command-line operations.** This includes:
- File operations (ls, cat, grep, find, etc.)
- Git commands (git status, git diff, git commit, etc.)
- Build commands (npm, make, cargo, etc.)
- System commands (df, ps, top, etc.)
- Any other shell commands

### Why use t-pane?
1. **Shared visibility** - All commands appear in the claude-terminal pane where users can see and interact
2. **Persistent history** - Commands remain visible for debugging and reference
3. **Real-time feedback** - Users see commands as they execute
4. **Better collaboration** - Creates a shared terminal experience

### How to use t-pane:
Instead of using the Bash tool directly, use the t-pane execute_command tool:

```typescript
// DON'T do this:
Bash("ls -la")

// DO this:
execute_command({ command: "ls -la" })
```

### Available t-pane tools:
- `execute_command` - Run any command and capture output
- `create_pane` - Create named panes (rarely needed, auto-creates claude-terminal)
- `capture_output` - Manually capture pane content
- `list_panes` - List all tmux panes

## Project-Specific Information
This is the t-pane MCP server project that provides tmux integration for Claude.