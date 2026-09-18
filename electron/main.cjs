const { app, BrowserWindow, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const pkg = require("../package.json");

/* Self-contained builds (see package.json's "portableMode", injected at build
   time via electron-builder's extraMetadata) keep all data next to the exe
   instead of the per-user AppData profile, so the app is truly USB-portable.
   electron-builder's NSIS "portable" launcher actually runs from a temp
   extraction, not the exe's own folder, which is why this uses
   PORTABLE_EXECUTABLE_DIR (the launcher-provided path to the real exe)
   rather than process.execPath. Must run before app.whenReady(). */
if (pkg.portableMode === "self-contained") {
  const baseDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const dataDir = path.join(baseDir, "Bill Tracker Data");
  fs.mkdirSync(dataDir, { recursive: true });
  app.setPath("userData", dataDir);
}

const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: "Bill Tracker",
    backgroundColor: "#15171C",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
