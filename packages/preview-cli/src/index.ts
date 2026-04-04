import * as http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync, type FSWatcher } from "node:fs";
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
  status?: "placeholder" | "configured";
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

type AutoRefreshState = {
  version: string;
  enabled: boolean;
};

type ValidationResult = {
  version: string;
  success: boolean;
  diagnostics: string[];
};

type HostAppConfiguration = {
  version: string;
  usingDefault: boolean;
  appRoot: string;
  projectPath: string | null;
  workspacePath: string | null;
  xcodeGenSpecPath: string | null;
  scheme: string;
  manifestPath: string;
  bundleIdentifier: string;
};

type HostAppConfigurationInput = {
  appRoot?: unknown;
  projectPath?: unknown;
  workspacePath?: unknown;
  xcodeGenSpecPath?: unknown;
  scheme?: unknown;
  manifestPath?: unknown;
  bundleIdentifier?: unknown;
};

type PersistedHostAppConfiguration = {
  appRoot: string;
  projectPath?: string;
  workspacePath?: string;
  xcodeGenSpecPath?: string;
  scheme: string;
  manifestPath?: string;
  bundleIdentifier: string;
};

type RuntimeState = {
  autoRefreshEnabled: boolean;
  hostAppConfiguration?: PersistedHostAppConfiguration;
};

type ResolvedHostAppConfiguration = {
  usingDefault: boolean;
  appRoot: string;
  projectPath: string | null;
  workspacePath: string | null;
  xcodeGenSpecPath: string | null;
  scheme: string;
  manifestPath: string;
  bundleIdentifier: string;
  derivedDataPath: string;
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
const execFileAsync = promisify(execFile);
const AUTO_REFRESH_DELAY_MS = 600;

const workspaceRoot = process.env.SWIFTUI_EXPLORER_WORKSPACE_ROOT ?? process.cwd();
const port = Number.parseInt(process.env.SWIFTUI_EXPLORER_PORT ?? `${DEFAULT_PORT}`, 10);
let runtimeState = loadRuntimeState(workspaceRoot);
let lastPreviewState: LastPreviewState | null = null;
let previewWatchers: FSWatcher[] = [];
let autoRefreshTimer: NodeJS.Timeout | null = null;
let autoRefreshInFlight = false;
let pendingAutoRefresh = false;

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

  if (request.method === "GET" && requestUrl.pathname === "/api/v1/config") {
    writeJson<HostAppConfiguration>(response, 200, getHostAppConfigurationResponse(workspaceRoot));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/v1/config") {
    const body = await readJsonBody<HostAppConfigurationInput>(request);
    const nextConfiguration = validateHostAppConfigurationInput(body);
    runtimeState = {
      ...runtimeState,
      hostAppConfiguration: persistHostAppConfiguration(workspaceRoot, nextConfiguration),
    };
    saveRuntimeState(workspaceRoot, runtimeState);
    closePreviewWatchers();
    ensurePreviewWatchers(workspaceRoot);

    writeJson<HostAppConfiguration>(response, 200, getHostAppConfigurationResponse(workspaceRoot));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/v1/auto-refresh") {
    writeJson<AutoRefreshState>(response, 200, getAutoRefreshStateResponse());
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/v1/auto-refresh") {
    const body = await readJsonBody<{ enabled?: unknown }>(request);
    if (typeof body.enabled !== "boolean") {
      throw new HttpError(400, "enabled must be a boolean.");
    }

    runtimeState = {
      ...runtimeState,
      autoRefreshEnabled: body.enabled,
    };
    saveRuntimeState(workspaceRoot, runtimeState);

    process.stdout.write(
      `[swiftui-explorer] auto-refresh ${runtimeState.autoRefreshEnabled ? "enabled" : "disabled"}\n`,
    );

    writeJson<AutoRefreshState>(response, 200, getAutoRefreshStateResponse());
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/v1/validate") {
    const validation = await validateHostAppBuild(workspaceRoot);
    writeJson<ValidationResult>(response, 200, validation);
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
  const hostApp = resolveHostAppConfiguration(root);
  const hasPackageSwift = hasPathSuffix(root, "Package.swift");
  const hasXcodeProject = hasPathSuffix(root, ".xcodeproj");
  const hasWorkspace = hasPathSuffix(root, ".xcworkspace");
  const hasXcodeGenSpec = hostApp.xcodeGenSpecPath
    ? existsSync(hostApp.xcodeGenSpecPath)
    : hasPathSuffix(root, "project.yml") || hasPathSuffix(root, "project.yaml");
  const hasPreviewManifest = existsSync(hostApp.manifestPath);
  const hasGeneratedHostProject = hostApp.projectPath ? existsSync(hostApp.projectPath) : hostApp.workspacePath ? existsSync(hostApp.workspacePath) : false;

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
      hasGeneratedHostProject,
      usingDefaultHostAppConfiguration: hostApp.usingDefault,
    }),
  };
}

