# t-pane MCP Server

An MCP (Model Context Protocol) server that enables Claude to execute commands in tmux panes, providing a shared terminal experience between Claude and users.

## Features

- **Automatic Pane Management**: Creates a dedicated `claude-terminal` pane if it doesn't exist
- **Command Execution**: Run commands in tmux panes with captured output
- **Smart Output Capture**: Uses unique markers to capture exactly the command output, regardless of buffer size
- **Multiple Pane Support**: Can target different named panes
- **Session Persistence**: Commands remain visible in tmux for user interaction

## Installation

```bash
cd /Users/rumen.d/github/mcp-servers/t-pane
npm install
npm run build
```

## Configuration

Add to your Claude configuration file (`~/Library/Application Support/Claude/config.json`):

```json
{
  "mcpServers": {
    "t-pane": {
      "command": "node",
      "args": ["/Users/rumen.d/github/mcp-servers/t-pane/dist/index.js"]
    }
  }
}
```

## Usage

Once configured, Claude can use the following tools:

### 1. Execute Command
Executes a command in a tmux pane and captures the output.

```typescript
execute_command({
  command: "ls -la",
  pane: "claude-terminal",  // optional, defaults to "claude-terminal"
  captureOutput: true       // optional, defaults to true
})
```

### 2. Create Pane
Creates a new tmux pane with a specific name.

```typescript
create_pane({
  name: "my-pane",         // optional, defaults to "claude-terminal"
  split: "horizontal"      // optional: "horizontal" or "vertical"
})
```

### 3. Capture Output
Captures recent output from a tmux pane.

```typescript
capture_output({
  pane: "claude-terminal",  // optional
  lines: 100               // optional, number of lines to capture
})
```

### 4. List Panes
Lists all available tmux panes.

```typescript
list_panes()
```

## How It Works

1. **Command Execution**: When Claude executes a command, it's wrapped with unique markers:
   ```bash
   echo '===CMD_${commandId}_START==='; <your-command>; echo '===CMD_${commandId}_END==='
   ```

2. **Output Capture**: The server:
   - Finds the START marker in the tmux buffer
   - Calculates how many lines from the end to capture
   - Extracts only the output between markers
   - Returns clean output to Claude

3. **Efficiency**: This approach handles commands with any output size (even 100k+ lines) efficiently by:
   - Using unique IDs to avoid collision
   - Capturing from the end of the buffer
   - Only extracting the relevant portion

## Example Session

When Claude uses this server, you'll see:
- A new tmux window/pane named `claude-terminal`
- All commands Claude executes appear in this pane
- You can interact with the same terminal
- Command history is preserved

## Development

```bash
# Watch mode for development
npm run watch

# Build for production
npm run build
```

## Requirements

- tmux installed and available in PATH
- Must be run inside a tmux session for full functionality
- Node.js 18+

## Troubleshooting

1. **"tmux is not installed"**: Install tmux using your package manager
2. **"Not running inside a tmux session"**: Start tmux first with `tmux new-session`
3. **Commands not appearing**: Check that the pane name matches what Claude is using

## Future Enhancements

- [ ] Support for multiple concurrent commands
- [ ] Progress indicators for long-running commands
- [ ] Command history tracking
- [ ] Integration with `/resume` for session continuity