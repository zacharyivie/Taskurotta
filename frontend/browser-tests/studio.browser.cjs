/* global __dirname, clearTimeout, console, document, getComputedStyle, KeyboardEvent, MouseEvent, process, self, setTimeout, window */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { app, BrowserWindow } = require("electron");

const frontendRoot = path.resolve(__dirname, "..");
const distRoot = path.join(frontendRoot, "dist");
const timeout = setTimeout(() => fail(new Error("Browser studio smoke test timed out.")), 30000);

let server;
let windowRef;
const rendererErrors = [];

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-dev-shm-usage");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-setuid-sandbox");

process.on("unhandledRejection", fail);
process.on("uncaughtException", fail);
app.whenReady().then(run).catch(fail);

function observeRendererErrors(browserWindow) {
  browserWindow.webContents.on("console-message", (details) => {
    if (details.level === "error") rendererErrors.push(details.message);
  });
}

async function run() {
  const baseUrl = await startServer();
  windowRef = new BrowserWindow({
    width: 1440,
    height: 900,
    // Map the window on Xvfb so Chromium paints Monaco and handles native input.
    show: true,
    webPreferences: {
      // An in-memory partition prevents earlier runs from restoring UI state.
      partition: "studio-browser-test",
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, "studio-preload-mock.cjs"),
      sandbox: false,
    },
  });

  observeRendererErrors(windowRef);
  await windowRef.loadURL(baseUrl);
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[aria-label='Studio view']"))));
  if (process.env.GOFER_TERMINAL_ONLY === "1") {
    await exerciseBottomPanelTerminal();
    clearTimeout(timeout);
    console.log("Browser terminal regression test passed.");
    await cleanup(0);
    return;
  }
  if (process.env.GOFER_MONACO_ONLY === "1") {
    await exerciseMonacoEditor();
    await exercisePackagedMonacoWorker(baseUrl);
    clearTimeout(timeout);
    console.log("Browser Monaco regression test passed.");
    await cleanup(0);
    return;
  }
  if (process.env.GOFER_REM_ONLY === "1") {
    await exerciseRemAvatar();
    clearTimeout(timeout);
    console.log("Browser Rem avatar regression test passed.");
    await cleanup(0);
    return;
  }
  await exerciseCreateDialog();
  await exerciseDesignRegressions();
  await exerciseKeyboardGraphAndResizers();
  await exerciseMonacoEditor();
  await exercisePackagedMonacoWorker(baseUrl);
  await exerciseSourceControl();

  clearTimeout(timeout);
  assert.deepEqual(rendererErrors, [], "Renderer must not log errors");
  console.log("Browser studio accessibility smoke test passed.");
  await cleanup(0);
}

async function exerciseRemAvatar() {
  await waitFor(() => evaluate(() => document.querySelector(".rem-avatar")?.dataset.pose === "waving"));
  await waitFor(() => evaluate(() => document.querySelector(".rem-avatar")?.dataset.pose === "seated"));
  await wait(700);
  const metrics = await evaluate(() => {
    const avatar = document.querySelector(".rem-avatar");
    return { width: avatar.offsetWidth, imagesLoaded: [...avatar.querySelectorAll("img")].every((img) => img.complete && img.naturalWidth > 0), waveOpacity: getComputedStyle(avatar.querySelector(".rem-avatar-wave")).opacity };
  });
  assert.deepEqual(metrics, { width: 112, imagesLoaded: true, waveOpacity: "0" });
  fs.writeFileSync("/tmp/taskurotta-rem-seated.png", (await windowRef.webContents.capturePage()).toPNG());
  await waitFor(() => evaluate(() => document.querySelector(".rem-avatar")?.dataset.blinking === "true"));
  await waitFor(() => evaluate(() => document.querySelector(".rem-avatar")?.dataset.blinking === "false"));
  const toggle = () => evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", code: "KeyL", ctrlKey: true, bubbles: true })));
  await toggle();
  await waitFor(() => evaluate(() => document.querySelector(".rem-avatar")?.dataset.animated === "false"));
  await toggle();
  await waitFor(() => evaluate(() => document.querySelector(".rem-avatar")?.dataset.pose === "waving"));
  assert.deepEqual(await evaluate(() => {
    const wave = document.querySelector(".rem-avatar-wave");
    const style = getComputedStyle(wave);
    return { opacity: style.opacity, transitionDuration: style.transitionDuration };
  }), { opacity: "1", transitionDuration: "0s" });
  fs.writeFileSync("/tmp/taskurotta-rem-wave.png", (await windowRef.webContents.capturePage()).toPNG());
}

async function exerciseBottomPanelTerminal() {
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[aria-label='Bottom panel']"))));
  await evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true,
    ctrlKey: true,
    key: "`",
  })));
  await waitFor(() => evaluate(() => Boolean(document.querySelector(".terminal-host .xterm-screen"))));
  assert.equal(
    await evaluate(() => document.querySelector("[aria-label='Bottom panel'] button[role='tab'][aria-selected='true']")?.textContent.trim()),
    "Terminal",
  );
  assert.equal(await evaluate(() => document.querySelector("[aria-label='Bottom panel']").getBoundingClientRect().height), 240);
  await evaluate(() => document.querySelector("button[aria-label='New terminal']").click());
  await waitFor(() => evaluate(() => document.querySelectorAll("button[title='Close terminal']").length === 2));
  assert.equal(await evaluate(() => window.__goferBridgeCalls
    .filter((call) => call.method === "terminal.create").length), 2);

  await evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true,
    ctrlKey: true,
    key: "`",
  })));
  await waitFor(() => evaluate(() => document.querySelector("[aria-label='Bottom panel']").getBoundingClientRect().height === 36));
}

