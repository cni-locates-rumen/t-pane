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
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";

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
  requiresInteraction?: boolean;
  interactionType?: string;
  interactionMessage?: string;
}

interface LogEntry {
  timestamp: string;
  command: string;
  output: string;
  exitCode: number;
  duration: number;
  requiresInteraction?: boolean;
  interactionType?: string;
}

// Schemas
const executeCommandSchema = z.object({
  command: z.string().describe("The command to execute in the tmux pane"),
  pane: z.string().optional().describe("Target pane (default: directory-specific pane)"),
  captureOutput: z.boolean().optional().default(true).describe("Whether to capture and return command output")
});

const createPaneSchema = z.object({
  name: z.string().optional().describe("Name for the new pane (default: directory-specific)"),
  split: z.enum(["horizontal", "vertical"]).optional().default("horizontal").describe("Split direction")
});

const captureOutputSchema = z.object({
  pane: z.string().optional().describe("Pane to capture from (default: directory-specific)"),
  lines: z.number().optional().default(100).describe("Number of lines to capture from the end")
});

// Server setup
const server = new Server(
  {
    name: "t-pane",
    version: "0.3.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Utility functions
// Store created pane IDs per directory
const paneIdsByDirectory = new Map<string, string>();

// Get current working directory
function getCurrentDirectory(): string {
  return process.cwd();
}

// Generate a short hash for a directory path
function getDirectoryHash(dirPath: string): string {
  return createHash('sha256').update(dirPath).digest('hex').substring(0, 8);
}

// Get pane name based on current directory
function getPaneName(directory?: string): string {
  const dir = directory || getCurrentDirectory();
  const pathParts = dir.split(path.sep).filter(Boolean);
  
  // Use last 2-3 directory components for readability
  const suffix = pathParts.slice(-2).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
  
  // If suffix is too long or empty, use hash
  if (!suffix || suffix.length > 20) {
    return `claude-${getDirectoryHash(dir)}`;
  }
  
  return `claude-${suffix}`;
}

// Prompt detection patterns
const PROMPT_PATTERNS = [
  { pattern: /password\s*:/i, type: 'password', message: 'Password required' },
  { pattern: /passphrase\s*:/i, type: 'password', message: 'Passphrase required' },
  { pattern: /username\s*:/i, type: 'username', message: 'Username required' },
  { pattern: /Username for/i, type: 'git-username', message: 'Git username required' },
  { pattern: /Password for/i, type: 'git-password', message: 'Git password required' },
  { pattern: /\[y\/N\]/i, type: 'yes-no', message: 'Yes/No confirmation required' },
  { pattern: /\[Y\/n\]/i, type: 'yes-no', message: 'Yes/No confirmation required' },
  { pattern: /\(y\/n\)/i, type: 'yes-no', message: 'Yes/No confirmation required' },
  { pattern: /Continue\?/i, type: 'confirmation', message: 'Confirmation required' },
  { pattern: /Are you sure/i, type: 'confirmation', message: 'Confirmation required' }
];

// Logging configuration
const LOGGING_ENABLED = process.env.T_PANE_DISABLE_LOGGING !== 'true';

// Get log directory based on current directory
function getLogDir(): string {
  const currentDir = getCurrentDirectory();
  const localLogDir = path.join(currentDir, '.t-pane', 'logs');
  
  // Try to use local directory first, fallback to home directory with hash
  return localLogDir;
}

// Get fallback log directory if local is not writable
function getFallbackLogDir(): string {
  const currentDir = getCurrentDirectory();
  const dirHash = getDirectoryHash(currentDir);
  return path.join(os.homedir(), '.t-pane', 'logs', dirHash);
}

// Ensure log directory exists
async function ensureLogDir(): Promise<string> {
  if (!LOGGING_ENABLED) return '';
  
  let logDir = getLogDir();
  
  try {
    await fs.mkdir(logDir, { recursive: true });
    // Test if we can write to it
    const testFile = path.join(logDir, '.test');
    await fs.writeFile(testFile, 'test');
    await fs.unlink(testFile);
    return logDir;
  } catch (error) {
    // Fallback to home directory
    logDir = getFallbackLogDir();
    try {
      await fs.mkdir(logDir, { recursive: true });
      return logDir;
    } catch (fallbackError) {
      console.error('Failed to create log directory:', fallbackError);
      return '';
    }
  }
}

// Log command execution
async function logCommand(entry: LogEntry) {
  if (!LOGGING_ENABLED) return;
  
  try {
    const logDir = await ensureLogDir();
    if (!logDir) return;
    
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `commands-${date}.jsonl`);
    
    // Truncate output if too large (keep first and last 1000 chars)
    let logOutput = entry.output;
    if (logOutput.length > 2000) {
      logOutput = logOutput.substring(0, 1000) + '\n...truncated...\n' + logOutput.substring(logOutput.length - 1000);
    }
    
    const logEntry = {
      ...entry,
      output: logOutput,
      directory: getCurrentDirectory()
    };
    
    await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n');
  } catch (error) {
    console.error('Failed to log command:', error);
  }
}

// Check if output contains an interactive prompt
function checkForPrompt(output: string): { requiresInteraction: boolean; type?: string; message?: string } {
  const lastLines = output.split('\n').slice(-5).join('\n');
  
  for (const { pattern, type, message } of PROMPT_PATTERNS) {
    if (pattern.test(lastLines)) {
      return { requiresInteraction: true, type, message };
    }
  }
  
  return { requiresInteraction: false };
}

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

async function findOrCreatePane(requestedPaneName?: string): Promise<string> {
  // Use directory-aware pane naming
  const currentDir = getCurrentDirectory();
  const paneName = requestedPaneName || getPaneName(currentDir);
  
  // Check if we already have a pane ID stored for this directory
  const storedPaneId = paneIdsByDirectory.get(currentDir);
  if (storedPaneId) {
    try {
      // Check if the pane still exists
      const { stdout } = await execAsync(`tmux list-panes -F '#{session_name}:#{window_index}.#{pane_index}' | grep -F '${storedPaneId}'`);
      if (stdout.trim()) {
        return storedPaneId;
      }
    } catch (error) {
      // Pane doesn't exist anymore, clear the stored ID
      paneIdsByDirectory.delete(currentDir);
    }
  }
  
  // Look for existing pane by checking environment variable for this directory
  const envVarName = `CLAUDE_DIR_${getDirectoryHash(currentDir)}`;
  try {
    const { stdout: existingPane } = await execAsync(
      `tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_id}' | while read pane_info; do
        pane_addr=$(echo "$pane_info" | cut -d' ' -f1)
        pane_id=$(echo "$pane_info" | cut -d' ' -f2)
        if tmux show-environment -t "$pane_addr" ${envVarName} 2>/dev/null | grep -q '${envVarName}=1'; then
          echo "$pane_addr"
          break
        fi
      done`
    );
    
    if (existingPane.trim()) {
      const paneId = existingPane.trim();
      paneIdsByDirectory.set(currentDir, paneId);
      return paneId;
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
    
    // Mark this pane for this specific directory
    const envVarName = `CLAUDE_DIR_${getDirectoryHash(currentDir)}`;
    await execAsync(`tmux set-environment ${envVarName} 1`);
    
    // Get the new pane's address
    const { stdout: newPaneInfo } = await execAsync(`tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'`);
    const newPaneId = newPaneInfo.trim();
    paneIdsByDirectory.set(currentDir, newPaneId);
    
    // Set a custom pane border format to identify it
    await execAsync(`tmux select-pane -T "${paneName}"`);
    
    // Return to the original pane
    await execAsync(`tmux select-pane -t '${originalPaneId}'`);
    
    return newPaneId;
  } catch (error) {
    throw new Error(`Failed to create pane: ${error}`);
  }
}

async function executeInPane(paneId: string, command: string, captureOutput: boolean = true): Promise<CommandExecution> {
  const commandId = Date.now().toString() + Math.random().toString(36).substring(7);
  const startTime = Date.now();
  
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
          
          // Check for interactive prompts
          const promptCheck = checkForPrompt(paneContent);
          
          const result: CommandExecution = {
            commandId,
            command,
            output,
            exitCode: 0,
            linesCaptuerd: output.split('\n').length,
            ...promptCheck
          };
          
          // Log the command
          await logCommand({
            timestamp: new Date().toISOString(),
            command,
            output,
            exitCode: 0,
            duration: Date.now() - startTime,
            requiresInteraction: promptCheck.requiresInteraction,
            interactionType: promptCheck.type
          });
          
          return result;
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
      
      // Check for prompts in the full pane content
      const { stdout: fullContent } = await execAsync(`tmux capture-pane -t ${paneId} -p -S -`);
      const promptCheck = checkForPrompt(fullContent);
      
      const result: CommandExecution = {
        commandId,
        command,
        output: markedOutput.trim(),
        exitCode: 0,
        linesCaptuerd: markedOutput.trim().split('\n').length,
        ...promptCheck
      };
      
      // Log the command
      await logCommand({
        timestamp: new Date().toISOString(),
        command,
        output: markedOutput.trim(),
        exitCode: 0,
        duration: Date.now() - startTime,
        requiresInteraction: promptCheck.requiresInteraction,
        interactionType: promptCheck.type
      });
      
      return result;
    } catch (error) {
      const errorResult: CommandExecution = {
        commandId,
        command,
        output: `Error capturing output: ${error}`,
        exitCode: -1,
        linesCaptuerd: 0
      };
      
      await logCommand({
        timestamp: new Date().toISOString(),
        command,
        output: errorResult.output,
        exitCode: -1,
        duration: Date.now() - startTime
      });
      
      return errorResult;
    }
  } else {
    // Even without capturing output, check for prompts after a short delay
    await new Promise(resolve => setTimeout(resolve, 500));
    const { stdout: paneContent } = await execAsync(`tmux capture-pane -t ${paneId} -p -S -10`);
    const promptCheck = checkForPrompt(paneContent);
    
    const result: CommandExecution = {
      commandId,
      command,
      output: "Command sent (output not captured)",
      exitCode: 0,
      linesCaptuerd: 0,
      ...promptCheck
    };
    
    await logCommand({
      timestamp: new Date().toISOString(),
      command,
      output: "[output not captured]",
      exitCode: 0,
      duration: Date.now() - startTime,
      requiresInteraction: promptCheck.requiresInteraction,
      interactionType: promptCheck.type
    });
    
    return result;
  }
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "execute_command",
      description: "Execute a command in a tmux pane (creates directory-specific pane if needed)",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute in the tmux pane" },
          pane: { type: "string", description: "Target pane (default: directory-specific pane)" },
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
          name: { type: "string", description: "Name for the new pane (default: directory-specific)" },
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
          pane: { type: "string", description: "Pane to capture from (default: directory-specific)" },
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
        
        // Find or create the pane (uses directory-aware naming if no pane specified)
        const paneId = await findOrCreatePane(pane);
        
        // Execute the command
        const result = await executeInPane(paneId, command, captureOutput);
        
        // If interaction is required, format a special message
        if (result.requiresInteraction) {
          return {
            content: [
              {
                type: "text",
                text: `⚠️ User interaction required in tmux pane\n\n` +
                      `${result.interactionMessage}\n\n` +
                      `The command is waiting for user input. You can:\n` +
                      `1. Click this command to paste it: ${command}\n` +
                      `2. Switch to the tmux pane to provide input\n\n` +
                      `Output so far:\n${result.output}`
              }
            ]
          };
        }
        
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
  // Ensure log directory exists
  await ensureLogDir();
  
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