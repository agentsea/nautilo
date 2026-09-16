import { expect, test } from "bun:test";
import { nativeSaveFailureCopy } from "./artifact-save-feedback";

test("cancel and failed-copy residuals explicitly warn that a destination file may remain", () => {
  expect(nativeSaveFailureCopy({ code: "ERR_EXPORT_CANCELLED_RESIDUAL" })).toContain("partial file may remain");
  expect(nativeSaveFailureCopy({ code: "ERR_EXPORT_WRITE_RESIDUAL" })).toContain("partial file may remain");
});
test("native busy and interruption never become success or generic connectivity errors", () => {
  expect(nativeSaveFailureCopy({ code: "ERR_EXPORT_BUSY" })).toContain("still being saved");
  expect(nativeSaveFailureCopy({ code: "ERR_EXPORT_INTERRUPTED" })).toContain("Check the selected destination");
});
test("temporary-source cleanup failure discloses the residual app copy without promising recovery", () => {
  const message = nativeSaveFailureCopy({ code: "ERR_EXPORT_TEMP_CLEANUP" });
  expect(message).toContain("temporary app copy could not be removed");
  expect(message).not.toContain("restart");
});
test("native cache residual outcomes distinguish saved, cancelled, and not saved", () => {
  expect(nativeSaveFailureCopy({ code: "ERR_EXPORT_SAVED_RESIDUAL" })).toStartWith("Saved,");
  expect(nativeSaveFailureCopy({ code: "ERR_EXPORT_CANCELLED_CACHE_RESIDUAL" })).toStartWith("Save was cancelled,");
  expect(nativeSaveFailureCopy({ code: "ERR_EXPORT_CACHE_CLEANUP" })).toStartWith("The file was not saved,");
});
test("unknown provider errors cannot expose their content", () => {
  const message = nativeSaveFailureCopy({ code: "UNKNOWN", message: "private/path?token=secret" });
  expect(message).not.toContain("private"); expect(message).not.toContain("secret");
});
test("invalid media and denied library access keep the original-file fallback without claiming storage failure", () => {
  expect(nativeSaveFailureCopy({ code: "ERR_MEDIA_INVALID" })).toContain("not a valid photo or video");
  expect(nativeSaveFailureCopy({ code: "ERR_MEDIA_INVALID" })).toContain("Use Save file");
  expect(nativeSaveFailureCopy({ code: "ERR_MEDIA_PERMISSION" })).toContain("not granted");
  expect(nativeSaveFailureCopy({ code: "ERR_MEDIA_SAVE_RESIDUAL" })).toContain("partial item");
});
