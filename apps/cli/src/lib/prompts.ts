import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

export async function readLine(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input, output });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on("error", reject);
  });
}
