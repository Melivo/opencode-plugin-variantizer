import { writeFileSync } from "node:fs";

const evidencePath = process.env.MODEL_TUI_CONTRACT_EVIDENCE_PATH;
const command = process.env.MODEL_TUI_CONTRACT_COMMAND;
const invalidPayload = process.env.MODEL_TUI_CONTRACT_INVALID_PAYLOAD === "true";

function persist(value) {
  if (!evidencePath) throw new Error("MODEL_TUI_CONTRACT_EVIDENCE_PATH is required");
  writeFileSync(evidencePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export const ModelTuiContractFixturePlugin = async ({ client }) => {
  setTimeout(async () => {
    try {
      const body = invalidPayload
        ? { type: "tui.command.execute", properties: {} }
        : { type: "tui.command.execute", properties: { command } };
      const response = await client.tui.publish({ body });
      persist({
        attemptedCommand: command ?? null,
        invalidPayload,
        data: response.data ?? null,
        errorDetected: response.error !== undefined,
        errorName: response.error?.name ?? null,
      });
    } catch (error) {
      persist({
        attemptedCommand: command ?? null,
        invalidPayload,
        data: null,
        errorDetected: true,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }, 1_500);

  return {};
};