function suggestNextAction(input: {
  hasPackageSwift: boolean;
  hasXcodeProject: boolean;
  hasWorkspace: boolean;
  hasXcodeGenSpec: boolean;
  hasPreviewManifest: boolean;
  hasGeneratedHostProject: boolean;
  usingDefaultHostAppConfiguration: boolean;
}): string {
  if (input.usingDefaultHostAppConfiguration) {
    return "Using the sample app configuration. Configure a host app workspace to preview your real app.";
  }

  if (input.hasXcodeGenSpec && !input.hasGeneratedHostProject) {
    return "Generate the configured host app project with XcodeGen, then reopen the explorer.";
  }

  if (!input.hasXcodeProject && !input.hasWorkspace) {
    return "Configure a SwiftUI host app project or workspace so the runtime can build previews.";
  }

  if (!input.hasPackageSwift) {
    return "Add SwiftPreviewKit to the host app and start defining preview targets.";
  }

  if (input.hasPreviewManifest) {
    return "Preview launch is available. Open a preview in Simulator or reconfigure the host app if you want a different target.";
  }

  return "Configure a valid preview manifest so the runtime can discover targets and fixtures.";
}

function fileExists(root: string, filename: string): boolean {
  return existsSync(path.join(root, filename));
}

function hasPathSuffix(root: string, suffix: string, depth = 3): boolean {
  return walk(root, depth).some((entry) => entry.endsWith(suffix));
}

function discoverPreviewTargets(root: string): PreviewTargetDiscovery {
  const hostApp = resolveHostAppConfiguration(root);
  const manifest = readPreviewManifest(hostApp.manifestPath);

  return {
    version: VERSION,
    appName: manifest?.appName ?? path.basename(hostApp.appRoot),
    scheme: hostApp.scheme,
    projectPath: hostApp.projectPath && existsSync(hostApp.projectPath)
      ? hostApp.projectPath
      : hostApp.workspacePath && existsSync(hostApp.workspacePath)
      ? hostApp.workspacePath
      : null,
    manifestPath: existsSync(hostApp.manifestPath) ? hostApp.manifestPath : null,
    targets: manifest?.targets ?? [],
  };
}

function getAutoRefreshStateResponse(): AutoRefreshState {
  return {
    version: VERSION,
    enabled: runtimeState.autoRefreshEnabled,
  };
}

