# t-pane MCP Server

An MCP (Model Context Protocol) server that enables Claude to execute commands in tmux panes, providing a shared terminal experience between Claude and users.

## Features

- **Directory-Aware Pane Management**: Creates separate panes for each directory/project
- **Command Execution**: Run commands in tmux panes with captured output
- **Smart Output Capture**: Uses unique markers to capture exactly the command output, regardless of buffer size
- **Multiple Session Support**: Each Claude instance gets its own pane based on working directory
- **Session Persistence**: Commands remain visible in tmux for user interaction
- **Interactive Prompt Detection**: Automatically detects when commands require user input (passwords, confirmations, etc.)
- **Directory-Specific Logging**: Commands are logged to `.t-pane/logs/` in the current directory
- **Background Tasks**: Launch Claude instances in background panes for research/analysis tasks

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

### 5. Send Keys
Send text to a tmux pane without executing it (useful for pre-filling commands).

```typescript
send_keys({
  text: "git push origin main",
  pane: "claude-terminal",  // optional, defaults to directory-specific pane
  enter: false             // optional, set to true to also send Enter
})
```

### 6. Launch Background Task
Create a background pane for running Claude with a specific research/analysis task.

```typescript
launch_background_task({
  task: "Research TypeScript 5.x features and create a summary",
  outputFile: "typescript-features.md",  // saved to .t-pane/tasks/
  timeout: 300000                       // optional, default 5 minutes
})
```

### 7. Check Background Tasks
Check the status of all background tasks.

```typescript
check_background_tasks()
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

3. **Interactive Prompt Detection**: When a command requires user input:
   - Detects common prompt patterns (password, username, yes/no, etc.)
   - Returns a special response alerting Claude that user interaction is needed
   - Claude will inform you to switch to the tmux pane and provide input

4. **Command Logging**: All commands and outputs are logged to:
   - Primary location: `.t-pane/logs/` in the current working directory
   - Fallback location: `~/.t-pane/logs/{directory-hash}/` if local directory is not writable
   - Format: JSON Lines (one JSON object per line)
   - Includes: timestamp, command, output (truncated if >2KB), exit code, duration, directory
   - Disable with: `export T_PANE_DISABLE_LOGGING=true`

5. **Efficiency**: This approach handles commands with any output size (even 100k+ lines) efficiently by:
   - Using unique IDs to avoid collision
   - Capturing from the end of the buffer
   - Only extracting the relevant portion

## Example Session

When Claude uses this server, you'll see:
- A new tmux pane with directory-specific naming (e.g., `claude-t-pane` for the t-pane directory)
- Each directory gets its own dedicated pane
- Multiple Claude instances working in different directories won't interfere
- All commands Claude executes appear in the appropriate pane
- You can interact with the same terminal
- Command history is preserved per directory

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

## Directory-Aware Sessions

The t-pane server creates separate tmux panes for each directory:
- Pane names are based on the last 2 directory components (e.g., `claude-mcp-servers-t-pane`)
- Each Claude instance working in a different directory gets its own pane
- Logs are stored locally in each project directory
- Multiple Claude instances can work simultaneously without interference

## Interactive Prompts

When a command requires user input (like `git push` asking for credentials), the server will:
1. Detect the interactive prompt
2. Pre-fill the command in the tmux pane (without pressing Enter)
3. Return a message to Claude indicating user interaction is needed
4. You'll see a message like: "⚠️ User interaction required in tmux pane"
5. Switch to the tmux pane where the command is pre-filled and ready for you to review/execute

## Command Logging

By default, all commands are logged to `.t-pane/logs/` in the current directory:

```json
{"timestamp":"2024-06-27T10:30:00Z","command":"git status","output":"...","exitCode":0,"duration":150,"directory":"/path/to/project"}
```

To disable logging:
```bash
export T_PANE_DISABLE_LOGGING=true
```

## Background Tasks (Experimental)

The t-pane server can launch Claude instances in background panes for research or analysis:

1. **Launch a task**: Creates a new pane with task instructions
2. **Manual execution**: Switch to the pane and run `claude` to start the task
3. **Output location**: Results are saved to `.t-pane/tasks/`
4. **Status tracking**: Use `check_background_tasks()` to monitor progress

This feature is experimental and requires manual Claude invocation in the created pane.

## Future Enhancements

- [x] Interactive prompt detection
- [x] Command logging
- [x] Background task execution (experimental)
- [ ] Automatic Claude invocation for background tasks
- [ ] Support for multiple concurrent commands
- [ ] Progress indicators for long-running commands
- [ ] Integration with `/resume` for session continuity

### 8. Read File
Read file contents using cat/head commands in the tmux pane.



### 9. Edit File
Edit files using sed in the tmux pane (visible to user).


