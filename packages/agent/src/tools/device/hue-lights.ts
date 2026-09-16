import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const hueLightsSchema = z
  .object({
    action: z.enum([
      "discover",
      "setup",
      "list_lights",
      "list_rooms",
      "list_scenes",
      "set_light",
      "set_room",
      "activate_scene",
    ]),
    bridge: z.string().min(1).optional(),
    devicetype: z.string().min(1).optional(),
    room: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    on: z.boolean().optional(),
    brightness: z.number().min(0).max(100).optional(),
    temperature: z.number().int().min(153).max(500).optional(),
    rgb: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]).optional(),
    transitionTime: z.number().nonnegative().describe("Transition duration in milliseconds.").optional(),
    dynamic: z.boolean().optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    const permitted: Record<typeof args.action, readonly string[]> = {
      discover: [],
      setup: ["bridge", "devicetype"],
      list_lights: ["room"],
      list_rooms: [],
      list_scenes: ["room"],
      set_light: ["name", "on", "brightness", "temperature", "rgb", "transitionTime"],
      set_room: ["name", "on", "brightness", "temperature", "rgb", "transitionTime"],
      activate_scene: ["name", "room", "dynamic"],
    };
    const supplied = Object.entries(args)
      .filter(([key, value]) => key !== "action" && value !== undefined)
      .map(([key]) => key);
    const invalid = supplied.filter((key) => !permitted[args.action].includes(key));
    if (invalid.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${args.action} does not accept: ${invalid.join(", ")}`,
      });
    }

    if ((args.action === "set_light" || args.action === "set_room") && !args.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${args.action} requires name`,
        path: ["name"],
      });
    }
    if ((args.action === "set_light" || args.action === "set_room") && args.on === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${args.action} requires on`,
        path: ["on"],
      });
    }
    if (args.action === "activate_scene" && !args.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "activate_scene requires name",
        path: ["name"],
      });
    }
  });

/**
 * Typed Hue request contract dispatched to a relay-local OpenHue adapter.
 *
 * No process, shell, or network operation is performed here: the relay maps
 * these bounded JSON actions to its allowlisted OpenHue argv builder.
 */
export function createHueLightsTool() {
  return new DynamicStructuredTool({
    name: "hue_lights",
    description:
      "Control Philips Hue lights through a connected local relay. Use discover to find a Bridge, setup to pair it (optionally naming bridge and device type), list_lights/list_rooms/list_scenes to inspect Hue resources, set_light/set_room to set on state, brightness (0–100), temperature (153–500 mirek), RGB, or transition time, and activate_scene to start a named scene. Treat saved bridge addresses as hints, not permanent identity. If lights are missing, the bridge is unreachable, an API call returns 404 or wrong API key, or setup is missing, actively search again with discover; do not simply say you cannot see the lights or send the user to hunt for an IP. Use fresh bridge candidates already returned by a failed operation instead of repeating the same search. Prefer a discovered stable .local bridge hostname for setup so DHCP address changes do not break it again. If several bridges are found, ask which one; never silently pick another bridge or copy credentials between bridges. Run setup with the selected discovered bridge when pairing needs repair, then list_lights to verify before claiming success. Before calling setup, tell the user that pairing is starting and to press the physical Bridge button when the pairing card appears. Setup blocks while waiting for the button, so do not wait for the tool result to give this instruction. If setup times out or the connection is lost, pairing may still have completed: run list_lights to observe the actual state before deciding whether another setup attempt is needed. Never blindly replay a failed lighting change: inspect current state first. Only if fresh discovery still finds nothing, explain the local-network or power problem, offer another discovery attempt after it is resolved, and ask for the bridge address from the Hue app as a last resort. Discovery failure is not evidence of rate limiting. This tool is relay-only; never pass shell commands, URLs, bridge API keys, or raw OpenHue options.",
    schema: hueLightsSchema,
    func: () =>
      Promise.reject(
        new Error(
          "hue_lights is a relay tool — execution goes through the relay protocol, not direct invocation. If you see this error, the tool routing in toolsNode is broken.",
        ),
      ),
  });
}
