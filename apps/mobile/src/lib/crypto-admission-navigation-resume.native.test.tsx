import { expect, test } from "bun:test";

import {
  captureCryptoAdmissionNavigationResume,
  CryptoAdmissionNavigationResume,
} from "./crypto-admission-navigation-resume.tsx";

test("native admission resume is inert", () => {
  expect(captureCryptoAdmissionNavigationResume("scope-a")).toBeNull();
  expect(CryptoAdmissionNavigationResume({ ready: true })).toBeNull();
});
