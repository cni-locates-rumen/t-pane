#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { exec, execSync } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Types
interface TmuxPane {
  session: string;
  window: string;
  pane: string;
  title: string;
  active: boolean;
}

interface CommandExecution {
  commandId: string;
  command: string;
  output: string;
  exitCode: number;
  linesCaptuerd: number;
}

// Schemas
const executeCommandSchema = z.object({
  command: z.string().describe("The command to execute in the tmux pane"),
  pane: z.string().optional().describe("Target pane (default: claude-terminal)"),
  captureOutput: z.boolean().optional().default(true).describe("Whether to capture and return command output")
});

const createPaneSchema = z.object({
  name: z.string().optional().default("claude-terminal").describe("Name for the new pane"),
  split: z.enum(["horizontal", "vertical"]).optional().default("horizontal").describe("Split direction")
});

const captureOutputSchema = z.object({
  pane: z.string().optional().default("claude-terminal").describe("Pane to capture from"),
  lines: z.number().optional().default(100).describe("Number of lines to capture from the end")
});

// Server setup
const server = new Server(
  {
    name: "t-pane",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Utility functions
// Store the created pane ID globally to reuse it
let claudeTerminalPaneId: string | null = null;

async function getPanes(): Promise<TmuxPane[]> {
  try {
    const { stdout } = await execAsync("tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_title} #{pane_active}'");
    return stdout.trim().split('\n').map(line => {
      const [id, title, active] = line.split(' ');
      const [session, windowPane] = id.split(':');
      const [window, pane] = windowPane.split('.');
      return { session, window, pane, title, active: active === '1' };
    });
  } catch (error) {
    return [];
  }
}

async function findOrCreatePane(paneName: string = "claude-terminal"): Promise<string> {
  // If we already have a pane ID stored, check if it still exists
  if (claudeTerminalPaneId) {
    try {
      // Check if the pane still exists
      const { stdout } = await execAsync(`tmux list-panes -F '#{session_name}:#{window_index}.#{pane_index}' | grep -F '${claudeTerminalPaneId}'`);
      if (stdout.trim()) {
        return claudeTerminalPaneId;
      }
    } catch (error) {
      // Pane doesn't exist anymore, clear the stored ID
      claudeTerminalPaneId = null;
    }
  }
  
  // Look for existing claude-terminal by checking pane environment variable
  try {
    const { stdout: existingPane } = await execAsync(
      `tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_id}' | while read pane_info; do
        pane_addr=$(echo "$pane_info" | cut -d' ' -f1)
        pane_id=$(echo "$pane_info" | cut -d' ' -f2)
        if tmux show-environment -t "$pane_addr" CLAUDE_TERMINAL 2>/dev/null | grep -q 'CLAUDE_TERMINAL=1'; then
          echo "$pane_addr"
          break
        fi
      done`
    );
    
    if (existingPane.trim()) {
      claudeTerminalPaneId = existingPane.trim();
      return claudeTerminalPaneId;
    }
  } catch (error) {
    // No existing pane found
  }
  
  // Create new pane as a split
  try {
    // Get current pane info
    const { stdout: currentPane } = await execAsync("tmux display-message -p '#{pane_id}'");
    const originalPaneId = currentPane.trim();
    
    // Create a horizontal split (60/40) to the right of current pane
    await execAsync(`tmux split-window -h -p 40 -c "#{pane_current_path}"`);
    
    // Mark this pane as claude-terminal
    await execAsync(`tmux set-environment CLAUDE_TERMINAL 1`);
    
    // Get the new pane's address
    const { stdout: newPaneInfo } = await execAsync(`tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'`);
    claudeTerminalPaneId = newPaneInfo.trim();
    
    // Set a custom pane border format to identify it
    await execAsync(`tmux select-pane -T "${paneName}"`);
    
    // Return to the original pane
    await execAsync(`tmux select-pane -t '${originalPaneId}'`);
    
    return claudeTerminalPaneId;
  } catch (error) {
    throw new Error(`Failed to create pane: ${error}`);
  }
}

async function executeInPane(paneId: string, command: string, captureOutput: boolean = true): Promise<CommandExecution> {
  const commandId = Date.now().toString() + Math.random().toString(36).substring(7);
  
  // Send the command
  await execAsync(`tmux send-keys -t ${paneId} ${JSON.stringify(command)} Enter`);
  
  if (captureOutput) {
    // Wait for command to complete (adjust timeout based on command complexity)
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Use hybrid approach: try prompt-based first, fall back to markers if needed
    try {
      // First, try to capture using prompt detection
      const { stdout: paneContent } = await execAsync(`tmux capture-pane -t ${paneId} -p -S -`);
      const lines = paneContent.split('\n');
      
      // Find prompt lines (❯)
      const promptLines: number[] = [];
      lines.forEach((line, index) => {
        if (line.startsWith('❯')) {
          promptLines.push(index);
        }
      });
      
      if (promptLines.length >= 2) {
        // Get the last two prompts
        const lastPrompt = promptLines[promptLines.length - 1];
        const secondLastPrompt = promptLines[promptLines.length - 2];
        
        // Extract output between prompts (skip command line and path info)
        const startLine = secondLastPrompt + 1;
        const endLine = lastPrompt - 2;
        
        if (startLine <= endLine) {
          const output = lines.slice(startLine, endLine + 1).join('\n').trim();
          return {
            commandId,
            command,
            output,
            exitCode: 0,
            linesCaptuerd: output.split('\n').length
          };
        }
      }
      
      // If prompt detection fails, fall back to marker method
      // Re-run command with markers
      const markedCommand = `echo '===CMD_${commandId}_START==='; ${command}; echo '===CMD_${commandId}_END==='`;
      await execAsync(`tmux send-keys -t ${paneId} ${JSON.stringify(markedCommand)} Enter`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Capture with markers
      const { stdout: markedOutput } = await execAsync(
        `tmux capture-pane -t ${paneId} -p -S - | sed -n '/===CMD_${commandId}_START===/,/===CMD_${commandId}_END===/p' | sed '1d;$d'`
      );
      
      return {
        commandId,
        command,
        output: markedOutput.trim(),
        exitCode: 0,
        linesCaptuerd: markedOutput.trim().split('\n').length
      };
    } catch (error) {
      return {
        commandId,
        command,
        output: `Error capturing output: ${error}`,
        exitCode: -1,
        linesCaptuerd: 0
      };
    }
  } else {
    return {
      commandId,
      command,
      output: "Command sent (output not captured)",
      exitCode: 0,
      linesCaptuerd: 0
    };
  }
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "execute_command",
      description: "Execute a command in a tmux pane (creates 'claude-terminal' pane if needed)",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute in the tmux pane" },
          pane: { type: "string", description: "Target pane (default: claude-terminal)" },
          captureOutput: { type: "boolean", description: "Whether to capture and return command output", default: true }
        },
        required: ["command"]
      }
    },
    {
      name: "create_pane",
      description: "Create a new tmux pane",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for the new pane", default: "claude-terminal" },
          split: { type: "string", enum: ["horizontal", "vertical"], description: "Split direction", default: "horizontal" }
        }
      }
    },
    {
      name: "capture_output",
      description: "Capture output from a tmux pane",
      inputSchema: {
        type: "object",
        properties: {
          pane: { type: "string", description: "Pane to capture from", default: "claude-terminal" },
          lines: { type: "number", description: "Number of lines to capture from the end", default: 100 }
        }
      }
    },
    {
      name: "list_panes",
      description: "List all tmux panes",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "execute_command": {
        const { command, pane, captureOutput } = executeCommandSchema.parse(args);
        const targetPane = pane || "claude-terminal";
        
        // Find or create the pane
        const paneId = await findOrCreatePane(targetPane);
        
        // Execute the command
        const result = await executeInPane(paneId, command, captureOutput);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
      
      case "create_pane": {
        const { name, split } = createPaneSchema.parse(args);
        const paneId = await findOrCreatePane(name);
        
        return {
          content: [
            {
              type: "text",
              text: `Created/found pane: ${paneId}`
            }
          ]
        };
      }
      
      case "capture_output": {
        const { pane, lines } = captureOutputSchema.parse(args);
        const paneId = await findOrCreatePane(pane);
        
        const { stdout } = await execAsync(`tmux capture-pane -t ${paneId} -p -S -${lines}`);
        
        return {
          content: [
            {
              type: "text",
              text: stdout
            }
          ]
        };
      }
      
      case "list_panes": {
        const panes = await getPanes();
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(panes, null, 2)
            }
          ]
        };
      }
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      isError: true
    };
  }
});

// Main function
async function main() {
  // Check if tmux is available
  try {
    execSync("tmux -V");
  } catch (error) {
    console.error("Error: tmux is not installed or not in PATH");
    process.exit(1);
  }
  
  // Check if we're in a tmux session
  if (!process.env.TMUX) {
    console.error("Warning: Not running inside a tmux session. Some features may not work correctly.");
  }
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("t-pane MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});