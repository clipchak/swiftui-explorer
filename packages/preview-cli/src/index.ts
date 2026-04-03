import * as http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

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

type PreviewOpenRequest = {
  targetId: string;
  fixtureId?: string;
  environmentId?: string;
  simulatorId?: string;
};

type PreviewOpenResponse = {
  version: string;
  status: "launched" | "refreshed";
  appName: string;
  scheme: string;
  simulatorId: string;
  simulatorName: string;
  bundleIdentifier: string;
  targetId: string;
  fixtureId: string | null;
  environmentId: string | null;
};

type SimulatorDevice = {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  runtime: string;
};

type LastPreviewState = {
  targetId: string;
  fixtureId?: string;
  environmentId?: string;
  simulatorId?: string;
};

class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

const VERSION = "0.1.0";
const SERVICE = "swiftui-explorer-preview-cli";
const DEFAULT_PORT = 4123;
const SAMPLE_APP_BUNDLE_IDENTIFIER = "com.swiftuiexplorer.example.SampleSwiftUIApp";
const execFileAsync = promisify(execFile);

const workspaceRoot = process.env.SWIFTUI_EXPLORER_WORKSPACE_ROOT ?? process.cwd();
const port = Number.parseInt(process.env.SWIFTUI_EXPLORER_PORT ?? `${DEFAULT_PORT}`, 10);
let lastPreviewState: LastPreviewState | null = null;

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error: unknown) => {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : "Unknown runtime error";

    writeJson(response, statusCode, {
      version: VERSION,
      error: message,
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`[swiftui-explorer] runtime listening on http://127.0.0.1:${port}\n`);
});

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
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

  if (request.method === "POST" && requestUrl.pathname === "/api/v1/preview/open") {
    const body = await readJsonBody<PreviewOpenRequest>(request);
    const launchedPreview = await openPreview(workspaceRoot, body, "launched");
    writeJson<PreviewOpenResponse>(response, 200, launchedPreview);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/v1/preview/refresh") {
    if (!lastPreviewState) {
      throw new HttpError(409, "No preview has been opened yet.");
    }

    const refreshedPreview = await openPreview(workspaceRoot, lastPreviewState, "refreshed");
    writeJson<PreviewOpenResponse>(response, 200, refreshedPreview);
    return;
  }

  writeJson(response, 404, {
    version: VERSION,
    error: "Not found",
  });
}

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
    return "Preview launch is available. Use Open Preview In Simulator, then Refresh Preview to relaunch the last selection.";
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

async function openPreview(
  root: string,
  input: PreviewOpenRequest,
  status: "launched" | "refreshed",
): Promise<PreviewOpenResponse> {
  if (!input.targetId) {
    throw new HttpError(400, "targetId is required.");
  }

  const sampleApp = getSampleAppPaths(root);
  await ensureSampleProject(sampleApp, root);

  const manifest = readPreviewManifest(sampleApp.manifestPath);
  if (!manifest) {
    throw new HttpError(400, "Preview manifest is missing or invalid.");
  }

  const target = manifest.targets.find((candidate) => candidate.id === input.targetId);
  if (!target) {
    throw new HttpError(404, `Unknown preview target: ${input.targetId}`);
  }

  const fixture = resolveFixture(target, input.fixtureId);
  const environment = resolveEnvironment(target, input.environmentId);
  const simulator = await resolveSimulator(input.simulatorId);

  await ensureSimulatorBooted(simulator.udid);
  await focusSimulatorApp(simulator.udid);
  const appPath = await buildSampleApp(sampleApp, root, manifest.scheme, simulator.udid);
  await installAndLaunchSampleApp(appPath, simulator.udid, {
    targetId: target.id,
    fixtureId: fixture?.id ?? null,
    environmentId: environment?.id ?? null,
  });
  await focusSimulatorApp(simulator.udid);

  lastPreviewState = {
    targetId: target.id,
    ...(fixture?.id ? { fixtureId: fixture.id } : {}),
    ...(environment?.id ? { environmentId: environment.id } : {}),
    simulatorId: simulator.udid,
  };

  return {
    version: VERSION,
    status,
    appName: manifest.appName,
    scheme: manifest.scheme,
    simulatorId: simulator.udid,
    simulatorName: simulator.name,
    bundleIdentifier: SAMPLE_APP_BUNDLE_IDENTIFIER,
    targetId: target.id,
    fixtureId: fixture?.id ?? null,
    environmentId: environment?.id ?? null,
  };
}

