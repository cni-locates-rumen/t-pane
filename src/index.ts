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

interface BackgroundTask {
  id: string;
  task: string;
  outputFile: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime: string;
  endTime?: string;
  paneId?: string;
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

const sendKeysSchema = z.object({
  text: z.string().describe("Text to send to the pane"),
  pane: z.string().optional().describe("Target pane (default: directory-specific pane)"),
  enter: z.boolean().optional().default(false).describe("Whether to send Enter after the text")
});

const launchBackgroundTaskSchema = z.object({
  task: z.string().describe("The task description for Claude to execute"),
  outputFile: z.string().describe("Filename for the output (will be saved in .t-pane/tasks/)"),
  timeout: z.number().optional().default(300000).describe("Maximum time in milliseconds (default: 5 minutes)")
});

const readFileSchema = z.object({
  filePath: z.string().describe("Path to the file to read"),
  lines: z.number().optional().describe("Number of lines to show (default: all)")
});

const editFileSchema = z.object({
  filePath: z.string().describe("Path to the file to edit"),
  search: z.string().describe("Text to search for"),
  replace: z.string().describe("Text to replace with")
});

// Server setup
const server = new Server(
  {
    name: "t-pane",
    version: "0.4.0",
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
  
  // Add process ID or random suffix to ensure uniqueness
  const uniqueId = process.pid ? process.pid.toString().slice(-4) : Math.random().toString(36).substring(2, 6);
  
  // If suffix is too long or empty, use hash
  if (!suffix || suffix.length > 20) {
    return `claude-${getDirectoryHash(dir)}-${uniqueId}`;
  }
  
  return `claude-${suffix}-${uniqueId}`;
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

// Background task management
const TASKS_DIR = '.t-pane/tasks';

// Get tasks directory
function getTasksDir(): string {
  return path.join(getCurrentDirectory(), TASKS_DIR);
}

// Ensure tasks directory exists
async function ensureTasksDir(): Promise<void> {
  const tasksDir = getTasksDir();
  await fs.mkdir(tasksDir, { recursive: true });
}

// Get task status file path
function getTaskStatusFile(): string {
  return path.join(getTasksDir(), 'status.json');
}

// Load task status
async function loadTaskStatus(): Promise<BackgroundTask[]> {
  try {
    const statusFile = getTaskStatusFile();
    const data = await fs.readFile(statusFile, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

// Save task status
async function saveTaskStatus(tasks: BackgroundTask[]): Promise<void> {
  await ensureTasksDir();
  const statusFile = getTaskStatusFile();
  await fs.writeFile(statusFile, JSON.stringify(tasks, null, 2));
}

// Create CLAUDE.md for background task
function createTaskClaudeMd(task: string, outputFile: string): string {
  return `# Background Task Instructions

## Your Task
${task}

## Output Requirements
1. Save your findings/results to: ${outputFile}
2. Use markdown format for the output
3. Include a summary at the top
4. Be thorough but concise
5. When complete, save the file and exit

## Important
- This is a background task running independently
- Focus only on the task provided
- Do not make any code changes unless explicitly requested
- Save your work to the specified file only
`;
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
  
  // Get current pane to exclude it
  let currentPaneId = '';
  try {
    const { stdout } = await execAsync("tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'");
    currentPaneId = stdout.trim();
  } catch (error) {
    // Ignore error
  }
  
  // Check if we already have a pane ID stored for this directory
  const storedPaneId = paneIdsByDirectory.get(currentDir);
  if (storedPaneId && storedPaneId !== currentPaneId) {
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
  
  // Create new pane in a new window to avoid conflicts
  try {
    // Create a new window with the pane name
    await execAsync(`tmux new-window -n "${paneName}" -c "${currentDir}"`);
    
    // Get the new pane's address
    const { stdout: newPaneInfo } = await execAsync(`tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'`);
    const newPaneId = newPaneInfo.trim();
    
    // Mark this pane for this specific directory
    const envVarName = `CLAUDE_DIR_${getDirectoryHash(currentDir)}`;
    await execAsync(`tmux set-environment ${envVarName} 1`);
    
    // Store the pane ID
    paneIdsByDirectory.set(currentDir, newPaneId);
    
    // Switch back to the original window
    await execAsync(`tmux last-window`);
    
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
      const markedCommand = `echo "===CMD_${commandId}_START==="; ${command}; echo "===CMD_${commandId}_END==="`;
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
    },
    {
      name: "send_keys",
      description: "Send text/keys to a tmux pane (useful for pre-filling commands)",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to send to the pane" },
          pane: { type: "string", description: "Target pane (default: directory-specific pane)" },
          enter: { type: "boolean", description: "Whether to send Enter after the text", default: false }
        },
        required: ["text"]
      }
    },
    {
      name: "launch_background_task",
      description: "Launch a Claude instance in background to perform a research/analysis task",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task description for Claude to execute" },
          outputFile: { type: "string", description: "Filename for the output (will be saved in .t-pane/tasks/)" },
          timeout: { type: "number", description: "Maximum time in milliseconds (default: 5 minutes)", default: 300000 }
        },
        required: ["task", "outputFile"]
      }
    },
    {
      name: "check_background_tasks",
      description: "Check status of background tasks",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "read_file",
      description: "Read a file using cat/head/tail commands in tmux pane",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to the file to read" },
          lines: { type: "number", description: "Number of lines to show (default: all)" }
        },
        required: ["filePath"]
      }
    },
    {
      name: "edit_file",
      description: "Edit a file using sed in tmux pane (visible to user)",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to the file to edit" },
          search: { type: "string", description: "Text to search for" },
          replace: { type: "string", description: "Text to replace with" }
        },
        required: ["filePath", "search", "replace"]
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
        
        // If interaction is required, format a special message and pre-fill the command
        if (result.requiresInteraction) {
          // Pre-fill the command in the pane (without Enter)
          try {
            await execAsync(`tmux send-keys -t ${paneId} ${JSON.stringify(command)}`);
          } catch (error) {
            // Continue even if pre-fill fails
          }
          
          return {
            content: [
              {
                type: "text",
                text: `⚠️ User interaction required in tmux pane\n\n` +
                      `${result.interactionMessage}\n\n` +
                      `I've pre-filled the command for you (without pressing Enter).\n` +
                      `Switch to the tmux pane to review and execute it.\n\n` +
                      `Command waiting: ${command}\n\n` +
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
      
      case "send_keys": {
        const { text, pane, enter } = sendKeysSchema.parse(args);
        
        // Find or create the pane
        const paneId = await findOrCreatePane(pane);
        
        // Send the text
        const enterKey = enter ? ' Enter' : '';
        await execAsync(`tmux send-keys -t ${paneId} ${JSON.stringify(text)}${enterKey}`);
        
        return {
          content: [
            {
              type: "text",
              text: `Text sent to pane${enter ? ' and executed' : ' (without Enter)'}: ${text}`
            }
          ]
        };
      }
      
      case "launch_background_task": {
        const { task, outputFile, timeout } = launchBackgroundTaskSchema.parse(args);
        
        // Create task ID and metadata
        const taskId = Date.now().toString() + Math.random().toString(36).substring(7);
        const outputPath = path.join(getTasksDir(), outputFile);
        
        // Create a new pane for the background task
        const paneName = `task-${taskId.substring(0, 8)}`;
        const paneId = await findOrCreatePane(paneName);
        
        // Create task record
        const newTask: BackgroundTask = {
          id: taskId,
          task,
          outputFile,
          status: 'pending',
          startTime: new Date().toISOString(),
          paneId
        };
        
        // Load existing tasks and add new one
        const tasks = await loadTaskStatus();
        tasks.push(newTask);
        await saveTaskStatus(tasks);
        
        // Create CLAUDE.md in tasks directory
        const claudeMdPath = path.join(getTasksDir(), 'CLAUDE.md');
        await fs.writeFile(claudeMdPath, createTaskClaudeMd(task, outputPath));
        
        // Create a simple command for the user to run Claude with the task
        const claudePrompt = `echo "Task: ${task}" && echo "Output to: ${outputPath}" && echo "" && echo "Run: claude" && echo "Then ask Claude to complete the task and save to the output file"`;
        await execAsync(`tmux send-keys -t ${paneId} ${JSON.stringify(claudePrompt)} Enter`);
        
        // Update task status to running
        newTask.status = 'running';
        await saveTaskStatus(tasks);
        
        // Set up a timeout to mark task as failed if it takes too long
        setTimeout(async () => {
          const currentTasks = await loadTaskStatus();
          const taskIndex = currentTasks.findIndex(t => t.id === taskId);
          if (taskIndex !== -1 && currentTasks[taskIndex].status === 'running') {
            currentTasks[taskIndex].status = 'failed';
            currentTasks[taskIndex].endTime = new Date().toISOString();
            await saveTaskStatus(currentTasks);
          }
        }, timeout);
        
        return {
          content: [
            {
              type: "text",
              text: `Background task launched!\n\n` +
                    `Task ID: ${taskId}\n` +
                    `Pane: ${paneName}\n` +
                    `Output will be saved to: ${outputPath}\n\n` +
                    `Use check_background_tasks to monitor progress.`
            }
          ]
        };
      }
      
      case "check_background_tasks": {
        const tasks = await loadTaskStatus();
        
        // Check output files to update status
        for (const task of tasks) {
          if (task.status === 'running') {
            const outputPath = path.join(getTasksDir(), task.outputFile);
            try {
              await fs.access(outputPath);
              // If file exists, mark as completed
              task.status = 'completed';
              task.endTime = new Date().toISOString();
            } catch (error) {
              // File doesn't exist yet, still running
            }
          }
        }
        
        // Save updated status
        await saveTaskStatus(tasks);
        
        // Format output
        const taskSummary = tasks.map(task => {
          const duration = task.endTime 
            ? `${Math.round((new Date(task.endTime).getTime() - new Date(task.startTime).getTime()) / 1000)}s`
            : 'running';
          return `- [${task.status}] ${task.outputFile} (${duration})\n  Task: ${task.task}`;
        }).join('\n\n');
        
        return {
          content: [
            {
              type: "text",
              text: tasks.length > 0 
                ? `Background Tasks:\n\n${taskSummary}`
                : "No background tasks found."
            }
          ]
        };
      }
      
      case "read_file": {
        const { filePath, lines } = readFileSchema.parse(args);
        
        // Find or create the pane
        const paneId = await findOrCreatePane();
        
        // Build the command
        let command: string;
        if (lines && lines > 0) {
          command = `head -n ${lines} ${filePath}`;
        } else {
          command = `cat ${filePath}`;
        }
        
        // Execute the command
        const result = await executeInPane(paneId, command, true);
        
        return {
          content: [
            {
              type: "text",
              text: `File: ${filePath}\n\n${result.output}`
            }
          ]
        };
      }
      
      case "edit_file": {
        const { filePath, search, replace } = editFileSchema.parse(args);
        
        // Find or create the pane
        const paneId = await findOrCreatePane();
        
        // First, show the change that will be made
        const grepCommand = `grep -n "${search}" ${filePath} | head -5`;
        await executeInPane(paneId, grepCommand, true);
        
        // Build the sed command (using -i for in-place edit)
        const sedCommand = `sed -i '' 's/${search.replace(/[[\.^$()|*+?{]/g, '\\$&')}/${replace.replace(/[[\.^$()|*+?{]/g, '\\$&')}/g' ${filePath}`;
        
        // Execute the edit
        const result = await executeInPane(paneId, sedCommand, true);
        
        // Show confirmation
        const confirmCommand = `echo "File edited: ${filePath}"`;
        await executeInPane(paneId, confirmCommand, true);
        
        return {
          content: [
            {
              type: "text",
              text: `Edited ${filePath}:\nReplaced "${search}" with "${replace}"`
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