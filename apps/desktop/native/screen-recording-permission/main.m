// D516 — one-purpose macOS Screen Recording permission request.
//
// This program is intentionally a direct child of Nautilo's Electron main
// process. In Cua 0.19.3 embedded mode, ordinary child processes remain in
// the spawning app's TCC responsibility chain, so the consent belongs to the
// signed Nautilo host rather than a standalone driver identity. The helper
// accepts no renderer input and has exactly one side-effecting command.

#import <CoreGraphics/CoreGraphics.h>
#import <stdbool.h>
#import <stdio.h>
#import <string.h>

static int usage(void) {
  fputs("usage: nautilo-screen-recording-permission --request\n", stderr);
  return 64;
}

int main(int argc, const char *argv[]) {
  if (argc != 2 || strcmp(argv[1], "--request") != 0) {
    return usage();
  }

  // This is the documented prompt-capable CoreGraphics API. Do not replace it
  // with desktop capture: a capture attempt is not a truthful permission UI.
  const bool granted = CGRequestScreenCaptureAccess();
  fputs(granted ? "{\"screenRecording\":true}\n" : "{\"screenRecording\":false}\n", stdout);
  return 0;
}
