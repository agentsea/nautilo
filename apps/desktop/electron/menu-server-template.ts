/**
 * Native Server menu shape. Kept Electron-free so the unauthenticated
 * server-switch escape can be covered by ordinary unit tests.
 */
export interface ServerMenuItemTemplate {
  label: string;
  accelerator?: string;
  click: () => void;
}

export function buildServerSubmenu(
  onSwitchServer: () => void | Promise<void>,
): ServerMenuItemTemplate[] {
  return [
    {
      label: "Switch Server…",
      accelerator: "CmdOrCtrl+Shift+S",
      click: () => {
        void onSwitchServer();
      },
    },
  ];
}
