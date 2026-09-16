import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from "react-native";

import { EMPTY_TASK_WORK_STATUS_ANNOUNCEMENT, reduceTaskWorkStatusAnnouncement } from "./task-work-status-announcement";
import type { TaskWorkViewState } from "./task-work-state";

/** Non-focusable status-only live region for material Task lifecycle changes. */
export function TaskWorkStatusAnnouncer({ scopeKey, view }: { readonly scopeKey: string | null; readonly view: TaskWorkViewState }) {
  const previousRef = useRef(EMPTY_TASK_WORK_STATUS_ANNOUNCEMENT);
  const [webAnnouncement, setWebAnnouncement] = useState<string | null>(null);
  useEffect(() => {
    const outcome = reduceTaskWorkStatusAnnouncement({ previous: previousRef.current, scopeKey, view });
    previousRef.current = outcome.state;
    if (!outcome.announcement) {
      setWebAnnouncement(null);
      return;
    }
    if (Platform.OS === "web") {
      setWebAnnouncement(outcome.announcement);
      return;
    }
    AccessibilityInfo.announceForAccessibility(outcome.announcement);
  }, [scopeKey, view]);
  return Platform.OS === "web" && webAnnouncement ? <View style={styles.hidden} {...({ role: "status", "aria-live": "polite" } as unknown as Record<string, unknown>)}><Text>{webAnnouncement}</Text></View> : null;
}

const styles = StyleSheet.create({ hidden: { position: "absolute", width: 1, height: 1, left: -10_000, overflow: "hidden" } });
