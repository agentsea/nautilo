import { contextBridge, ipcRenderer } from "electron";
import type { CompanionWindowAPI, CompanionWindowState } from "./companion-contract";
const bridge: CompanionWindowAPI = {
  getState: () => ipcRenderer.invoke("companion:state"),
  command: (generation, action) => ipcRenderer.invoke("companion:command", generation, action),
  subscribe: callback => {
    const listener = (_event: unknown, state: CompanionWindowState) => callback(state);
    ipcRenderer.on("companion:changed", listener);
    return () => ipcRenderer.removeListener("companion:changed", listener);
  },
};
contextBridge.exposeInMainWorld("nautiloCompanion", bridge);
