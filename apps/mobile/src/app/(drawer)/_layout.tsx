// D383 Stage 2 — left Drawer wrapping the bottom tabs.
// `drawerType: "front"` = slides over content with a dimming scrim (per §3.5:
// button- + edge-swipe-triggered, over a scrim — NOT an always-on rail).
// Tabs keep their own AppBar (headerShown: false here). The ☰ affordance in
// the tab AppBar opens this drawer; edge-swipe opens it for free.
import { Drawer } from "expo-router/drawer";

import { DrawerContent } from "@/components/drawer-content";

export default function DrawerLayout() {
  return (
    <Drawer
      screenOptions={{ headerShown: false, drawerType: "front" }}
      drawerContent={(props) => <DrawerContent {...props} />}
    >
      <Drawer.Screen name="(tabs)" />
      <Drawer.Screen name="computers" />
      <Drawer.Screen name="scheduled-work" />
    </Drawer>
  );
}
