#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <limits.h>
#import <stdlib.h>
#import <stdio.h>

// Read-only presence of one exact host-owned window. No titles, pixels,
// accessibility access, permission prompts or window activation.
int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 3) return 64;
    char *end = NULL;
    unsigned long owner = strtoul(argv[1], &end, 10);
    if (!argv[1][0] || *end || owner == 0 || owner > INT_MAX) return 64;
    unsigned long target = strtoul(argv[2], &end, 10);
    if (!argv[2][0] || *end || target == 0 || target > UINT_MAX) return 64;
    pid_t foreground = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (!list) return 1;
    BOOL present = NO, otherAppPresent = NO;
    for (NSDictionary *info in (__bridge NSArray *)list) {
      pid_t pid = [info[(__bridge NSString *)kCGWindowOwnerPID] intValue];
      CGWindowID number = [info[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
      if (pid == (pid_t)owner && number == (CGWindowID)target) present = YES;
      // Preserve the companion when the Human is using another app, including
      // a normal window on a second display. Menu-bar windows do not count.
      if (foreground != (pid_t)owner && pid == foreground &&
          [info[(__bridge NSString *)kCGWindowLayer] intValue] == 0 &&
          [info[(__bridge NSString *)kCGWindowAlpha] doubleValue] > 0) {
        CGRect bounds;
        if (CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(__bridge NSString *)kCGWindowBounds], &bounds) && !CGRectIsEmpty(bounds)) otherAppPresent = YES;
      }
    }
    CFRelease(list);
    puts(present && !otherAppPresent ? "visible" : "away");
    return 0;
  }
}