async function openRadishWorkflowFile() {
  await evaluate(() => [...document.querySelectorAll("[role='button']")]
    .find((button) => button.textContent.includes("Radish editor"))
    .parentElement.querySelector("button[title='Workflow actions']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[role='menu']"))), 25, "workflow actions menu");
  await evaluate(() => [...document.querySelectorAll("[role='menuitem']")]
    .find((button) => button.textContent.trim() === "Edit workflow file").click());
}

async function exerciseMonacoEditor() {
  await waitFor(() => evaluate(() => [...document.querySelectorAll("[role='button']")]
    .some((button) => button.textContent.includes("Radish editor"))));
  await evaluate(() => [...document.querySelectorAll("[role='button']")]
    .find((button) => button.textContent.includes("Radish editor")).click());
  await waitFor(() => evaluate(() => [...document.querySelectorAll("article")]
    .some((node) => node.textContent.includes("Prepare"))));
  await evaluate(() => document.querySelector("button[title='Run workflow now']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[role='dialog']"))));
  assert.equal(await evaluate(() => document.querySelector("[role='dialog']").textContent.includes("prepare")), true);
  await evaluate(() => [...document.querySelectorAll("[role='dialog'] button")]
    .find((button) => button.textContent.trim() === "Run workflow").click());
  await waitFor(() => evaluate(() => !document.querySelector("[role='dialog']")));
  await waitFor(() => evaluate(() => [...document.querySelectorAll("[role='button']")]
    .some((button) => button.textContent.includes("Radish editor") && button.textContent.includes("Success"))));
  await openRadishWorkflowFile();
  await waitFor(() => evaluate(() => Boolean(document.querySelector(".monaco-editor"))));
  assert.equal(await evaluate(() => Boolean(document.querySelector("[aria-label='Search files']"))), false);
  await waitFor(() => evaluate(() => [...document.querySelectorAll(".view-line")]
    .some((line) => line.textContent.includes("Radish"))));
  await evaluate(() => [...document.querySelectorAll("button[role='tab']")]
    .find((button) => button.textContent.trim() === "Graph").click());
  assert.equal(await evaluate(() => Boolean(document.querySelector(".monaco-editor"))), true);
  await waitFor(() => evaluate(() => [...document.querySelectorAll("article")]
    .some((node) => node.textContent.includes("Prepare"))));
  assert.equal(await evaluate(() => document.querySelector("[aria-label='Studio view'] [aria-selected='true']")?.textContent.trim()), "Graph");
}

async function exercisePackagedMonacoWorker(baseUrl) {
  const httpWindow = windowRef;
  const packagedWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    webPreferences: {
      partition: "studio-browser-test",
      additionalArguments: [`--gofer-api-base-url=${baseUrl}`],
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, "studio-preload-mock.cjs"),
      sandbox: false,
    },
  });
  observeRendererErrors(packagedWindow);
  await packagedWindow.loadFile(path.join(distRoot, "index.html"));
  windowRef = packagedWindow;
  if (httpWindow && !httpWindow.isDestroyed()) httpWindow.destroy();
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[aria-label='Studio view']"))));
  await waitFor(() => evaluate(() => [...document.querySelectorAll("[role='button']")]
    .some((button) => button.textContent.includes("Radish editor"))));
  await evaluate(() => [...document.querySelectorAll("[role='button']")]
    .find((button) => button.textContent.includes("Radish editor")).click());
  await openRadishWorkflowFile();
  await waitFor(() => evaluate(() => Boolean(document.querySelector(".monaco-editor"))));
  await waitFor(() => evaluate(() => [...document.querySelectorAll(".view-line")]
    .some((line) => /command:\s*echo\s*ready/.test(line.textContent))), 25, "packaged editor to render indented Radish fields");
  const workerResult = await evaluate(() => {
    try {
      const worker = self.MonacoEnvironment.getWorker();
      worker.terminate();
      return { ok: true };
    } catch (error) {
      return { error: String(error), ok: false };
    }
  });
  assert.equal(workerResult.ok, true, workerResult.error);
}

