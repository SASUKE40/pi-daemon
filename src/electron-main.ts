import { app, dialog, Menu, nativeImage, Tray } from "electron";
import { hasRequiredMacOSPermissions, openMacOSScreenRecordingSettings, requestMacOSPermissions } from "@trycua/cua-driver/electron";
import { join } from "node:path";
import { startSessionDaemon, type SessionDaemonHandle } from "./sessiond.js";
import { log } from "./log.js";

let daemon: SessionDaemonHandle | undefined;
let tray: any;
let permissionReady = false;

if (!app.requestSingleInstanceLock()) app.quit();

app.on("second-instance", () => void showPermissionStatus());
app.on("window-all-closed", (event: Event) => event.preventDefault());
app.on("before-quit", () => void daemon?.close());

void app.whenReady().then(async () => {
  app.dock?.hide();
  createTray();
  await showPermissionStatus(true);
  daemon = await startSessionDaemon();
  refreshMenu();
}).catch((error: unknown) => {
  log.error("macOS host failed", { message: error instanceof Error ? error.message : String(error) });
  void dialog.showErrorBox("Pi Daemon failed", error instanceof Error ? error.message : String(error));
  app.quit();
});

function createTray(): void {
  const iconPath = join(app.getAppPath(), "public", "icon.svg");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Pi Daemon");
  refreshMenu();
}

function refreshMenu(): void {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: daemon ? "Session daemon running" : "Session daemon starting…", enabled: false },
    { label: permissionReady ? "Computer Use permissions ready" : "Computer Use permissions need attention", enabled: false },
    { type: "separator" },
    { label: "Check permissions…", click: () => void showPermissionStatus(true) },
    { label: "Quit Pi Daemon", click: () => app.quit() },
  ]));
}

async function showPermissionStatus(interactive = false): Promise<void> {
  const status = requestMacOSPermissions();
  permissionReady = hasRequiredMacOSPermissions(status);
  refreshMenu();
  if (!interactive || permissionReady) return;
  if (!status.screenRecording) await openMacOSScreenRecordingSettings();
  await dialog.showMessageBox({
    type: "info",
    title: "Pi Daemon permissions",
    message: "Allow Pi Daemon in Accessibility and Screen Recording",
    detail: "After enabling both permissions in System Settings, quit and reopen Pi Daemon so macOS applies the grants.",
    buttons: ["OK"],
  });
}
