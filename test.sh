#!/bin/bash

# Test script for t-pane MCP server

echo "Testing t-pane MCP server..."
echo ""

# Build the project
echo "Building project..."
npm run build

echo ""
echo "To test the server:"
echo "1. Make sure you're in a tmux session"
echo "2. Add to Claude config:"
echo '   {
     "mcpServers": {
       "t-pane": {
         "command": "node",
         "args": ["'$(pwd)'/dist/index.js"]
       }
     }
   }'
echo ""
echo "3. Start Claude with: claude"
echo "4. Ask Claude to execute commands using the t-pane server"
echo ""
echo "Example prompts:"
echo "- 'Using the t-pane server, run ls -la'"
echo "- 'Execute df -h in the claude-terminal pane'"
echo "- 'Create a new pane called test-pane and run echo hello there'"