async function exerciseDesignRegressions() {
  const pickerWidths = await evaluate(() => {
    const textarea = document.querySelector("textarea[placeholder='Message this workflow']");
    const chat = textarea.closest("aside");
    const trigger = chat.querySelector(".model-picker-trigger");
    const provider = trigger.querySelector("[data-model-picker-part='provider']");
    const model = trigger.querySelector("[data-model-picker-part='model']");
    const effort = trigger.querySelector("[data-model-picker-part='effort']");
    const metrics = (segment) => {
      const label = segment.querySelector("[data-picker-label]");
      const segmentRect = segment.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      const style = getComputedStyle(segment);
      return {
        centerDelta: Math.abs(
          (labelRect.left + labelRect.width / 2) - (segmentRect.left + segmentRect.width / 2),
        ),
        color: style.color,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fullyVisible: label.scrollWidth <= label.clientWidth,
        width: segmentRect.width,
      };
    };
    return {
      composer: textarea.parentElement.getBoundingClientRect().width,
      effortLeft: effort.getBoundingClientRect().left,
      effortMetrics: metrics(effort),
      effortText: effort.textContent.trim(),
      modelLeft: model.getBoundingClientRect().left,
      modelMetrics: metrics(model),
      modelText: model.textContent.trim(),
      providerLeft: provider.getBoundingClientRect().left,
      providerMetrics: metrics(provider),
      providerText: provider.textContent.trim(),
      trigger: trigger.getBoundingClientRect().width,
    };
  });
  assert.ok(Math.abs(pickerWidths.trigger - pickerWidths.composer) < 1);
  assert.equal(pickerWidths.providerText, "Codex");
  assert.equal(pickerWidths.modelText, "GPT-5.6-Sol");
  assert.equal(pickerWidths.effortText, "Medium");
  assert.ok(pickerWidths.providerLeft < pickerWidths.modelLeft);
  assert.ok(pickerWidths.modelLeft < pickerWidths.effortLeft);
  const typography = ({ color, fontFamily, fontSize, fontWeight }) => ({
    color,
    fontFamily,
    fontSize,
    fontWeight,
  });
  assert.deepEqual(typography(pickerWidths.providerMetrics), typography(pickerWidths.modelMetrics));
  assert.deepEqual(typography(pickerWidths.modelMetrics), typography(pickerWidths.effortMetrics));
  assert.ok(pickerWidths.providerMetrics.centerDelta < 1);
  assert.ok(pickerWidths.modelMetrics.centerDelta < 1);
  assert.ok(pickerWidths.effortMetrics.centerDelta < 1);
  assert.ok(pickerWidths.modelMetrics.width > pickerWidths.providerMetrics.width);
  assert.ok(pickerWidths.providerMetrics.width > pickerWidths.effortMetrics.width);
  assert.equal(pickerWidths.providerMetrics.fullyVisible, true);
  assert.equal(pickerWidths.modelMetrics.fullyVisible, true);
  assert.equal(pickerWidths.effortMetrics.fullyVisible, true);

  await evaluate(() => document.querySelector("[data-picker-trigger='provider']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-picker-menu='provider']"))));
  const providerMenuWidth = await evaluate(() =>
    document.querySelector("[data-picker-menu='provider']").getBoundingClientRect().width,
  );
  assert.ok(
    Math.abs(providerMenuWidth - pickerWidths.composer) <= 20,
    `Provider menu width ${providerMenuWidth} did not match composer width ${pickerWidths.composer}`,
  );
  await evaluate(() => document.querySelector("[data-picker-trigger='provider']").click());

  await evaluate(() => document.querySelector("[data-picker-trigger='model']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-picker-menu='model']"))));
  assert.equal(await evaluate(() => Boolean(document.querySelector("input[placeholder='Search models']"))), false);
  await evaluate(() => document.querySelector("[data-picker-trigger='model']").parentElement.classList.add("dark"));
  await wait(200);
  const darkModelState = await evaluate(() => {
    const trigger = document.querySelector("[data-picker-trigger='model']");
    return {
      background: getComputedStyle(trigger).backgroundColor,
      className: trigger.className,
      expanded: trigger.getAttribute("aria-expanded"),
      parentClassName: trigger.parentElement.className,
    };
  });
  assert.equal(darkModelState.background, "rgb(42, 42, 42)", JSON.stringify(darkModelState));
  await evaluate(() => document.querySelector("[data-picker-trigger='model']").parentElement.classList.remove("dark"));
  await evaluate(() => [...document.querySelectorAll("[data-picker-menu='model'] [role='option']")]
    .find((option) => option.textContent.trim() === "GPT-5.6-Luna").click());
  await waitFor(() => evaluate(() =>
    document.querySelector("[data-picker-trigger='model'] [data-picker-label]").textContent.trim() === "GPT-5.6-Luna"));
  assert.equal(
    await evaluate(() => document.querySelector("[data-picker-trigger='effort'] [data-picker-label]").textContent.trim()),
    "Medium",
  );

  await evaluate(() => document.querySelector("[data-picker-trigger='effort']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-picker-menu='effort']"))));
  const effortMenu = await evaluate(() => {
    const menu = document.querySelector("[data-picker-menu='effort']");
    const options = [...menu.querySelectorAll("[role='option']")];
    return {
      activeLabel: menu.querySelector("[role='option'][aria-selected='true']")?.textContent.trim(),
      fitsWidth: menu.scrollWidth <= menu.clientWidth,
      labels: options.map((option) => option.textContent.trim()),
      optionCount: options.length,
      optionTops: options.map((option) => Math.round(option.getBoundingClientRect().top)),
    };
  });
  assert.equal(effortMenu.optionCount, 5);
  assert.equal(new Set(effortMenu.optionTops).size, 5);
  assert.equal(effortMenu.fitsWidth, true);
  assert.deepEqual(effortMenu.labels, ["Low", "Medium (default)", "High", "X-high", "Max"]);
  assert.equal(effortMenu.activeLabel, "Medium (default)");
  await evaluate(() => document.querySelector("[data-picker-trigger='effort']").click());

  await evaluate(() => document.querySelector("[data-picker-trigger='provider']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-picker-menu='provider']"))));
  await evaluate(() => [...document.querySelectorAll("[data-picker-menu='provider'] [role='option']")]
    .find((option) => option.textContent.includes("Claude Code")).click());
  await waitFor(() => evaluate(() =>
    document.querySelector("[data-picker-trigger='model'] [data-picker-label]").textContent.trim() === "Claude Sonnet 5"));
  assert.equal(
    await evaluate(() => document.querySelector("[data-picker-trigger='effort'] [data-picker-label]").textContent.trim()),
    "High",
  );
  await evaluate(() => document.querySelector("[data-picker-trigger='model']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-picker-menu='model']"))));
  const claudeModels = await evaluate(() =>
    [...document.querySelectorAll("[data-picker-menu='model'] [role='option']")]
      .map((option) => option.textContent.trim()));
  assert.equal(claudeModels.includes("Default"), false);
  assert.equal(claudeModels.includes("Claude Sonnet 5 (default)"), true);
  await evaluate(() => document.querySelector("[data-picker-trigger='model']").click());
  await evaluate(() => document.querySelector("[data-picker-trigger='effort']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-picker-menu='effort']"))));
  assert.equal(
    await evaluate(() => document.querySelector("[data-picker-menu='effort'] [aria-selected='true']").textContent.trim()),
    "High (default)",
  );
  assert.equal(
    await evaluate(() => [...document.querySelectorAll("[data-picker-menu='effort'] [role='option']")]
      .some((option) => option.textContent.trim() === "Default")),
    false,
  );
  await evaluate(() => document.querySelector("[data-picker-trigger='effort']").click());

  assert.equal(await evaluate(() => Boolean(document.querySelector("button[title='New thread']"))), true);
  assert.equal(await evaluate(() => Boolean(document.querySelector("button[title='Recent threads']"))), true);
  await evaluate(() => document.querySelector("button[title='New thread']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("button[title='Back to recent threads']"))));
  await evaluate(() => document.querySelector("button[title='Back to recent threads']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-assistant-home]"))));
  assert.equal(
    await evaluate(() => document.querySelector("[data-assistant-home] h2")?.textContent.trim()),
    "I'm Rem",
    "Returning from a thread should show Rem's home screen",
  );
  assert.match(
    await evaluate(() => document.querySelector("[data-assistant-home]").textContent),
    /Your coding agent in Taskurotta\./,
  );
  assert.equal(
    await evaluate(() => document.querySelector("[data-assistant-home] #assistant-home-recent")?.textContent.trim()),
    "Recent threads",
  );
  assert.equal(await evaluate(() => Boolean(document.querySelector("button[title='New thread']"))), true);
  assert.equal(await evaluate(() => Boolean(document.querySelector("button[title='Back to recent threads']"))), false);
  await evaluate(() => document.querySelector("button[title='Recent threads']").click());
  await waitFor(() => evaluate(() => Boolean([...document.querySelectorAll("p")]
    .find((item) => item.textContent.trim() === "Recent threads"))));
  await evaluate(() => document.querySelector("button[title='Recent threads']").click());

  const composerLayout = await evaluate(() => {
    const composer = document.querySelector("[data-chat-composer]");
    const textarea = composer.querySelector("textarea");
    const send = composer.querySelector("button[title='Send message']");
    const toolbar = send.parentElement;
    const composerRect = composer.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();
    const sendRect = send.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const inside = (child, parent) => (
      child.left >= parent.left - 1 &&
      child.right <= parent.right + 1 &&
      child.top >= parent.top - 1 &&
      child.bottom <= parent.bottom + 1
    );
    return {
      sendInsideComposer: inside(sendRect, composerRect),
      sendInsideToolbar: inside(sendRect, toolbarRect),
      textareaInsideComposer: inside(textareaRect, composerRect),
      toolbarBelowTextarea: toolbarRect.top >= textareaRect.bottom - 1,
      toolbarInsideComposer: inside(toolbarRect, composerRect),
    };
  });
  assert.equal(composerLayout.textareaInsideComposer, true);
  assert.equal(composerLayout.toolbarInsideComposer, true);
  assert.equal(composerLayout.toolbarBelowTextarea, true);
  assert.equal(composerLayout.sendInsideComposer, true);
  assert.equal(composerLayout.sendInsideToolbar, true);

  await evaluate(() => document.querySelector("button[title='Map']").click());
  await evaluate(() => [...document.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Minimap").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[title='Minimap'] > div"))));
  const minimapFill = await evaluate(() => {
    const surface = document.querySelector("[title='Minimap'] > div");
    const container = surface.parentElement;
    return {
      containerHeight: container.clientHeight,
      containerWidth: container.clientWidth,
      surfaceHeight: surface.clientHeight,
      surfaceWidth: surface.clientWidth,
    };
  });
  assert.equal(minimapFill.surfaceWidth, minimapFill.containerWidth);
  assert.equal(minimapFill.surfaceHeight, minimapFill.containerHeight);
  await evaluate(() => [...document.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Outline").click());
  await evaluate(() => document.querySelector("button[title='Map']").click());

  await evaluate(() => document.querySelector("summary[title='More graph actions']").click());
  await waitFor(() => evaluate(() => Boolean(
    document.querySelector("details[open] summary[title='More graph actions']"),
  )));
  await evaluate(() => [...document.querySelectorAll("details[open] button")]
    .find((button) => button.textContent.trim() === "Workflow settings").click());
  await waitFor(() => evaluate(() => Boolean(
    document.querySelector("[aria-label='Workflow settings sections']"),
  )), 25, "Workflow settings sections to open");
  assert.deepEqual(
    await evaluate(() => [...document.querySelectorAll("[aria-label='Workflow settings sections'] [role='tab']")]
      .map((tab) => tab.textContent.trim())),
    ["General", "Triggers", "Variables", "Access"],
  );
  await evaluate(() => document.querySelector("button[title='Hide workflow settings and node inspector']").click());
}

async function exerciseKeyboardGraphAndResizers() {
  await evaluate(() => document.querySelector("button[title='Map']").click());
  const initialOutline = await evaluate(() => {
    const outline = document.querySelector("[aria-label='Graph outline']");
    const nodeButtons = [...outline.querySelectorAll("button[aria-label*=', status '")];
    return {
      nodeCount: nodeButtons.length,
      firstDescription: nodeButtons[0]?.getAttribute("aria-label") || "",
    };
  });
  assert.equal(initialOutline.nodeCount, 2);
  assert.match(initialOutline.firstDescription, /incoming.*outgoing.*valid/);

  await evaluate(() => {
    const addNode = document.querySelector("[title='Add node']");
    addNode.focus();
  });
  await pressFocusedKey("Enter");
  await waitFor(() => evaluate(() => Boolean(
    document.querySelector("[aria-label^='New Step 1,']"),
  )));
  assert.equal(
    await evaluate(() => document.activeElement.matches("[aria-label^='New Step 1,']")),
    true,
  );
  await pressFocusedKey("Enter");
  await waitFor(() => evaluate(() => document.activeElement.id === "workflow-inspector"));
  assert.equal(
    await evaluate(() => document.activeElement.id),
    "workflow-inspector",
  );
  assert.deepEqual(
    await evaluate(() => {
      const tablist = document.querySelector("[aria-label='Node inspector sections']");
      return [...tablist.querySelectorAll("[role='tab']")].map((tab) => ({
        label: tab.textContent.trim(),
        selected: tab.getAttribute("aria-selected"),
        tabIndex: tab.getAttribute("tabindex"),
      }));
    }),
    [
      { label: "General", selected: "true", tabIndex: "0" },
      { label: "Action", selected: "false", tabIndex: "-1" },
      { label: "Inputs", selected: "false", tabIndex: "-1" },
      { label: "Run", selected: "false", tabIndex: "-1" },
      { label: "Edges", selected: "false", tabIndex: "-1" },
    ],
  );
  await evaluate(() => {
    document.querySelector("#node-tab-general").focus();
  });
  await pressFocusedKey("ArrowRight");
  await waitFor(() => evaluate(() =>
    document.querySelector("#node-tab-action").getAttribute("aria-selected") === "true",
  ));
  assert.equal(
    await evaluate(() => document.querySelector("#node-tabpanel-general").hidden),
    true,
  );
  await evaluate(() => document.querySelector("#node-tab-general").click());
  await evaluate(() => {
    const labelControl = [...document.querySelectorAll("#workflow-inspector label")]
      .find((label) => label.querySelector("span")?.textContent === "Label")
      ?.querySelector("input");
    labelControl.focus();
    labelControl.select();
  });
  await windowRef.webContents.insertText("Keyboard step");
  await waitFor(() => evaluate(() => Boolean(
    document.querySelector("[aria-label^='Keyboard step,']"),
  )));

  await evaluate(() => {
    document.querySelector("[aria-label^='Run command,']").focus();
  });
  await pressFocusedKey("C");
  assert.match(
    await evaluate(() => document.querySelector("[aria-label='Graph outline']").textContent),
    /Connecting from Run command/,
  );
  await evaluate(() => {
    document.querySelector("[aria-label^='Review output,']").focus();
  });
  await pressFocusedKey("Enter");
  await waitFor(() => evaluate(() => Boolean(
    document.querySelector("[aria-label^='Run command to Review output, condition always']"),
  )));
  assert.equal(
    await evaluate(() => document.activeElement.matches(
      "[aria-label^='Run command to Review output, condition always']",
    )),
    true,
  );
  await pressFocusedKey("Enter");
  await waitFor(() => evaluate(() => document.activeElement.id === "workflow-inspector"));
  assert.equal(await evaluate(() => document.activeElement.id), "workflow-inspector");
  await evaluate(() => {
    const typeControl = [...document.querySelectorAll("#workflow-inspector label")]
      .find((label) => label.querySelector("span")?.textContent === "Type")
      ?.querySelector("select");
    typeControl.focus();
  });
  await pressNativeKey("DOWN");
  await pressNativeKey("DOWN");
  await waitFor(() => evaluate(() => Boolean(
    document.querySelector("[aria-label^='Run command to Review output, condition on failure']"),
  )));
  await evaluate(() => {
    document.querySelector("[aria-label^='Run command to Review output, condition on failure']").focus();
  });
  await pressFocusedKey("Delete");
  await waitFor(() => evaluate(() => !document.querySelector(
    "[aria-label^='Run command to Review output, condition on failure']",
  )));
  assert.equal(
    await evaluate(() => document.activeElement.matches("[aria-label^='Run command,']")),
    true,
  );
  await pressFocusedKey("D", ["control"]);
  await waitFor(() => evaluate(() => Boolean(
    document.querySelector("[aria-label^='Run command copy,']"),
  )));
  assert.equal(
    await evaluate(() => document.activeElement.matches("[aria-label^='Run command copy,']")),
    true,
  );
  await pressFocusedKey("Delete");
  await waitFor(() => evaluate(() => !document.querySelector("[aria-label^='Run command copy,']")));
  assert.equal(
    await evaluate(() => document.activeElement.matches("[aria-label^='Keyboard step,']")),
    true,
  );

  assert.deepEqual(
    await evaluate(() => {
      const separator = document.querySelector("[aria-label='Resize workflow settings and node inspector']");
      return {
        max: separator.getAttribute("aria-valuemax"),
        min: separator.getAttribute("aria-valuemin"),
        now: separator.getAttribute("aria-valuenow"),
        orientation: separator.getAttribute("aria-orientation"),
        role: separator.getAttribute("role"),
      };
    }),
    { max: "520", min: "280", now: "340", orientation: "vertical", role: "separator" },
  );
  await evaluate(() => {
    document.querySelector("[aria-label='Resize workflow settings and node inspector']").focus();
  });
  await pressFocusedKey("ArrowRight");
  await waitFor(() => evaluate(() =>
    document.querySelector("[aria-label='Resize workflow settings and node inspector']")
      .getAttribute("aria-valuenow") === "350",
  ));
  await pressFocusedKey("Enter");
  await waitFor(() => evaluate(() =>
    document.querySelector("[aria-label='Resize workflow settings and node inspector']")
      .getAttribute("aria-valuenow") === "340",
  ));
}

async function exerciseCreateDialog() {
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[title='New Workflow']"))));
  await evaluate(() => {
    const opener = document.querySelector("[title='New Workflow']");
    opener.focus();
    opener.click();
  });
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[role='dialog']"))));

  const initialState = await evaluate(() => {
    const dialog = document.querySelector("[role='dialog']");
    return {
      activeInside: dialog.contains(document.activeElement),
      describedBy: dialog.getAttribute("aria-describedby"),
      labelledBy: dialog.getAttribute("aria-labelledby"),
      modal: dialog.getAttribute("aria-modal"),
      name: dialog.getAttribute("aria-labelledby")
        ? document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent
        : "",
    };
  });
  assert.equal(initialState.activeInside, true);
  assert.equal(initialState.modal, "true");
  assert.equal(initialState.name, "New workflow");
  assert.ok(initialState.labelledBy);
  assert.ok(initialState.describedBy);

  const lastControlLabel = await evaluate(() => {
    const dialog = document.querySelector("[role='dialog']");
    const controls = [...dialog.querySelectorAll(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )];
    const last = controls.at(-1);
    last.dataset.browserSmokeLast = "true";
    last.focus();
    return last.textContent || last.getAttribute("aria-label") || last.tagName;
  });
  assert.ok(lastControlLabel);
  await sendKey("Tab");
  assert.equal(
    await evaluate(() => {
      const dialog = document.querySelector("[role='dialog']");
      const first = dialog.querySelector(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      return document.activeElement === first;
    }),
    true,
  );

  await sendKey("Escape");
  await waitFor(() => evaluate(() => !document.querySelector("[role='dialog']")));
  assert.equal(
    await evaluate(() => document.activeElement?.getAttribute("title")),
    "New Workflow",
  );
}

async function sendKey(keyCode) {
  await windowRef.webContents.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ${JSON.stringify(keyCode)} }))`,
  );
  await wait(40);
}

async function pressFocusedKey(keyCode, modifiers = []) {
  await windowRef.webContents.executeJavaScript(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: ${modifiers.includes("control")},
    key: ${JSON.stringify(keyCode)},
    metaKey: ${modifiers.includes("meta")},
    shiftKey: ${modifiers.includes("shift")}
  }))`);
  await wait(60);
}

