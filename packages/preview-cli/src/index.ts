import * as http from "node:http";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";

type HealthResponse = {
  version: string;
  status: "ok";
  service: string;
};

type WorkspaceInspection = {
  version: string;
  workspaceRoot: string;
  hasPackageSwift: boolean;
  hasXcodeProject: boolean;
  hasWorkspace: boolean;
  suggestedNextAction: string;
};

const VERSION = "0.1.0";
const SERVICE = "swiftui-explorer-preview-cli";
const DEFAULT_PORT = 4123;

const workspaceRoot = process.env.SWIFTUI_EXPLORER_WORKSPACE_ROOT ?? process.cwd();
const port = Number.parseInt(process.env.SWIFTUI_EXPLORER_PORT ?? `${DEFAULT_PORT}`, 10);

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    writeJson<HealthResponse>(response, 200, {
      version: VERSION,
      status: "ok",
      service: SERVICE,
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/v1/workspace/inspect") {
    writeJson<WorkspaceInspection>(response, 200, inspectWorkspace(workspaceRoot));
    return;
  }

  writeJson(response, 404, {
    version: VERSION,
    error: "Not found",
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`[swiftui-explorer] runtime listening on http://127.0.0.1:${port}\n`);
});

function inspectWorkspace(root: string): WorkspaceInspection {
  const hasPackageSwift = fileExists(root, "Package.swift");
  const hasXcodeProject = hasPathSuffix(root, ".xcodeproj");
  const hasWorkspace = hasPathSuffix(root, ".xcworkspace");

  return {
    version: VERSION,
    workspaceRoot: root,
    hasPackageSwift,
    hasXcodeProject,
    hasWorkspace,
    suggestedNextAction: suggestNextAction({
      hasPackageSwift,
      hasXcodeProject,
      hasWorkspace,
    }),
  };
}

function suggestNextAction(input: {
  hasPackageSwift: boolean;
  hasXcodeProject: boolean;
  hasWorkspace: boolean;
}): string {
  if (!input.hasXcodeProject && !input.hasWorkspace) {
    return "Add a sample SwiftUI host app or point the runtime at an existing app workspace.";
  }

  if (!input.hasPackageSwift) {
    return "Add SwiftPreviewKit to the host app and start defining preview targets.";
  }

  return "Next, implement preview target discovery and simulator session startup.";
}

function fileExists(root: string, filename: string): boolean {
  return existsSync(path.join(root, filename));
}

function hasPathSuffix(root: string, suffix: string, depth = 3): boolean {
  return walk(root, depth).some((entry) => entry.endsWith(suffix));
}

function walk(root: string, depth: number): string[] {
  if (depth < 0) {
    return [];
  }

  const entries = readdirSync(root, {
    withFileTypes: true,
  });

  const paths: string[] = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    const absolutePath = path.join(root, entry.name);
    paths.push(absolutePath);

    if (entry.isDirectory()) {
      paths.push(...walk(absolutePath, depth - 1));
    }
  }

  return paths;
}

function writeJson<T>(response: http.ServerResponse, statusCode: number, body: T): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