function getHostAppConfigurationResponse(root: string): HostAppConfiguration {
  const hostApp = resolveHostAppConfiguration(root);

  return {
    version: VERSION,
    usingDefault: hostApp.usingDefault,
    appRoot: hostApp.appRoot,
    projectPath: hostApp.projectPath,
    workspacePath: hostApp.workspacePath,
    xcodeGenSpecPath: hostApp.xcodeGenSpecPath,
    scheme: hostApp.scheme,
    manifestPath: hostApp.manifestPath,
    bundleIdentifier: hostApp.bundleIdentifier,
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

  const hostApp = resolveHostAppConfiguration(root);
  await ensureHostAppProject(hostApp, root);

  const manifest = readPreviewManifest(hostApp.manifestPath);
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
  const appPath = await buildHostApp(hostApp, root, hostApp.scheme, simulator.udid);
  const manifestOutputPath = getManifestCachePath(root, hostApp.scheme);
  await installAndLaunchHostApp(hostApp.bundleIdentifier, appPath, simulator.udid, {
    targetId: target.id,
    fixtureId: fixture?.id ?? null,
    environmentId: environment?.id ?? null,
  }, manifestOutputPath);
  await focusSimulatorApp(simulator.udid);

  lastPreviewState = {
    targetId: target.id,
    ...(fixture?.id ? { fixtureId: fixture.id } : {}),
    ...(environment?.id ? { environmentId: environment.id } : {}),
    simulatorId: simulator.udid,
  };
  ensurePreviewWatchers(root);

  return {
    version: VERSION,
    status,
    appName: manifest.appName,
    scheme: hostApp.scheme,
    simulatorId: simulator.udid,
    simulatorName: simulator.name,
    bundleIdentifier: hostApp.bundleIdentifier,
    targetId: target.id,
    fixtureId: fixture?.id ?? null,
    environmentId: environment?.id ?? null,
  };
}

function getDefaultHostAppConfiguration(root: string): ResolvedHostAppConfiguration {
  const appRoot = path.join(root, "examples", "sample-swiftui-app");
  const scheme = "SampleSwiftUIApp";

  return {
    usingDefault: true,
    appRoot,
    projectPath: path.join(appRoot, "SampleSwiftUIApp.xcodeproj"),
    workspacePath: null,
    xcodeGenSpecPath: path.join(appRoot, "project.yml"),
    scheme,
    manifestPath: detectManifestPath(root, appRoot, scheme),
    bundleIdentifier: "com.swiftuiexplorer.example.SampleSwiftUIApp",
    derivedDataPath: path.join(root, ".swiftui-explorer", "derived-data", "sample-swiftui-app"),
  };
}

function getRuntimeStatePath(root: string): string {
  return path.join(root, ".swiftui-explorer", "runtime-state.json");
}

function loadRuntimeState(root: string): RuntimeState {
  const statePath = getRuntimeStatePath(root);
  if (!existsSync(statePath)) {
    return {
      autoRefreshEnabled: true,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<RuntimeState>;
    return {
      autoRefreshEnabled: parsed.autoRefreshEnabled ?? true,
      hostAppConfiguration: parsed.hostAppConfiguration,
    };
  } catch {
    return {
      autoRefreshEnabled: true,
    };
  }
}

function saveRuntimeState(root: string, state: RuntimeState): void {
  const statePath = getRuntimeStatePath(root);
  mkdirSync(path.dirname(statePath), {
    recursive: true,
  });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function validateHostAppConfigurationInput(input: HostAppConfigurationInput): PersistedHostAppConfiguration {
  if (typeof input.appRoot !== "string" || !input.appRoot.trim()) {
    throw new HttpError(400, "appRoot is required.");
  }

  if (typeof input.scheme !== "string" || !input.scheme.trim()) {
    throw new HttpError(400, "scheme is required.");
  }

  if (typeof input.bundleIdentifier !== "string" || !input.bundleIdentifier.trim()) {
    throw new HttpError(400, "bundleIdentifier is required.");
  }

  const projectPath = typeof input.projectPath === "string" && input.projectPath.trim() ? input.projectPath : undefined;
  const workspacePath = typeof input.workspacePath === "string" && input.workspacePath.trim() ? input.workspacePath : undefined;
  if ((projectPath ? 1 : 0) + (workspacePath ? 1 : 0) !== 1) {
    throw new HttpError(400, "Provide exactly one of projectPath or workspacePath.");
  }

  const xcodeGenSpecPath = typeof input.xcodeGenSpecPath === "string" && input.xcodeGenSpecPath.trim()
    ? input.xcodeGenSpecPath
    : undefined;

  const manifestPath = typeof input.manifestPath === "string" && input.manifestPath.trim()
    ? input.manifestPath.trim()
    : undefined;

  return {
    appRoot: input.appRoot.trim(),
    projectPath,
    workspacePath,
    xcodeGenSpecPath,
    scheme: input.scheme.trim(),
    ...(manifestPath ? { manifestPath } : {}),
    bundleIdentifier: input.bundleIdentifier.trim(),
  };
}

function persistHostAppConfiguration(root: string, configuration: PersistedHostAppConfiguration): PersistedHostAppConfiguration {
  return {
    appRoot: toStoredPath(root, configuration.appRoot),
    ...(configuration.projectPath ? { projectPath: toStoredPath(root, configuration.projectPath) } : {}),
    ...(configuration.workspacePath ? { workspacePath: toStoredPath(root, configuration.workspacePath) } : {}),
    ...(configuration.xcodeGenSpecPath ? { xcodeGenSpecPath: toStoredPath(root, configuration.xcodeGenSpecPath) } : {}),
    scheme: configuration.scheme,
    ...(configuration.manifestPath ? { manifestPath: toStoredPath(root, configuration.manifestPath) } : {}),
    bundleIdentifier: configuration.bundleIdentifier,
  };
}

function resolveHostAppConfiguration(root: string): ResolvedHostAppConfiguration {
  const configured = runtimeState.hostAppConfiguration;
  if (
    !configured
    || !configured.appRoot
    || !configured.scheme
    || !configured.bundleIdentifier
    || ((!configured.projectPath ? 0 : 1) + (!configured.workspacePath ? 0 : 1) !== 1)
  ) {
    return getDefaultHostAppConfiguration(root);
  }

  const appRoot = resolveWorkspacePath(root, configured.appRoot);
  const projectPath = configured.projectPath ? resolveWorkspacePath(root, configured.projectPath) : null;
  const workspacePath = configured.workspacePath ? resolveWorkspacePath(root, configured.workspacePath) : null;
  const xcodeGenSpecPath = configured.xcodeGenSpecPath ? resolveWorkspacePath(root, configured.xcodeGenSpecPath) : null;
  const derivedDataKey = slugify(`${path.basename(appRoot)}-${configured.scheme}`);
  const manifestPath = configured.manifestPath
    ? resolveWorkspacePath(root, configured.manifestPath)
    : detectManifestPath(root, appRoot, configured.scheme);

  return {
    usingDefault: false,
    appRoot,
    projectPath,
    workspacePath,
    xcodeGenSpecPath,
    scheme: configured.scheme,
    manifestPath,
    bundleIdentifier: configured.bundleIdentifier,
    derivedDataPath: path.join(root, ".swiftui-explorer", "derived-data", derivedDataKey),
  };
}

function resolveWorkspacePath(root: string, candidatePath: string): string {
  return path.isAbsolute(candidatePath) ? path.normalize(candidatePath) : path.join(root, candidatePath);
}

function toStoredPath(root: string, candidatePath: string): string {
  const absolutePath = resolveWorkspacePath(root, candidatePath);
  const relativePath = path.relative(root, absolutePath);

  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath || ".";
  }

  return absolutePath;
}

function slugify(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "host-app";
}

function getManifestCachePath(root: string, scheme: string): string {
  return path.join(root, ".swiftui-explorer", "manifests", `${scheme}.json`);
}

function detectManifestPath(root: string, appRoot: string, scheme: string): string {
  const cachedPath = getManifestCachePath(root, scheme);
  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  const found = walk(appRoot, 4).find(
    (entry) => entry.endsWith(`${path.sep}PreviewManifest.json`) || entry.endsWith("/PreviewManifest.json"),
  );
  if (found) {
    return found;
  }

  return cachedPath;
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

function ensurePreviewWatchers(root: string): void {
  if (previewWatchers.length > 0) {
    return;
  }

  const hostApp = resolveHostAppConfiguration(root);
  const watchRoots = [
    hostApp.appRoot,
    path.join(root, "packages", "swift-preview-kit"),
  ].filter(existsSync);

  for (const watchRoot of watchRoots) {
    const watcher = watch(
      watchRoot,
      {
        recursive: true,
      },
      (_eventType, filename) => {
        if (!filename || !shouldAutoRefreshFromFile(filename.toString())) {
          return;
        }

        scheduleAutoRefresh(root, path.join(watchRoot, filename.toString()));
      },
    );

    watcher.on("error", (error) => {
      process.stdout.write(`[swiftui-explorer] watcher error: ${String(error)}\n`);
    });

    previewWatchers.push(watcher);
  }
}

function closePreviewWatchers(): void {
  for (const watcher of previewWatchers) {
    watcher.close();
  }
  previewWatchers = [];
}

function shouldAutoRefreshFromFile(relativePath: string): boolean {
  const normalizedPath = relativePath.replaceAll("\\", "/");

  return normalizedPath.endsWith(".swift")
    || normalizedPath.endsWith("/PreviewManifest.json")
    || normalizedPath.endsWith("/project.yml")
    || normalizedPath.endsWith("/project.yaml");
}

function scheduleAutoRefresh(root: string, changedPath: string): void {
  if (!runtimeState.autoRefreshEnabled || !lastPreviewState) {
    return;
  }

  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer);
  }

  process.stdout.write(`[swiftui-explorer] scheduled auto-refresh for ${changedPath}\n`);

  autoRefreshTimer = setTimeout(() => {
    autoRefreshTimer = null;
    void triggerAutoRefresh(root);
  }, AUTO_REFRESH_DELAY_MS);
}

async function triggerAutoRefresh(root: string): Promise<void> {
  if (!runtimeState.autoRefreshEnabled || !lastPreviewState) {
    return;
  }

  if (autoRefreshInFlight) {
    pendingAutoRefresh = true;
    return;
  }

  autoRefreshInFlight = true;
  pendingAutoRefresh = false;
  process.stdout.write(`[swiftui-explorer] auto-refreshing ${lastPreviewState.targetId}\n`);

  try {
    await openPreview(root, lastPreviewState, "refreshed");
    process.stdout.write(`[swiftui-explorer] auto-refresh completed\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown runtime error";
    process.stdout.write(`[swiftui-explorer] auto-refresh failed: ${message}\n`);
  } finally {
    autoRefreshInFlight = false;

    if (pendingAutoRefresh) {
      pendingAutoRefresh = false;
      void triggerAutoRefresh(root);
    }
  }
}

async function ensureHostAppProject(
  hostApp: ResolvedHostAppConfiguration,
  root: string,
): Promise<void> {
  if (hostApp.workspacePath && existsSync(hostApp.workspacePath)) {
    return;
  }

  if (hostApp.projectPath && existsSync(hostApp.projectPath)) {
    return;
  }

  if (!hostApp.xcodeGenSpecPath || !hostApp.projectPath) {
    throw new HttpError(400, "Configured host app project or workspace was not found.");
  }

  if (!existsSync(hostApp.xcodeGenSpecPath)) {
    throw new HttpError(400, "Configured XcodeGen spec was not found.");
  }

  await runCommand("xcodegen", ["generate", "--spec", hostApp.xcodeGenSpecPath], root);
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

async function buildHostApp(
  hostApp: ResolvedHostAppConfiguration,
  root: string,
  scheme: string,
  simulatorId: string,
): Promise<string> {
  mkdirSync(hostApp.derivedDataPath, {
    recursive: true,
  });

  const buildTargetArgs = hostApp.workspacePath
    ? ["-workspace", hostApp.workspacePath]
    : hostApp.projectPath
    ? ["-project", hostApp.projectPath]
    : [];
  if (buildTargetArgs.length === 0) {
    throw new HttpError(400, "Configured host app project or workspace was not found.");
  }

  await runCommand(
    "xcodebuild",
    [
      ...buildTargetArgs,
      "-scheme",
      scheme,
      "-destination",
      `id=${simulatorId}`,
      "-derivedDataPath",
      hostApp.derivedDataPath,
      "build",
    ],
    root,
  );

  const buildSettingsOutput = await runCommand(
    "xcodebuild",
    [
      ...buildTargetArgs,
      "-scheme",
      scheme,
      "-destination",
      `id=${simulatorId}`,
      "-derivedDataPath",
      hostApp.derivedDataPath,
      "-showBuildSettings",
    ],
    root,
  );

  const targetBuildDir = parseBuildSetting(buildSettingsOutput.stdout, "TARGET_BUILD_DIR");
  const fullProductName = parseBuildSetting(buildSettingsOutput.stdout, "FULL_PRODUCT_NAME");

  if (!targetBuildDir || !fullProductName) {
    throw new HttpError(500, "Could not determine the built app path from Xcode build settings.");
  }

  const appPath = path.join(targetBuildDir, fullProductName);
  if (!existsSync(appPath)) {
    throw new HttpError(500, `Built app not found at '${appPath}'.`);
  }

  return appPath;
}

async function validateHostAppBuild(root: string): Promise<ValidationResult> {
  const hostApp = resolveHostAppConfiguration(root);

  const buildTargetArgs = hostApp.workspacePath
    ? ["-workspace", hostApp.workspacePath]
    : hostApp.projectPath
    ? ["-project", hostApp.projectPath]
    : [];

  if (buildTargetArgs.length === 0) {
    return {
      version: VERSION,
      success: false,
      diagnostics: ["No Xcode project or workspace configured."],
    };
  }

  try {
    await runCommand(
      "xcodebuild",
      [
        ...buildTargetArgs,
        "-scheme",
        hostApp.scheme,
        "-destination",
        "generic/platform=iOS Simulator",
        "-derivedDataPath",
        hostApp.derivedDataPath,
        "build",
      ],
      root,
    );

    return { version: VERSION, success: true, diagnostics: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Build failed";
    const diagnostics = message
      .split("\n")
      .filter((line) => /error:/i.test(line))
      .slice(0, 20);

    return {
      version: VERSION,
      success: false,
      diagnostics: diagnostics.length > 0 ? diagnostics : [message.slice(0, 1000)],
    };
  }
}

function parseBuildSetting(output: string, key: string): string | null {
  const match = output.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

async function installAndLaunchHostApp(
  bundleIdentifier: string,
  appPath: string,
  simulatorId: string,
  selection: {
    targetId: string;
    fixtureId: string | null;
    environmentId: string | null;
  },
  manifestOutputPath: string,
): Promise<void> {
  await runCommand("xcrun", ["simctl", "install", simulatorId, appPath], workspaceRoot);

  await runCommand(
    "xcrun",
    ["simctl", "launch", "--terminate-running-process", simulatorId, bundleIdentifier],
    workspaceRoot,
    {
      env: {
        SIMCTL_CHILD_SWIFTUI_EXPLORER_TARGET_ID: selection.targetId,
        ...(selection.fixtureId ? { SIMCTL_CHILD_SWIFTUI_EXPLORER_FIXTURE_ID: selection.fixtureId } : {}),
        ...(selection.environmentId ? { SIMCTL_CHILD_SWIFTUI_EXPLORER_ENVIRONMENT_ID: selection.environmentId } : {}),
        SIMCTL_CHILD_SWIFTUI_EXPLORER_MANIFEST_OUTPUT: manifestOutputPath,
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
