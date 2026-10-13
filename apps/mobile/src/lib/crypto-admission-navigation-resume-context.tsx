import { createContext, useContext, type ReactNode } from "react";

import type { CryptoAdmissionNavigationResumeIntent } from "./crypto-admission-navigation-resume-contract";

export type CryptoAdmissionNavigationResumeBinding = Readonly<{
  admissionKey: string;
  intent: CryptoAdmissionNavigationResumeIntent;
  onConsumed(intent: CryptoAdmissionNavigationResumeIntent): void;
}>;

const CryptoAdmissionNavigationResumeContext =
  createContext<CryptoAdmissionNavigationResumeBinding | null>(null);

export function CryptoAdmissionNavigationResumeProvider({
  binding,
  children,
}: Readonly<{
  binding: CryptoAdmissionNavigationResumeBinding | null;
  children: ReactNode;
}>) {
  return (
    <CryptoAdmissionNavigationResumeContext value={binding}>
      {children}
    </CryptoAdmissionNavigationResumeContext>
  );
}

export function useCryptoAdmissionNavigationResume(): CryptoAdmissionNavigationResumeBinding | null {
  return useContext(CryptoAdmissionNavigationResumeContext);
}
