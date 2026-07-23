import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aionis-v1-test-daemon-tokens-"));
chmodSync(root, 0o700);
let sequence = 0;
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

export function daemonTokenFileEnvironment(
  hostToken: string,
  operatorToken: string,
): Readonly<Record<string, string>> {
  const suffix = sequence++;
  const hostPath = join(root, `host-${suffix}.token`);
  const operatorPath = join(root, `operator-${suffix}.token`);
  writeFileSync(hostPath, hostToken, { mode: 0o600 });
  writeFileSync(operatorPath, operatorToken, { mode: 0o600 });
  chmodSync(hostPath, 0o600);
  chmodSync(operatorPath, 0o600);
  return Object.freeze({
    AIONIS_HOST_API_KEY_FILE: hostPath,
    AIONIS_OPERATOR_API_KEY_FILE: operatorPath,
  });
}