function getSampleAppPaths(root: string): {
  sampleRoot: string;
  specPath: string;
  projectPath: string;
  manifestPath: string;
  derivedDataPath: string;
  appPath: string;
} {
  const sampleRoot = path.join(root, "examples", "sample-swiftui-app");
  const derivedDataPath = path.join(root, ".swiftui-explorer", "derived-data", "sample-swiftui-app");

  return {
    sampleRoot,
    specPath: path.join(sampleRoot, "project.yml"),
    projectPath: path.join(sampleRoot, "SampleSwiftUIApp.xcodeproj"),
    manifestPath: path.join(sampleRoot, "SampleSwiftUIApp", "Resources", "PreviewManifest.json"),
    derivedDataPath,
    appPath: path.join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator", "SampleSwiftUIApp.app"),
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

async function ensureSampleProject(
  sampleApp: ReturnType<typeof getSampleAppPaths>,
  root: string,
): Promise<void> {
  if (existsSync(sampleApp.projectPath)) {
    return;
  }

  if (!existsSync(sampleApp.specPath)) {
    throw new HttpError(400, "Sample app project spec was not found.");
  }

  await runCommand("xcodegen", ["generate", "--spec", sampleApp.specPath], root);
}

function resolveFixture(target: PreviewDescriptor, fixtureId?: string): PreviewFixture | null {
  if (!fixtureId) {
    return target.fixtures[0] ?? null;
  }

  const fixture = target.fixtures.find((candidate) => candidate.id === fixtureId);
  if (!fixture) {
    throw new HttpError(400, `Unknown fixture '${fixtureId}' for target '${target.id}'.`);
  }

  return fixture;
}

function resolveEnvironment(target: PreviewDescriptor, environmentId?: string): PreviewEnvironment | null {
  if (!environmentId) {
    return target.supportedEnvironments[0] ?? null;
  }

  const environment = target.supportedEnvironments.find((candidate) => candidate.id === environmentId);
  if (!environment) {
    throw new HttpError(400, `Unknown environment '${environmentId}' for target '${target.id}'.`);
  }

  return environment;
}

async function resolveSimulator(requestedSimulatorId?: string): Promise<SimulatorDevice> {
  const simulators = await listAvailableSimulators();

  if (requestedSimulatorId) {
    const match = simulators.find((simulator) => simulator.udid === requestedSimulatorId);
    if (!match) {
      throw new HttpError(404, `Simulator '${requestedSimulatorId}' was not found.`);
    }
    return match;
  }

  const bootedSimulator = simulators.find((simulator) => simulator.state === "Booted");
  if (bootedSimulator) {
    return bootedSimulator;
  }

  const preferredNames = ["iPhone 16 Pro", "iPhone 16", "iPhone 15 Pro"];
  for (const preferredName of preferredNames) {
    const match = simulators.find((simulator) => simulator.name === preferredName);
    if (match) {
      return match;
    }
  }

  const fallback = simulators.find((simulator) => simulator.name.startsWith("iPhone"));
  if (fallback) {
    return fallback;
  }

  throw new HttpError(500, "No available iOS simulators were found.");
}

async function listAvailableSimulators(): Promise<SimulatorDevice[]> {
  const { stdout } = await runCommand("xcrun", ["simctl", "list", "devices", "available", "-j"], workspaceRoot);
  const parsed = JSON.parse(stdout) as {
    devices?: Record<string, Array<{ udid: string; name: string; state: string; isAvailable: boolean }>>;
  };

  const simulators: SimulatorDevice[] = [];

  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    if (!runtime.includes("iOS")) {
      continue;
    }

    for (const device of devices) {
      if (!device.isAvailable) {
        continue;
      }

      simulators.push({
        udid: device.udid,
        name: device.name,
        state: device.state,
        isAvailable: device.isAvailable,
        runtime,
      });
    }
  }

  return simulators;
}

async function ensureSimulatorBooted(simulatorId: string): Promise<void> {
  await runCommand("xcrun", ["simctl", "boot", simulatorId], workspaceRoot, {
    allowFailure: true,
  });
  await runCommand("xcrun", ["simctl", "bootstatus", simulatorId, "-b"], workspaceRoot);
}

async function focusSimulatorApp(simulatorId: string): Promise<void> {
  await runCommand("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", simulatorId], workspaceRoot, {
    allowFailure: true,
  });
  await runCommand(
    "osascript",
    [
      "-e",
      'tell application "Simulator" to activate',
      "-e",
      "delay 0.3",
      "-e",
      'tell application "System Events"',
      "-e",
      'if exists process "Simulator" then set frontmost of process "Simulator" to true',
      "-e",
      "end tell",
    ],
    workspaceRoot,
    {
      allowFailure: true,
    },
  );
}

async function buildSampleApp(
  sampleApp: ReturnType<typeof getSampleAppPaths>,
  root: string,
  scheme: string,
  simulatorId: string,
): Promise<string> {
  mkdirSync(sampleApp.derivedDataPath, {
    recursive: true,
  });

  await runCommand(
    "xcodebuild",
    [
      "-project",
      sampleApp.projectPath,
      "-scheme",
      scheme,
      "-destination",
      `id=${simulatorId}`,
      "-derivedDataPath",
      sampleApp.derivedDataPath,
      "build",
    ],
    root,
  );

  if (!existsSync(sampleApp.appPath)) {
    throw new HttpError(500, `Built app not found at '${sampleApp.appPath}'.`);
  }

  return sampleApp.appPath;
}

async function installAndLaunchSampleApp(
  appPath: string,
  simulatorId: string,
  selection: {
    targetId: string;
    fixtureId: string | null;
    environmentId: string | null;
  },
): Promise<void> {
  await runCommand("xcrun", ["simctl", "install", simulatorId, appPath], workspaceRoot);

  await runCommand(
    "xcrun",
    ["simctl", "launch", "--terminate-running-process", simulatorId, SAMPLE_APP_BUNDLE_IDENTIFIER],
    workspaceRoot,
    {
      env: {
        SIMCTL_CHILD_SWIFTUI_EXPLORER_TARGET_ID: selection.targetId,
        ...(selection.fixtureId ? { SIMCTL_CHILD_SWIFTUI_EXPLORER_FIXTURE_ID: selection.fixtureId } : {}),
        ...(selection.environmentId ? { SIMCTL_CHILD_SWIFTUI_EXPLORER_ENVIRONMENT_ID: selection.environmentId } : {}),
      },
    },
  );
}

async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");

  if (!body) {
    throw new HttpError(400, "Request body is required.");
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
  },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: {
        ...process.env,
        ...options?.env,
      },
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (options?.allowFailure) {
      return {
        stdout: "",
        stderr: "",
      };
    }

    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "";
    const details = [stderr, stdout].filter(Boolean).join("\n").trim();
    const message = details ? `${command} failed: ${details}` : `${command} failed.`;

    throw new HttpError(500, message);
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
