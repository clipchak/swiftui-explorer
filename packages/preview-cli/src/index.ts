import * as http from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  hasXcodeGenSpec: boolean;
  suggestedNextAction: string;
};

type PreviewFixture = {
  id: string;
  displayName: string;
};

type PreviewEnvironment = {
  id: string;
  displayName: string;
  colorScheme: "light" | "dark";
  localeIdentifier: string;
  dynamicTypeSize: string;
};

type PreviewDescriptor = {
  id: string;
  displayName: string;
  fixtures: PreviewFixture[];
  supportedEnvironments: PreviewEnvironment[];
};

type PreviewManifest = {
  appName: string;
  scheme: string;
  targets: PreviewDescriptor[];
};

type PreviewTargetDiscovery = {
  version: string;
  appName: string | null;
  scheme: string | null;
  projectPath: string | null;
  manifestPath: string | null;
  targets: PreviewDescriptor[];
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

  if (request.method === "GET" && requestUrl.pathname === "/api/v1/targets") {
    writeJson<PreviewTargetDiscovery>(response, 200, discoverPreviewTargets(workspaceRoot));
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
  const hasPackageSwift = hasPathSuffix(root, "Package.swift");
  const sampleApp = getSampleAppPaths(root);
  const hasXcodeProject = hasPathSuffix(root, ".xcodeproj");
  const hasWorkspace = hasPathSuffix(root, ".xcworkspace");
  const hasXcodeGenSpec = existsSync(sampleApp.specPath);
  const hasPreviewManifest = existsSync(sampleApp.manifestPath);
  const hasGeneratedSampleProject = existsSync(sampleApp.projectPath);

  return {
    version: VERSION,
    workspaceRoot: root,
    hasPackageSwift,
    hasXcodeProject,
    hasWorkspace,
    hasXcodeGenSpec,
    suggestedNextAction: suggestNextAction({
      hasPackageSwift,
      hasXcodeProject,
      hasWorkspace,
      hasXcodeGenSpec,
      hasPreviewManifest,
      hasGeneratedSampleProject,
    }),
  };
}

function suggestNextAction(input: {
  hasPackageSwift: boolean;
  hasXcodeProject: boolean;
  hasWorkspace: boolean;
  hasXcodeGenSpec: boolean;
  hasPreviewManifest: boolean;
  hasGeneratedSampleProject: boolean;
}): string {
  if (input.hasXcodeGenSpec && !input.hasGeneratedSampleProject) {
    return "Generate the sample app project with XcodeGen, then point the runtime at that app target.";
  }

  if (!input.hasXcodeProject && !input.hasWorkspace) {
    return "Add a sample SwiftUI host app or point the runtime at an existing app workspace.";
  }

  if (!input.hasPackageSwift) {
    return "Add SwiftPreviewKit to the host app and start defining preview targets.";
  }

  if (input.hasPreviewManifest) {
    return "Preview targets are available. Next, wire selection into simulator launch and refresh.";
  }

  return "Add a preview manifest so the runtime can discover targets and fixtures.";
}

function fileExists(root: string, filename: string): boolean {
  return existsSync(path.join(root, filename));
}

function hasPathSuffix(root: string, suffix: string, depth = 3): boolean {
  return walk(root, depth).some((entry) => entry.endsWith(suffix));
}

function discoverPreviewTargets(root: string): PreviewTargetDiscovery {
  const sampleApp = getSampleAppPaths(root);
  const manifest = readPreviewManifest(sampleApp.manifestPath);

  return {
    version: VERSION,
    appName: manifest?.appName ?? null,
    scheme: manifest?.scheme ?? null,
    projectPath: existsSync(sampleApp.projectPath) ? sampleApp.projectPath : null,
    manifestPath: existsSync(sampleApp.manifestPath) ? sampleApp.manifestPath : null,
    targets: manifest?.targets ?? [],
  };
}

function getSampleAppPaths(root: string): {
  sampleRoot: string;
  specPath: string;
  projectPath: string;
  manifestPath: string;
} {
  const sampleRoot = path.join(root, "examples", "sample-swiftui-app");

  return {
    sampleRoot,
    specPath: path.join(sampleRoot, "project.yml"),
    projectPath: path.join(sampleRoot, "SampleSwiftUIApp.xcodeproj"),
    manifestPath: path.join(sampleRoot, "SampleSwiftUIApp", "Resources", "PreviewManifest.json"),
  };
}

function readPreviewManifest(manifestPath: string): PreviewManifest | null {
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as PreviewManifest;
  } catch {
    return null;
  }
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
