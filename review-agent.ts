import { query, AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";

interface ReviewResult {
  issues: Array<{
    severity: "low" | "medium" | "high" | "critical";
    category: "bug" | "security" | "performance" | "style";
    file: string;
    line?: number;
    description: string;
    suggestion?: string;
  }>;
  summary: string;
  overallScore: number;
}

const reviewSchema = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          category: { type: "string", enum: ["bug", "security", "performance", "style"] },
          file: { type: "string" },
          line: { type: "number" },
          description: { type: "string" },
          suggestion: { type: "string" }
        },
        required: ["severity", "category", "file", "description"]
      }
    },
    summary: { type: "string" },
    overallScore: { type: "number" }
  },
  required: ["issues", "summary", "overallScore"]
};

interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

interface TaskInput {
  subagent_type?: string;
}

function validateDirectory(directory: string): string {
  const resolvedPath = path.resolve(directory);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Directory does not exist: ${resolvedPath}`);
  }
  if (!fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolvedPath}`);
  }
  return resolvedPath;
}

function isValidReviewResult(obj: unknown): obj is ReviewResult {
  if (typeof obj !== "object" || obj === null) return false;
  const result = obj as Record<string, unknown>;
  if (!Array.isArray(result.issues)) return false;
  if (typeof result.summary !== "string") return false;
  if (typeof result.overallScore !== "number") return false;
  return true;
}

async function runCodeReview(directory: string): Promise<ReviewResult | null> {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`🔍 Code Review Agent`);
  console.log(`📁 Directory: ${directory}`);
  console.log(`${"=".repeat(50)}\n`);

  let result: ReviewResult | null = null;

  for await (const message of query({
    prompt: `Perform a thorough code review of ${directory}.

Analyze all source files for:
1. Bugs and potential runtime errors
2. Security vulnerabilities
3. Performance issues
4. Code quality and maintainability

Be specific with file paths and line numbers where possible.`,
    options: {
      model: "opus",
      allowedTools: ["Read", "Glob", "Grep", "Task"],
      permissionMode: "default",
      maxTurns: 50,
      outputFormat: {
        type: "json_schema",
        schema: reviewSchema
      },
      agents: {
        "security-scanner": {
          description: "Deep security analysis for vulnerabilities",
          prompt: `You are a security expert. Scan for:
- Injection vulnerabilities (SQL, XSS, command injection)
- Authentication and authorization flaws
- Sensitive data exposure
- Insecure dependencies`,
          tools: ["Read", "Grep", "Glob"],
          model: "sonnet"
        } satisfies AgentDefinition
      }
    }
  })) {
    // Progress updates
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if ("name" in block && "input" in block) {
          const toolBlock = block as ToolUseBlock;
          if (toolBlock.name === "Task") {
            const taskInput = toolBlock.input as TaskInput;
            console.log(`🤖 Delegating to: ${taskInput.subagent_type ?? "unknown"}`);
          } else {
            console.log(`📂 ${toolBlock.name}: ${getToolSummary(toolBlock)}`);
          }
        }
      }
    }

    // Final result
    if (message.type === "result") {
      if (message.subtype === "success" && message.structured_output) {
        if (isValidReviewResult(message.structured_output)) {
          result = message.structured_output;
          console.log(`\n✅ Review complete! Cost: $${(message.total_cost_usd ?? 0).toFixed(4)}`);
        } else {
          console.log(`\n❌ Review failed: Invalid response structure`);
        }
      } else {
        console.log(`\n❌ Review failed: ${message.subtype}`);
      }
    }
  }

  return result;
}

function getToolSummary(block: ToolUseBlock): string {
  const input = block.input;
  switch (block.name) {
    case "Read": return String(input.file_path ?? "file");
    case "Glob": return String(input.pattern ?? "pattern");
    case "Grep": return `"${input.pattern ?? ""}" in ${input.path ?? "."}`;
    default: return "";
  }
}

function printResults(result: ReviewResult) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`📊 REVIEW RESULTS`);
  console.log(`${"=".repeat(50)}\n`);
  
  console.log(`Score: ${result.overallScore}/100`);
  console.log(`Issues Found: ${result.issues.length}\n`);
  console.log(`Summary: ${result.summary}\n`);
  
  const byCategory = {
    critical: result.issues.filter(i => i.severity === "critical"),
    high: result.issues.filter(i => i.severity === "high"),
    medium: result.issues.filter(i => i.severity === "medium"),
    low: result.issues.filter(i => i.severity === "low")
  };
  
  for (const [severity, issues] of Object.entries(byCategory)) {
    if (issues.length === 0) continue;
    
    const icon = severity === "critical" ? "🔴" :
                 severity === "high" ? "🟠" :
                 severity === "medium" ? "🟡" : "🟢";
    
    console.log(`\n${icon} ${severity.toUpperCase()} (${issues.length})`);
    console.log("-".repeat(30));
    
    for (const issue of issues) {
      const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
      console.log(`\n[${issue.category}] ${location}`);
      console.log(`  ${issue.description}`);
      if (issue.suggestion) {
        console.log(`  💡 ${issue.suggestion}`);
      }
    }
  }
}

// Run the review
async function main() {
  const directory = process.argv[2] || ".";

  let validatedDirectory: string;
  try {
    validatedDirectory = validateDirectory(directory);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const result = await runCodeReview(validatedDirectory);

  if (result) {
    printResults(result);
  }
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});