async function pressNativeKey(keyCode, modifiers = []) {
  windowRef.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  windowRef.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await wait(60);
}

async function startServer() {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (request.method === "PUT" && url.pathname === "/api/workflows/demo") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => json(response, { workflow: { ...workflowFixture(), ...JSON.parse(body) } }));
        return;
      }
      routeApi(url.pathname, response);
      return;
    }

    const requestedPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.resolve(distRoot, requestedPath);
    if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(404).end();
        return;
      }
      const contentTypes = {
        ".css": "text/css",
        ".html": "text/html",
        ".js": "text/javascript",
        ".svg": "image/svg+xml",
      };
      response.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      });
      response.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}/`;
}

function routeApi(pathname, response) {
  if (pathname === "/api/workflows") {
    json(response, {
      dataDir: "/workspace",
      promptAgentIds: [],
      workflows: [workflowFixture(), radishWorkflowFixture()],
    });
    return;
  }
  if (pathname === "/api/provider/capabilities") {
    json(response, {
      providers: [{
        id: "codex",
        displayName: "Codex",
        available: true,
        discoveryStatus: "ready",
        defaultModel: "gpt-5.6-sol",
        models: [{
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          defaultEffort: "medium",
          efforts: [
            { id: "low", displayName: "Low" },
            { id: "medium", displayName: "Medium" },
            { id: "high", displayName: "High" },
            { id: "xhigh", displayName: "X-high" },
          ],
        }, {
          id: "gpt-5.6-luna",
          displayName: "GPT-5.6-Luna",
          defaultEffort: "medium",
          efforts: [
            { id: "low", displayName: "Low" },
            { id: "medium", displayName: "Medium" },
            { id: "high", displayName: "High" },
            { id: "xhigh", displayName: "X-high" },
            { id: "max", displayName: "Max" },
          ],
        }],
      }, {
        id: "claude_code",
        displayName: "Claude Code",
        available: true,
        discoveryStatus: "ready",
        defaultModel: "claude-sonnet-5",
        models: [{
          id: "claude-sonnet-5",
          displayName: "Claude Sonnet 5",
          defaultEffort: "high",
          efforts: [
            { id: "low", displayName: "Low" },
            { id: "medium", displayName: "Medium" },
            { id: "high", displayName: "High" },
            { id: "xhigh", displayName: "X-high" },
            { id: "max", displayName: "Max" },
          ],
        }, {
          id: "default",
          displayName: "Default",
          defaultEffort: null,
          efforts: [
            { id: "low", displayName: "Low" },
            { id: "medium", displayName: "Medium" },
            { id: "high", displayName: "High" },
            { id: "xhigh", displayName: "X-high" },
            { id: "max", displayName: "Max" },
          ],
        }],
      }],
    });
    return;
  }
  if (pathname === "/api/workflow-templates") {
    json(response, { templates: [] });
    return;
  }
  if (pathname === "/api/workflows/radish-editor/document") {
    json(response, { document: radishDocumentFixture() });
    return;
  }
  if (pathname === "/api/workflows/radish-editor/document/analyze") {
    json(response, { document: radishDocumentFixture() });
    return;
  }
  if (pathname === "/api/workflows/radish-editor/document/save") {
    json(response, { document: radishDocumentFixture() });
    return;
  }
  if (pathname === "/api/workflows/radish-editor/plan") {
    json(response, {
      plan: {
        blockingDiagnostics: [],
        destructiveActions: ["prepare: command"],
        generations: [{
          index: 0,
          nodes: [{ id: "prepare", detail: "echo ready", sideEffects: ["command"], type: "bash-command" }],
        }],
        kind: "radish",
        providerRequirements: [],
        requiredSecrets: [],
        runnable: true,
        warnings: [],
      },
    });
    return;
  }
  if (pathname === "/api/workflows/radish-editor/run") {
    json(response, {
      run: {
        logPath: "/workspace/radish/run.json",
        logText: "prepare: ready",
        nodeOutputs: { prepare: { data: { stdout: "ready" }, output: "ready", success: true } },
        runEvents: [],
        runNodes: { prepare: { status: "success" } },
        status: "success",
        success: true,
        workflowId: "radish-editor",
      },
    });
    return;
  }
  if (pathname.endsWith("/logs")) {
    json(response, { runs: [] });
    return;
  }
  if (pathname.endsWith("/approvals")) {
    json(response, { approvals: [] });
    return;
  }
  if (pathname === "/api/doctor") {
    json(response, { errors: [], warnings: [] });
    return;
  }
  json(response, {});
}

function workflowFixture() {
  return {
    agents: {},
    edges: [],
    id: "demo",
    name: "Demo workflow",
    nodes: [
      {
        id: "step",
        label: "Run command",
        operation: { command: "echo hello", type: "bash_command", working_dir: "" },
        type: "bash_command",
        x: 80,
        y: 80,
      },
      {
        id: "review",
        label: "Review output",
        operation: { agent_id: "reviewer", prompt: "Review", type: "agent" },
        type: "agent",
        x: 400,
        y: 80,
      },
    ],
    parameters: {},
    sourcePath: "/workspace/demo.toml",
    status: "Ready",
    tags: ["ready"],
  };
}

function radishWorkflowFixture() {
  return {
    agents: {},
    edges: [],
    id: "radish-editor",
    name: "Radish editor",
    nodes: [],
    parameters: {},
    projectName: "gofer-flow",
    projectRoot: "/workspace/gofer-flow",
    readOnly: true,
    sourceFormat: "radish",
    sourcePath: "/workspace/gofer-flow/.taskurotta/radish-editor/workflow.rad",
    status: "Ready",
    tags: ["ready"],
    workflowRoot: "/workspace/gofer-flow/.taskurotta/radish-editor",
  };
}

function radishDocumentFixture() {
  const source = "Radish: 1\n\nWorkflow:\n  name: Radish editor\n\nNode prepare:\n  type: bash-command\n  command: echo ready\n";
  return {
    compilation: { fingerprint: "sha256:test", irVersion: 1, lastValidFingerprint: "sha256:test", state: "valid" },
    diagnostics: [],
    dirty: false,
    graph: {
      edges: [],
      nodes: [{
        configuration: { command: "echo ready" },
        diagnostics: [],
        execution: { allow_fail: false, max_concurrency: 1, retry_count: 0, retry_delay_ms: 0, timeout_ms: null },
        id: "prepare",
        label: "Prepare",
        status: "valid",
        type: "bash-command",
      }],
    },
    invalidRegions: [],
    metadata: { metadataVersion: 1, canvas: { nodes: {}, pan: { x: 0, y: 0 }, zoom: 1 }, editor: { foldedDeclarations: [] } },
    metadataRevision: "sha256:metadata",
    preflight: { diagnostics: [], ready: true },
    projectRoot: "/workspace/gofer-flow",
    runnable: true,
    savedRevision: "sha256:source",
    source,
    sourcePath: "/workspace/gofer-flow/.taskurotta/radish-editor/workflow.rad",
    sourceRevision: "sha256:source",
    workflow: { name: "Radish editor" },
    workflowId: "radish-editor",
  };
}

function json(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function evaluate(callback) {
  const result = await windowRef.webContents.executeJavaScript(`(() => {
    try {
      return { value: (${callback.toString()})() };
    } catch (error) {
      return { error: String(error?.stack || error) };
    }
  })()`);
  if (result?.error) throw new Error(result.error);
  return result?.value;
}

async function waitFor(predicate, delay = 25, description = "browser condition") {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(delay);
  }
  const pageState = await evaluate(() => ({
    focusedElement: document.activeElement?.outerHTML.slice(0, 1000),
    tabs: [...document.querySelectorAll("[role='tab']")].map((tab) => ({
      label: tab.textContent.trim(),
      selected: tab.getAttribute("aria-selected"),
      disabled: tab.disabled,
    })),
    text: document.body.textContent.slice(-10000),
    editor: [...document.querySelectorAll(".monaco-editor")].map((editor) => ({
      width: editor.clientWidth,
      height: editor.clientHeight,
      text: editor.textContent,
    })),
    bridgeCalls: window.__goferBridgeCalls,
  }));
  throw new Error(`Timed out waiting for ${description}.\nPredicate: ${predicate}\nPage: ${JSON.stringify(pageState, null, 2)}`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cleanup(exitCode) {
  if (windowRef && !windowRef.isDestroyed()) windowRef.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  app.exit(exitCode);
}

async function fail(error) {
  clearTimeout(timeout);
  console.error(error);
  await cleanup(1);
}

async function exerciseSourceControl() {
  await evaluate(() => {
    window.goferDesktop.workspace.gitStatus = async () => ({ active: true, branch: "main", branches: ["main", "feature"], remotes: [], entries: Array.from({ length: 24 }, (_, i) => ({ path: `frontend/src/components/Example${i}.jsx`, status: "M", staged: i === 0, unstaged: i !== 0 })) });
    window.goferDesktop.workspace.gitHistory = async () => ({ active: true, commits: [] });
    window.goferDesktop.workspace.gitWorktrees = async () => ({ active: true, worktrees: [{ path: "/repo", branch: "main" }] });
    document.querySelector("[aria-label='Refresh source control']").click();
    document.querySelector("#sidebar-tab-source-control").click();
  });
  await waitFor(() => evaluate(() => Boolean(document.querySelector(".scm-composer"))));
  for (const dark of [false, true]) {
    await windowRef.webContents.executeJavaScript(`document.documentElement.classList.toggle("dark", ${dark})`);
    const bounds = await evaluate(() => {
      const panel = document.querySelector(".scm-panel");
      const content = document.querySelector("#scm-content");
      const composer = document.querySelector(".scm-composer");
      const before = composer.getBoundingClientRect().top;
      content.scrollTop = content.scrollHeight;
      return { width: panel.clientWidth, overflow: panel.scrollWidth > panel.clientWidth, scrolls: content.scrollHeight > content.clientHeight, fixed: composer.getBoundingClientRect().top === before, bottom: composer.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1 };
    });
    assert.equal(bounds.overflow, false, JSON.stringify(bounds));
    assert.equal(bounds.scrolls, true);
    assert.equal(bounds.fixed, true);
    assert.equal(bounds.bottom, true);
    await evaluate(() => { document.querySelector("#scm-content").scrollTop = 0; });
    const beforeHover = await evaluate(() => {
      const row = document.querySelector(".scm-file");
      const buttons = [...row.querySelectorAll("button")].slice(1);
      const bounds = buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, display: getComputedStyle(button).display };
      });
      return bounds;
    });
    assert.equal(beforeHover.length, 2);
    assert.ok(beforeHover.every((button) => button.width > 0 && button.display !== "none"));
    windowRef.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(beforeHover[0].x + 14), y: Math.round(beforeHover[0].y + 14) });
    await wait(50);
    const afterHover = await evaluate(() => [...document.querySelector(".scm-file").querySelectorAll("button")].slice(1).map((button) => button.getBoundingClientRect().x));
    assert.deepEqual(afterHover, beforeHover.map((button) => button.x), "Git action buttons must stay in place on hover");
    const screenshot = await windowRef.webContents.capturePage();
    fs.writeFileSync(`/tmp/taskurotta-source-control-${dark ? "dark" : "light"}.png`, screenshot.toPNG());
  }
  await evaluate(() => document.querySelector("#scm-tab-worktrees").click());
  for (const dark of [false, true]) {
    windowRef.webContents.sendInputEvent({ type: "mouseMove", x: 10, y: 10 });
    await wait(50);
    await windowRef.webContents.executeJavaScript(`document.documentElement.classList.toggle("dark", ${dark})`);
    await evaluate(() => document.querySelector('[aria-label="Integrate main worktree"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 240 })));
    await waitFor(() => evaluate(() => document.activeElement?.dataset.operation === "merge"), 25, "initial worktree menu focus");
    assert.deepEqual(await evaluate(() => [...document.querySelectorAll("[data-operation]")].map((item) => item.dataset.operation)),
      ["merge", "squash", "ff-only", "no-ff", "rebase"]);
    const merge = await evaluate(() => {
      const item = document.querySelector('[data-operation="merge"]');
      const style = getComputedStyle(item);
      const activeColor = style.getPropertyValue("--color-menu-active").trim().split(/\s+/).join(", ");
      return { background: style.backgroundColor, expectedBackground: `rgb(${activeColor})`, outline: style.outlineStyle };
    });
    assert.equal(merge.background, merge.expectedBackground, "Focused menu item must use the theme's active color");
    assert.equal(merge.outline, "none", "Opening a context menu with the pointer should not paint a keyboard outline");
    const rebaseBounds = await evaluate(() => {
      const rect = document.querySelector('[data-operation="rebase"]').getBoundingClientRect();
      return { x: Math.round(rect.x + 30), y: Math.round(rect.y + 15) };
    });
    windowRef.webContents.sendInputEvent({ type: "mouseMove", ...rebaseBounds });
    await waitFor(() => evaluate(() => document.activeElement?.dataset.operation === "rebase"));
    assert.equal(await evaluate(() => document.querySelector('[data-operation="merge"]').hasAttribute("aria-haspopup")), false);
    await pressNativeKey("Up");
    await waitFor(() => evaluate(() => document.activeElement?.dataset.operation === "no-ff"));
    await pressNativeKey("Home");
    await waitFor(() => evaluate(() => document.activeElement?.dataset.operation === "merge"));
    assert.equal(await evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "solid");
    fs.writeFileSync(`/tmp/taskurotta-worktree-menu-${dark ? "dark" : "light"}.png`, (await windowRef.webContents.capturePage()).toPNG());
    windowRef.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor(() => evaluate(() => !document.querySelector('[data-operation="merge"]')));
  }
  await evaluate(() => document.querySelector("#scm-tab-history").click());
  assert.equal(await evaluate(() => Boolean(document.querySelector(".scm-composer"))), false);
  assert.equal(await evaluate(() => document.querySelector("#scm-content").textContent.includes("No commits yet.")), true);
}
