import { contextBridge, ipcRenderer } from "electron";
import type { LabBridge, LabState } from "./contract";

const bridge: LabBridge = {
  getState: () => ipcRenderer.invoke("genie-lab:state"),
  command: command => ipcRenderer.send("genie-lab:command", command),
  subscribe: callback => {
    const listener = (_event: unknown, state: LabState) => callback(state);
    ipcRenderer.on("genie-lab:changed", listener);
    return () => ipcRenderer.removeListener("genie-lab:changed", listener);
  },
};
contextBridge.exposeInMainWorld("genieLab", bridge);
