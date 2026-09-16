import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { ConversionWarningDialog } from "./conversion-warning-dialog";

describe("ConversionWarningDialog", () => {
  beforeEach(() => reapplyHappyDomGlobals());

  test("shows every warning and confirms explicitly", () => {
    const onConfirm = mock(() => undefined);
    const onCancel = mock(() => undefined);
    const warnings = ["First warning", "Second warning\nwith detail"];
    const view = render(
      <ConversionWarningDialog warnings={warnings} onConfirm={onConfirm} onCancel={onCancel} />,
    );

    expect(view.getByText("First warning")).toBeTruthy();
    expect(view.getByText(/Second warning/)).toBeTruthy();
    const confirm = view.getByTestId("conversion-warning-confirm") as HTMLButtonElement;
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(view.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(view.getByText("Cancel"));
    fireEvent.keyDown(view.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    view.unmount();
  });

  test("Escape cancels", () => {
    const escaped = mock(() => undefined);
    const first = render(
      <ConversionWarningDialog warnings={["warning"]} onConfirm={() => undefined} onCancel={escaped} />,
    );
    fireEvent.keyDown(first.getByRole("dialog"), { key: "Escape" });
    expect(escaped).toHaveBeenCalledTimes(1);
    first.unmount();
    expect(escaped).toHaveBeenCalledTimes(1);
  });

  test("validates the filename and confirms saving beside the original", () => {
    const onConfirm = mock(() => undefined);
    const invalid = render(
      <ConversionWarningDialog
        warnings={["Font substituted"]}
        workspaceDestination={{ filename: "deck:copy.pdf", extension: ".pdf", initialLocation: "current" }}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    expect((invalid.getByTestId("conversion-warning-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(invalid.getByRole("alert").textContent).toContain(".pdf");
    invalid.unmount();

    const view = render(
      <ConversionWarningDialog
        warnings={["Font substituted"]}
        workspaceDestination={{ filename: "Renamed.PDF", extension: ".pdf", initialLocation: "source" }}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    const location = view.getByLabelText("Save in") as HTMLSelectElement;
    const confirm = view.getByTestId("conversion-warning-confirm") as HTMLButtonElement;
    expect((view.getByLabelText("File name") as HTMLInputElement).value).toBe("Renamed.PDF");
    expect(location.value).toBe("source");
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ filename: "Renamed.PDF", workspaceDestination: "source" });
  });
});
